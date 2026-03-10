//! Status command — displays current deployment state.
//!
//! Reads saved config from ~/.bakerst/config.json, queries K8s for pod/deployment
//! status, and prints a summary. Supports --json and --watch modes.

use anyhow::{Context, Result};
use serde::Serialize;

use crate::cli::{Cli, StatusArgs};
use crate::k8s;

#[derive(Serialize)]
struct StatusOutput {
    namespace: String,
    version: Option<String>,
    enabled_features: Vec<String>,
    agent_name: Option<String>,
    deployments: Vec<DeploymentInfo>,
    secrets: Vec<SecretInfo>,
}

#[derive(Serialize)]
struct DeploymentInfo {
    name: String,
    ready: i32,
    desired: i32,
    image: String,
}

#[derive(Serialize)]
struct SecretInfo {
    name: String,
    keys: Vec<String>,
}

/// Entry point for the `status` subcommand.
pub async fn run(cli: &Cli, args: StatusArgs) -> Result<()> {
    if args.watch {
        loop {
            // Clear screen for watch mode
            print!("\x1B[2J\x1B[1;1H");
            if let Err(e) = print_status(cli, &args).await {
                eprintln!("Error: {}", e);
            }
            println!("\n(watching — refresh every 5s, Ctrl+C to stop)");
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    } else {
        print_status(cli, &args).await
    }
}

async fn print_status(cli: &Cli, args: &StatusArgs) -> Result<()> {
    // Load saved config (non-secret)
    let config_path = dirs::home_dir()
        .context("Cannot determine home directory")?
        .join(".bakerst/config.json");

    let saved_config: Option<serde_json::Value> = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)?;
        Some(serde_json::from_str(&content)?)
    } else {
        None
    };

    let namespace = saved_config
        .as_ref()
        .and_then(|c| c["namespace"].as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| cli.namespace.clone());

    let enabled_features: Vec<String> = saved_config
        .as_ref()
        .and_then(|c| c["enabledFeatures"].as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let agent_name = saved_config
        .as_ref()
        .and_then(|c| c["agentName"].as_str())
        .map(String::from);

    let version = saved_config
        .as_ref()
        .and_then(|c| c["version"].as_str())
        .map(String::from);

    // Query K8s
    let client = kube::Client::try_default()
        .await
        .context("Cannot connect to Kubernetes cluster")?;

    let deploy_statuses = k8s::get_deployments_status(&client, &namespace)
        .await
        .context("Failed to list deployments")?;

    let secrets_info = k8s::get_secrets_info(&client, &namespace)
        .await
        .context("Failed to list secrets")?;

    let deployments: Vec<DeploymentInfo> = deploy_statuses
        .into_iter()
        .map(|d| DeploymentInfo {
            name: d.name,
            ready: d.ready,
            desired: d.desired,
            image: d.image,
        })
        .collect();

    let secrets: Vec<SecretInfo> = secrets_info
        .into_iter()
        .map(|(name, keys)| SecretInfo { name, keys })
        .collect();

    let output = StatusOutput {
        namespace: namespace.clone(),
        version,
        enabled_features,
        agent_name,
        deployments,
        secrets,
    };

    if args.json {
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        print_human(&output);
    }

    Ok(())
}

fn print_human(output: &StatusOutput) {
    println!("Baker Street Status");
    println!("===================");
    println!("Namespace:  {}", output.namespace);
    if let Some(ref v) = output.version {
        println!("Version:    {}", v);
    }
    if let Some(ref name) = output.agent_name {
        println!("Agent:      {}", name);
    }

    if !output.enabled_features.is_empty() {
        println!("Features:   {}", output.enabled_features.join(", "));
    }

    println!();
    println!("Deployments:");
    if output.deployments.is_empty() {
        println!("  (none found)");
    } else {
        for d in &output.deployments {
            let status_icon = if d.ready >= d.desired && d.desired > 0 {
                "\u{2713}"
            } else {
                "\u{2717}"
            };
            println!(
                "  {} {:<20} {}/{} ready   {}",
                status_icon, d.name, d.ready, d.desired, d.image
            );
        }
    }

    println!();
    println!("Secrets:");
    if output.secrets.is_empty() {
        println!("  (none found)");
    } else {
        for s in &output.secrets {
            println!("  {}: {} keys", s.name, s.keys.len());
        }
    }
}
