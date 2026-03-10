//! Update command — fetches latest manifest and applies changes.
//!
//! Loads saved config from ~/.bakerst/config.json, compares versions,
//! and re-applies manifests if a newer version is available.

use anyhow::{bail, Context, Result};

use crate::cli::{Cli, UpdateArgs};
use crate::config_schema::ConfigSchema;
use crate::{deploy, fetcher, interview, k8s, verify};

/// Entry point for the `update` subcommand.
pub async fn run(cli: &Cli, args: UpdateArgs) -> Result<()> {
    println!("Baker Street Updater v{}", env!("CARGO_PKG_VERSION"));
    println!();

    // 1. Load saved config
    let config_path = dirs::home_dir()
        .context("Cannot determine home directory")?
        .join(".bakerst/config.json");

    if !config_path.exists() {
        bail!(
            "No saved config found at {}. Run `bakerst-install install` first.",
            config_path.display()
        );
    }

    let saved: serde_json::Value = {
        let content = std::fs::read_to_string(&config_path)?;
        serde_json::from_str(&content)?
    };

    let namespace = saved["namespace"]
        .as_str()
        .unwrap_or(&cli.namespace)
        .to_string();

    let current_version = saved["version"].as_str().map(String::from);

    println!("Namespace:       {}", namespace);
    if let Some(ref v) = current_version {
        println!("Current version: {}", v);
    }

    // 2. Fetch latest manifest
    println!("\nFetching latest manifest...");
    let manifest = fetcher::fetch_manifest(None, None).await?;
    println!("Latest version:  {}", manifest.version);

    // 3. Compare versions
    if let Some(ref current) = current_version {
        if current == &manifest.version {
            println!("\nAlready up to date (v{}).", current);
            if !args.reconfigure {
                return Ok(());
            }
            println!("Reconfiguring as requested...");
        }
    }

    // 4. Confirm
    if !args.non_interactive {
        println!("\nThis will update Baker Street in namespace '{}'.", namespace);
        print!("Continue? [y/N] ");
        use std::io::Write;
        std::io::stdout().flush()?;

        let mut input = String::new();
        std::io::stdin().read_line(&mut input)?;
        if !input.trim().eq_ignore_ascii_case("y") {
            println!("Aborted.");
            return Ok(());
        }
    }

    // 5. Download template
    println!("\nDownloading install template...");
    let work_dir = tempfile::tempdir()?;
    let template_dir = fetcher::fetch_template(&manifest, None, work_dir.path()).await?;

    // 6. Load config schema
    let schema_path = template_dir.join("config-schema.json");
    let schema = ConfigSchema::from_file(&schema_path)?;

    // 7. Build interview result
    let config = if args.reconfigure {
        // Re-collect from environment
        println!("Re-reading configuration from environment...");
        interview::from_env(&schema)?
    } else {
        // Preserve existing secrets from K8s, merge with saved config
        let client = kube::Client::try_default().await?;
        rebuild_config_from_cluster(&client, &namespace, &schema, &saved).await?
    };

    // 8. Apply
    let client = kube::Client::try_default().await?;

    println!("Applying secrets...");
    deploy::apply_secrets(&client, &schema, &config).await?;

    println!("Applying manifests...");
    let k8s_dir = template_dir.join("k8s");
    let remote_overlay = k8s_dir.join("overlays/remote");
    let manifest_dir = if remote_overlay.exists() {
        remote_overlay
    } else {
        k8s_dir.clone()
    };
    deploy::apply_manifests_from_dir(&client, &namespace, &manifest_dir).await?;

    // Apply extension manifests
    let extensions_dir = k8s_dir.join("extensions");
    deploy::apply_extensions(&client, &namespace, &extensions_dir, &config.enabled_features).await?;

    // 9. Verify deployment
    println!("Verifying deployment...");
    let result = verify::run_checks(&client, &namespace, &config).await?;
    if !result.all_passed() {
        for check in &result.checks {
            if !check.passed {
                println!("  WARNING: {} -- {}", check.name, check.message);
            }
        }
        println!("  Some verification checks failed (update applied, but check the deployment)");
    }

    // 10. Save updated config
    let mut saved_config = serde_json::json!({
        "namespace": config.namespace,
        "enabledFeatures": config.enabled_features,
        "agentName": config.agent_name,
    });
    saved_config["version"] = serde_json::Value::String(manifest.version.clone());
    std::fs::write(&config_path, serde_json::to_string_pretty(&saved_config)?)?;

    println!("\nUpdate complete! Now running v{}.", manifest.version);
    Ok(())
}

/// Rebuild an InterviewResult by reading existing secrets from the cluster.
async fn rebuild_config_from_cluster(
    client: &kube::Client,
    namespace: &str,
    schema: &ConfigSchema,
    saved: &serde_json::Value,
) -> Result<interview::InterviewResult> {
    let mut secrets = std::collections::HashMap::new();

    // Read all bakerst-* secrets from the cluster
    let cluster_secrets = k8s::get_secrets_info(client, namespace).await?;
    for (secret_name, _keys) in &cluster_secrets {
        if let Some(data) = k8s::read_secret(client, namespace, secret_name).await? {
            for (k, v) in data {
                secrets.entry(k).or_insert(v);
            }
        }
    }

    let enabled_features: Vec<String> = saved["enabledFeatures"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let agent_name = saved["agentName"]
        .as_str()
        .unwrap_or(&schema.defaults.agent_name)
        .to_string();

    Ok(interview::InterviewResult {
        secrets,
        enabled_features,
        namespace: namespace.to_string(),
        agent_name,
    })
}

