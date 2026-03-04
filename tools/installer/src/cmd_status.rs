use anyhow::Result;

use crate::cli::{Cli, StatusArgs};
use crate::k8s;
use crate::meta;

/// Entry point for the `status` subcommand.
pub async fn run(cli: &Cli, args: &StatusArgs) -> Result<()> {
    if args.watch {
        loop {
            // Clear screen for watch mode
            print!("\x1b[2J\x1b[H");
            print_status(cli, args).await?;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    } else {
        print_status(cli, args).await
    }
}

async fn print_status(cli: &Cli, args: &StatusArgs) -> Result<()> {
    let client = kube::Client::try_default().await?;
    let ns = &cli.namespace;

    // Read deploy metadata
    let deploy_meta = meta::read_meta(&client, ns).await?;
    let statuses = k8s::get_deployments_status(&client, ns).await?;
    let secrets_info = k8s::get_secrets_info(&client, ns).await?;

    if args.json {
        print_json(&deploy_meta, &statuses, &secrets_info)?;
    } else {
        print_table(ns, &deploy_meta, &statuses, &secrets_info);
    }

    Ok(())
}

fn print_json(
    deploy_meta: &Option<meta::DeployMeta>,
    statuses: &[k8s::DeploymentStatus],
    secrets_info: &[(String, Vec<String>)],
) -> Result<()> {
    let meta_json = match deploy_meta {
        Some(m) => serde_json::json!({
            "version": m.version,
            "activeSlot": m.active_slot,
            "deployTimestamp": m.deploy_timestamp,
            "features": m.features,
            "components": m.components,
        }),
        None => serde_json::json!(null),
    };

    let deployments: Vec<_> = statuses
        .iter()
        .map(|s| {
            serde_json::json!({
                "name": s.name,
                "desired": s.desired,
                "ready": s.ready,
                "image": s.image,
            })
        })
        .collect();

    let secrets: Vec<_> = secrets_info
        .iter()
        .map(|(name, keys)| {
            serde_json::json!({
                "name": name,
                "keys": keys,
            })
        })
        .collect();

    let output = serde_json::json!({
        "meta": meta_json,
        "deployments": deployments,
        "secrets": secrets,
    });

    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

fn print_table(
    namespace: &str,
    deploy_meta: &Option<meta::DeployMeta>,
    statuses: &[k8s::DeploymentStatus],
    secrets_info: &[(String, Vec<String>)],
) {
    println!("Baker Street Status");

    if let Some(ref m) = deploy_meta {
        println!("  Namespace:  {}", namespace);
        println!("  Version:    {}", if m.version.is_empty() { "unknown" } else { &m.version });
        println!("  Deployed:   {}", if m.deploy_timestamp.is_empty() { "unknown" } else { &m.deploy_timestamp });
        println!("  Brain Slot: {} (active)", m.active_slot);
        if !m.features.is_empty() {
            println!("  Features:   {}", m.features);
        }
    } else {
        println!("  Namespace:  {}", namespace);
        println!("  Meta:       not found (pre-meta install or no deployment)");
    }

    println!();
    println!(
        "{:<20} {:>7} {:>7} {}",
        "DEPLOYMENT", "DESIRED", "READY", "IMAGE"
    );
    println!("{}", "\u{2500}".repeat(80));

    if statuses.is_empty() {
        println!("  No deployments found in namespace '{}'", namespace);
    } else {
        for s in statuses {
            let status_icon = if s.desired > 0 && s.ready >= s.desired {
                "\u{2713}"
            } else if s.desired == 0 {
                " "
            } else {
                "\u{2717}"
            };
            println!(
                "{} {:<18} {:>7} {:>7} {}",
                status_icon, s.name, s.desired, s.ready, s.image
            );
        }
    }

    if !secrets_info.is_empty() {
        println!();
        println!("Secrets:");
        for (name, keys) in secrets_info {
            println!("  {:<30} [{}]", name, keys.join(", "));
        }
    }
}
