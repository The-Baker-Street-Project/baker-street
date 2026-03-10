//! Shared deployment helpers used by both install and update commands.

use anyhow::{Context, Result};
use std::collections::BTreeMap;

use crate::config_schema::ConfigSchema;
use crate::interview::InterviewResult;
use crate::k8s;

/// Apply K8s secrets based on config schema targetSecrets mapping.
pub async fn apply_secrets(
    client: &kube::Client,
    schema: &ConfigSchema,
    config: &InterviewResult,
) -> Result<()> {
    // Build secret groups: map from K8s secret name -> key/value pairs
    let mut secret_groups: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();

    // Process top-level secrets
    for secret_def in &schema.secrets {
        if let Some(value) = config.secrets.get(&secret_def.key) {
            if !value.is_empty() {
                for target in &secret_def.target_secrets {
                    secret_groups
                        .entry(target.clone())
                        .or_default()
                        .insert(secret_def.key.clone(), value.clone());
                }
            }
        }
    }

    // Process feature secrets
    for feature in &schema.features {
        if config.enabled_features.contains(&feature.id) {
            for secret_def in &feature.secrets {
                if let Some(value) = config.secrets.get(&secret_def.key) {
                    if !value.is_empty() {
                        for target in &secret_def.target_secrets {
                            secret_groups
                                .entry(target.clone())
                                .or_default()
                                .insert(secret_def.key.clone(), value.clone());
                        }
                    }
                }
            }
        }
    }

    // Create each K8s secret
    for (secret_name, data) in &secret_groups {
        k8s::create_secret(client, &config.namespace, secret_name, data).await?;
        println!(
            "  Created secret: {} ({} keys)",
            secret_name,
            data.len()
        );
    }

    Ok(())
}

/// Read all YAML files from a directory (sorted), concatenate, and apply.
pub async fn apply_manifests_from_dir(
    client: &kube::Client,
    namespace: &str,
    dir: &std::path::Path,
) -> Result<()> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .with_context(|| format!("Cannot read manifest directory: {}", dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            matches!(p.extension().and_then(|e| e.to_str()), Some("yaml" | "yml"))
        })
        .collect();
    paths.sort();

    let mut yamls = Vec::new();
    for path in &paths {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read manifest: {}", path.display()))?;
        yamls.push(content);
    }
    let combined = yamls.join("\n---\n");
    let applied = k8s::apply_yaml(client, namespace, &combined).await?;
    for label in &applied {
        println!("  Applied: {}", label);
    }
    Ok(())
}

/// Apply extension manifests for enabled features.
pub async fn apply_extensions(
    client: &kube::Client,
    namespace: &str,
    extensions_dir: &std::path::Path,
    enabled_features: &[String],
) -> Result<()> {
    if extensions_dir.exists() {
        for feature in enabled_features {
            let ext_dir = extensions_dir.join(feature);
            if ext_dir.exists() {
                println!("  Applying extension: {}", feature);
                apply_manifests_from_dir(client, namespace, &ext_dir).await?;
            }
        }
    }
    Ok(())
}
