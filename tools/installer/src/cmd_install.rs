//! Install command — orchestrates the full install flow:
//! fetch manifest, interview, pull images, apply K8s resources, verify.

use anyhow::{bail, Context, Result};
use std::collections::BTreeMap;

use crate::cli::{Cli, InstallArgs};
use crate::config_file;
use crate::config_schema::ConfigSchema;
use crate::{deploy, fetcher, interview, k8s, verify};

/// Entry point for the `install` subcommand.
pub async fn run(_cli: &Cli, args: InstallArgs) -> Result<()> {
    println!("Baker Street Installer v{}", env!("CARGO_PKG_VERSION"));
    println!();

    // 1. Preflight: detect kubectl, K8s contexts
    println!("[1/9] Preflight checks...");
    let server_version = k8s::check_cluster()
        .await
        .context("Kubernetes cluster not reachable. Ensure kubectl is installed and a cluster is running.")?;
    println!("  K8s server version: {}", server_version);

    let contexts = k8s::detect_contexts().await?;
    if contexts.is_empty() {
        bail!("No Kubernetes contexts found. Install Docker Desktop or OrbStack with Kubernetes enabled.");
    }
    if contexts.len() == 1 {
        println!(
            "  Using K8s context: {} ({})",
            contexts[0].name, contexts[0].cluster_type
        );
    } else {
        println!("  Available K8s contexts:");
        for (i, ctx) in contexts.iter().enumerate() {
            println!("    {}) {} ({})", i + 1, ctx.name, ctx.cluster_type);
        }
        // For non-interactive, use first context; for interactive, prompt
        if !args.non_interactive {
            // TODO: Prompt user for context selection (Task 15 TUI)
            println!("  Using first context: {}", contexts[0].name);
        }
        k8s::use_context(&contexts[0].name).await?;
    }

    // 2. Fetch manifest
    println!("[2/9] Fetching manifest...");
    let manifest = fetcher::fetch_manifest(
        args.manifest.as_deref(),
        args.version.as_deref(),
    )
    .await?;
    println!(
        "  Version: {} (schema v{})",
        manifest.version, manifest.schema_version
    );

    // 3. Download and extract template
    println!("[3/9] Downloading install template...");
    let work_dir = tempfile::tempdir()?;
    let template_dir = if let Some(template_path) = &args.template {
        // Local template tarball provided — extract it directly
        fetcher::extract_template(template_path, work_dir.path())?
    } else {
        fetcher::fetch_template(
            &manifest,
            args.manifest.as_deref(),
            work_dir.path(),
        )
        .await?
    };
    println!("  Template extracted to: {}", template_dir.display());

    // 4. Load config schema from template
    let schema_path = template_dir.join("config-schema.json");
    let schema = ConfigSchema::from_file(&schema_path)?;

    // 5. Configure (interview or config file)
    println!("[4/9] Configuring...");
    let config = if let Some(config_path) = &args.config {
        let file = config_file::load_config(config_path)?;
        interview::from_config_file(&schema, &file)?
    } else if args.non_interactive {
        interview::from_env(&schema)?
    } else {
        interview::run_interactive(&schema).await?
    };
    println!("  Namespace: {}", config.namespace);
    println!("  Features: {:?}", config.enabled_features);

    // 6. Save config for future updates (NON-SECRET data only)
    let config_save_path = dirs::home_dir()
        .context("Cannot determine home directory")?
        .join(".bakerst/config.json");
    config.save_non_secret(&config_save_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            &config_save_path,
            std::fs::Permissions::from_mode(0o600),
        )?;
    }

    if args.dry_run {
        println!(
            "\nDry run complete. Would apply manifests from: {}",
            template_dir.display()
        );
        return Ok(());
    }

    let skip_verify = args.no_wait;

    // Obtain a K8s client for all cluster operations
    let client = kube::Client::try_default().await?;

    // 7. Create namespace and secrets
    println!("[5/9] Creating namespace and secrets...");
    k8s::create_namespace(&client, &config.namespace).await?;
    deploy::apply_secrets(&client, &schema, &config).await?;

    // Create ConfigMap from operating_system/ files
    let os_dir = template_dir.join("operating_system");
    if os_dir.exists() {
        let os_files = load_os_files(&os_dir)?;
        k8s::create_os_configmap(&client, &config.namespace, &os_files).await?;
    }

    // 8. Apply K8s manifests
    println!("[6/9] Applying manifests...");
    let k8s_dir = template_dir.join("k8s");
    // The template always bundles pre-rendered YAML in overlays/remote/
    let remote_overlay = k8s_dir.join("overlays/remote");
    let manifest_dir = if remote_overlay.exists() {
        remote_overlay
    } else {
        k8s_dir.clone()
    };
    deploy::apply_manifests_from_dir(&client, &config.namespace, &manifest_dir).await?;

    // Apply extension manifests for enabled features
    let extensions_dir = k8s_dir.join("extensions");
    deploy::apply_extensions(&client, &config.namespace, &extensions_dir, &config.enabled_features).await?;

    if skip_verify {
        println!("\nManifests applied (--no-wait: skipping pod wait and verification).");
        println!("   Access Baker Street at http://localhost:30080");
        return Ok(());
    }

    // 9. Wait for pods to start
    println!("[7/9] Waiting for pods to start...");
    k8s::wait_for_deployments(
        &client,
        &config.namespace,
        std::time::Duration::from_secs(300),
    )
    .await
    .context("Pods did not become ready within 5 minutes")?;
    println!("  All deployments ready");

    // 10. Verify
    println!("[8/9] Verifying deployment...");
    let result = verify::run_checks(&client, &config.namespace, &config).await?;

    // 11. Report
    println!("[9/9] Writing log...");
    result.write_log(&args.log)?;

    if result.all_passed() {
        println!("\nInstallation complete!");
        println!("   Access Baker Street at http://localhost:30080");
        println!("   Auth token saved to ~/.bakerst/config.json");
        Ok(())
    } else {
        println!("\nInstallation completed but verification failed.");
        println!("   Check log: {}", args.log.display());
        for check in &result.checks {
            if !check.passed {
                println!("   FAILED: {} -- {}", check.name, check.message);
            }
        }
        bail!("Verification failed. See log for details.");
    }
}

fn load_os_files(dir: &std::path::Path) -> Result<BTreeMap<String, String>> {
    let mut files = BTreeMap::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            let name = entry.file_name().to_string_lossy().to_string();
            let content = std::fs::read_to_string(entry.path())?;
            files.insert(name, content);
        }
    }
    Ok(files)
}
