use anyhow::{Context, Result};
use std::time::Duration;

use crate::app::{FeatureSelection, InstallConfig};
use crate::cli::{Cli, UpdateArgs};
use crate::cmd_install;
use crate::health;
use crate::k8s;
use crate::manifest::ReleaseManifest;
use crate::meta::{self, DeployMeta};
use crate::templates::{self, render as render_template};

/// Entry point for the `update` subcommand.
pub async fn run(cli: &Cli, args: &UpdateArgs) -> Result<()> {
    println!("Baker Street Update v{}", env!("CARGO_PKG_VERSION"));

    // ── Step 1: Preflight ──
    println!("[1/8] Preflight...");
    let client = kube::Client::try_default().await
        .context("K8s cluster not reachable")?;
    let ns = &cli.namespace;

    let manifest = if let Some(ref path) = cli.manifest {
        crate::manifest::load_manifest_from_file(path)?
    } else {
        crate::manifest::embedded_manifest()?
    };

    let existing_meta = meta::read_meta(&client, ns).await?;
    let current_meta = match existing_meta {
        Some(m) => {
            println!("  Deployed version: {}", m.version);
            println!("  Active slot: {}", m.active_slot);
            m
        }
        None => {
            // No meta — try to infer from existing deployments
            println!("  No deploy metadata found. Probing deployments...");
            let statuses = k8s::get_deployments_status(&client, ns).await?;
            if statuses.is_empty() {
                anyhow::bail!("No Baker Street deployment found in namespace '{}'. Use 'install' first.", ns);
            }
            // Infer active slot from service selector
            let slot = k8s::get_brain_service_selector(&client, ns).await
                .unwrap_or_else(|_| "blue".into());
            println!("  Inferred active slot: {}", slot);
            DeployMeta {
                version: "unknown".into(),
                active_slot: slot,
                deploy_timestamp: String::new(),
                features: String::new(),
                components: String::new(),
            }
        }
    };

    // Version check
    if current_meta.version == manifest.version && !args.force {
        println!("  Already up to date (v{}). Use --force to re-apply.", manifest.version);
        return Ok(());
    }
    println!("  Updating: {} → {}", current_meta.version, manifest.version);

    // ── Step 2: Preserve Config ──
    println!("[2/8] Preserving configuration...");
    let config = if args.reconfigure {
        println!("  --reconfigure: prompting for new secrets");
        build_config_from_env(ns, &manifest)?
    } else {
        build_config_from_secrets(&client, ns, &manifest, &current_meta).await?
    };
    println!("  Config preserved (agent: {})", config.agent_name());

    // ── Step 3: Re-apply Templates ──
    println!("[3/8] Applying templates...");
    let vars = cmd_install::build_template_vars(ns, &manifest, &config);

    // Update OS ConfigMap
    k8s::create_os_configmap(&client, ns).await?;
    println!("  ConfigMap: bakerst-os");

    // Re-apply secrets if reconfiguring
    if args.reconfigure {
        cmd_install::create_all_secrets(&client, ns, &config, &manifest).await?;
        println!("  Secrets: updated");
    }

    let apply_steps: Vec<(&str, &str)> = vec![
        ("PVCs", templates::PVCS_YAML),
        ("RBAC", templates::RBAC_YAML),
        ("NATS", templates::NATS_YAML),
        ("Qdrant", templates::QDRANT_YAML),
        ("Brain", templates::BRAIN_YAML),
        ("Worker", templates::WORKER_YAML),
        ("Gateway", templates::GATEWAY_YAML),
        ("UI", templates::UI_YAML),
        ("Network Policies", templates::NETWORK_POLICIES_YAML),
    ];

    for (name, template) in &apply_steps {
        if let Some(ref comp) = args.component {
            // Only apply the requested component
            if !name.eq_ignore_ascii_case(comp) {
                continue;
            }
        }
        let rendered = render_template(template, &vars);
        k8s::apply_yaml(&client, ns, &rendered).await?;
        println!("  Applied: {}", name);
    }

    // Extensions
    if !args.skip_extensions {
        apply_extensions(&client, ns, &manifest, &vars).await?;
    }

    // ── Step 4: Compare images — decide what needs updating ──
    println!("[4/8] Comparing running images...");
    let active_slot = &current_meta.active_slot;
    let standby_slot = if active_slot == "blue" { "green" } else { "blue" };

    let mut brain_needs_update = false;
    let mut components_to_restart: Vec<String> = Vec::new();

    for img in &manifest.images {
        // Skip extensions if requested
        if !img.required && args.skip_extensions {
            continue;
        }
        // If --component is set, only check that component
        if let Some(ref comp) = args.component {
            if !img.component.eq_ignore_ascii_case(comp) {
                continue;
            }
        }

        // Brain uses blue/green — map to active slot deployment name
        let deployment_name = if img.component == "brain" {
            format!("brain-{}", active_slot)
        } else {
            img.component.clone()
        };

        let current = k8s::get_deployment_image(&client, ns, &deployment_name).await?;
        let target = &img.image;

        if args.force || current.as_deref() != Some(target.as_str()) {
            println!("  \u{2191} {} ({} \u{2192} {})",
                img.component,
                current.as_deref().unwrap_or("none"),
                target);
            if img.component == "brain" {
                brain_needs_update = true;
            } else {
                components_to_restart.push(img.component.clone());
            }
        } else {
            println!("  \u{2713} {} (up to date)", img.component);
        }
    }

    if !brain_needs_update && components_to_restart.is_empty() && !args.force {
        println!("\nAll components are up to date. Use --force to redeploy anyway.");
    }

    // ── Step 5: Blue/Green Brain Swap (only if brain changed) ──
    let final_slot = if brain_needs_update {
        println!("[5/8] Blue/green brain swap...");
        let standby_deploy = format!("brain-{}", standby_slot);

        println!("  Scaling up {}...", standby_deploy);
        k8s::scale_deployment(&client, ns, &standby_deploy, 1).await?;

        println!("  Waiting for {} to be healthy...", standby_deploy);
        match health::wait_for_rollout(&client, ns, &standby_deploy, Duration::from_secs(120)).await {
            Ok(_) => {
                println!("  {} healthy \u{2014} switching service selector", standby_deploy);
                k8s::patch_brain_service_selector(&client, ns, standby_slot).await?;

                let old_deploy = format!("brain-{}", active_slot);
                println!("  Scaling down {}...", old_deploy);
                k8s::scale_deployment(&client, ns, &old_deploy, 0).await?;
                println!("  Brain swap complete: {} \u{2192} {}", active_slot, standby_slot);
            }
            Err(e) => {
                eprintln!("  {} failed health check: {}", standby_deploy, e);
                eprintln!("  Rolling back \u{2014} scaling down {}", standby_deploy);
                k8s::scale_deployment(&client, ns, &standby_deploy, 0).await?;
                anyhow::bail!("Update aborted: brain standby failed health check");
            }
        }
        standby_slot.to_string()
    } else {
        println!("[5/8] Brain up to date \u{2014} skipping blue/green swap.");
        active_slot.clone()
    };

    // ── Step 6: Rolling Restart Changed Components ──
    println!("[6/8] Rolling restart ({} component(s))...", components_to_restart.len());
    if components_to_restart.is_empty() {
        println!("  No non-brain components to restart.");
    }

    for dep in &components_to_restart {
        match k8s::restart_deployment(&client, ns, dep).await {
            Ok(_) => println!("  Restarted: {}", dep),
            Err(e) => println!("  WARNING: Failed to restart {}: {}", dep, e),
        }
    }

    // Wait for rollouts
    for dep in &components_to_restart {
        match health::wait_for_rollout(&client, ns, dep, Duration::from_secs(120)).await {
            Ok(_) => println!("  {}: ready", dep),
            Err(e) => println!("  {}: FAILED ({})", dep, e),
        }
    }

    // ── Step 7: Write Meta ──
    println!("[7/8] Writing metadata...");
    let features: Vec<String> = config.features.iter()
        .filter(|f| f.enabled)
        .map(|f| f.id.clone())
        .collect();
    let components: Vec<String> = if current_meta.components.is_empty() {
        vec!["brain".into(), "worker".into(), "gateway".into(), "ui".into(), "nats".into(), "qdrant".into()]
    } else {
        current_meta.components.split(',').map(|s| s.to_string()).collect()
    };
    let new_meta = meta::build_meta(&manifest.version, &final_slot, &features, &components);
    meta::write_meta(&client, ns, &new_meta).await?;

    // ── Step 8: Report ──
    println!("[8/8] Update complete!");
    println!("  Version:    {}", manifest.version);
    println!("  Brain Slot: {} (active)", final_slot);
    println!("  UI:         http://localhost:30080");

    Ok(())
}

/// Rebuild InstallConfig from existing K8s secrets (no re-prompting).
async fn build_config_from_secrets(
    client: &kube::Client,
    namespace: &str,
    manifest: &ReleaseManifest,
    current_meta: &DeployMeta,
) -> Result<InstallConfig> {
    let brain_secrets = k8s::read_secret(client, namespace, "bakerst-brain-secrets").await?
        .unwrap_or_default();
    let gateway_secrets = k8s::read_secret(client, namespace, "bakerst-gateway-secrets").await?
        .unwrap_or_default();

    // Rebuild feature selections from meta
    let enabled_features: Vec<&str> = if current_meta.features.is_empty() {
        vec![]
    } else {
        current_meta.features.split(',').collect()
    };

    let mut feature_selections = Vec::new();
    for feature in &manifest.features {
        let enabled = enabled_features.contains(&feature.id.as_str());
        let mut secrets = Vec::new();
        for secret_def in &feature.secrets {
            let val = gateway_secrets.get(&secret_def.key).cloned()
                .or_else(|| read_feature_secret_sync(client, namespace, &secret_def.key));
            secrets.push((secret_def.key.clone(), val));
        }
        feature_selections.push(FeatureSelection {
            id: feature.id.clone(),
            name: feature.name.clone(),
            enabled,
            secrets,
        });
    }

    // Build collected_secrets from brain + gateway secrets
    let mut collected_secrets = std::collections::HashMap::new();
    for (k, v) in &brain_secrets {
        collected_secrets.insert(k.clone(), v.clone());
    }
    // Gateway AUTH_TOKEN as fallback
    if !collected_secrets.contains_key("AUTH_TOKEN") {
        if let Some(v) = gateway_secrets.get("AUTH_TOKEN") {
            collected_secrets.insert("AUTH_TOKEN".into(), v.clone());
        }
    }

    Ok(InstallConfig {
        collected_secrets,
        features: feature_selections,
        namespace: namespace.into(),
    })
}

/// Helper: we can't async in a closure, so just return None for now.
/// Feature secrets in dedicated K8s secrets (github, perplexity) are not
/// critical for template rendering — they'll be preserved as-is since we
/// skip secret recreation unless --reconfigure.
fn read_feature_secret_sync(
    _client: &kube::Client,
    _namespace: &str,
    _key: &str,
) -> Option<String> {
    None
}

/// Build config from environment variables (for --reconfigure).
fn build_config_from_env(namespace: &str, manifest: &ReleaseManifest) -> Result<InstallConfig> {
    // Collect top-level secrets from env
    let mut collected_secrets = std::collections::HashMap::new();
    for secret in &manifest.secrets {
        if let Ok(val) = std::env::var(&secret.key) {
            if !val.is_empty() {
                collected_secrets.insert(secret.key.clone(), val);
            }
        }
    }

    // Auto-generate defaults
    if !collected_secrets.contains_key("AUTH_TOKEN") {
        collected_secrets.insert("AUTH_TOKEN".into(), templates::generate_auth_token());
    }
    if !collected_secrets.contains_key("AGENT_NAME") {
        collected_secrets.insert("AGENT_NAME".into(), "Baker".into());
    }

    // Provider validation
    if let Some(ref pv) = manifest.provider_validation {
        let has_provider = pv.require_at_least_one.iter().any(|k| collected_secrets.contains_key(k));
        if !has_provider {
            anyhow::bail!("{}", pv.message);
        }
    }

    let mut feature_selections = Vec::new();
    for feature in &manifest.features {
        let has_secrets = feature.secrets.iter()
            .filter(|s| !s.silent)
            .all(|s| std::env::var(&s.key).is_ok());
        let secrets: Vec<_> = feature.secrets.iter()
            .map(|s| (s.key.clone(), std::env::var(&s.key).ok()))
            .collect();
        // Also collect feature secrets
        for (key, val) in &secrets {
            if let Some(ref v) = val {
                collected_secrets.insert(key.clone(), v.clone());
            }
        }
        feature_selections.push(FeatureSelection {
            id: feature.id.clone(),
            name: feature.name.clone(),
            enabled: has_secrets,
            secrets,
        });
    }

    Ok(InstallConfig {
        collected_secrets,
        features: feature_selections,
        namespace: namespace.into(),
    })
}

async fn apply_extensions(
    client: &kube::Client,
    namespace: &str,
    manifest: &ReleaseManifest,
    vars: &std::collections::HashMap<String, String>,
) -> Result<()> {
    for img in &manifest.images {
        if img.required {
            continue;
        }
        let (name, template) = match img.component.as_str() {
            "voice" => ("Voice", templates::VOICE_YAML),
            "sysadmin" => ("SysAdmin", templates::SYSADMIN_YAML),
            "ext-toolbox" => ("Toolbox", templates::TOOLBOX_YAML),
            "ext-browser" => ("Browser", templates::BROWSER_YAML),
            _ => continue,
        };
        let rendered = render_template(template, vars);
        k8s::apply_yaml(client, namespace, &rendered).await?;
        println!("  Applied: {}", name);
    }
    Ok(())
}
