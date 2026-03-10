//! Uninstall command — removes all Baker Street resources.
//!
//! Deletes the Kubernetes namespace (which cascades to all resources within)
//! and optionally removes the local ~/.bakerst/ directory.

use anyhow::{Context, Result};

use crate::cli::{Cli, UninstallArgs};
use crate::k8s;

/// Entry point for the `uninstall` subcommand.
pub async fn run(cli: &Cli, args: UninstallArgs) -> Result<()> {
    let config_path = dirs::home_dir()
        .context("Cannot determine home directory")?
        .join(".bakerst/config.json");

    // Determine namespace from saved config or CLI flag
    let namespace = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)?;
        let saved: serde_json::Value = serde_json::from_str(&content)?;
        saved["namespace"]
            .as_str()
            .unwrap_or(&cli.namespace)
            .to_string()
    } else {
        cli.namespace.clone()
    };

    println!("Baker Street Uninstaller");
    println!();
    println!("This will delete namespace '{}' and all resources within it.", namespace);

    // Confirm unless non-interactive
    if !args.non_interactive {
        print!("Are you sure? [y/N] ");
        use std::io::Write;
        std::io::stdout().flush()?;

        let mut input = String::new();
        std::io::stdin().read_line(&mut input)?;
        if !input.trim().eq_ignore_ascii_case("y") {
            println!("Aborted.");
            return Ok(());
        }
    }

    // Delete namespace (cascades to all resources)
    println!("Deleting namespace '{}'...", namespace);
    let client = kube::Client::try_default()
        .await
        .context("Cannot connect to Kubernetes cluster")?;
    k8s::delete_namespace(&client, &namespace).await?;
    println!("Namespace '{}' deleted.", namespace);

    // Optionally delete local config
    let bakerst_dir = dirs::home_dir()
        .context("Cannot determine home directory")?
        .join(".bakerst");

    if bakerst_dir.exists() {
        let should_delete = if args.non_interactive {
            true
        } else {
            print!("Also delete local config (~/.bakerst/)? [y/N] ");
            use std::io::Write;
            std::io::stdout().flush()?;

            let mut input = String::new();
            std::io::stdin().read_line(&mut input)?;
            input.trim().eq_ignore_ascii_case("y")
        };

        if should_delete {
            std::fs::remove_dir_all(&bakerst_dir)?;
            println!("Removed ~/.bakerst/");
        }
    }

    println!("\nBaker Street has been uninstalled.");
    Ok(())
}
