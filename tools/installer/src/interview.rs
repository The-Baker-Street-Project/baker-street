//! Interview engine — drives the secret/feature collection process.
//!
//! Three modes:
//! - `from_config_file`: non-interactive, reads a YAML config file
//! - `from_env`: non-interactive, reads secrets from environment variables
//! - `run_interactive`: TUI-driven interview (implemented in Task 15)

use anyhow::{Result, bail};
use std::collections::HashMap;
use crate::config_schema::ConfigSchema;
use crate::config_file::ConfigFile;

pub struct InterviewResult {
    pub secrets: HashMap<String, String>,
    pub enabled_features: Vec<String>,
    pub namespace: String,
    pub agent_name: String,
}

impl InterviewResult {
    pub fn save_non_secret(&self, path: &std::path::Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let non_secret = serde_json::json!({
            "namespace": self.namespace,
            "enabledFeatures": self.enabled_features,
            "agentName": self.agent_name,
        });
        std::fs::write(path, serde_json::to_string_pretty(&non_secret)?)?;
        Ok(())
    }
}

/// Build an InterviewResult from a config file (non-interactive mode).
pub fn from_config_file(
    schema: &ConfigSchema,
    config: &ConfigFile,
) -> Result<InterviewResult> {
    let mut secrets = config.secrets.clone();

    // Auto-generate any secrets marked with autoGenerate that aren't provided
    for secret_def in &schema.secrets {
        if !secrets.contains_key(&secret_def.key) {
            if let Some(ref auto_gen) = secret_def.auto_generate {
                secrets.insert(secret_def.key.clone(), generate_value(auto_gen)?);
            }
        }
        if secrets.get(&secret_def.key).map(|v| v.as_str()) == Some("auto") {
            if let Some(ref auto_gen) = secret_def.auto_generate {
                secrets.insert(secret_def.key.clone(), generate_value(auto_gen)?);
            }
        }
    }

    // Also process feature-level secrets
    for feature in &schema.features {
        if config.features.get(&feature.id).copied().unwrap_or(feature.default_enabled) {
            for secret_def in &feature.secrets {
                if !secrets.contains_key(&secret_def.key) {
                    if let Some(ref auto_gen) = secret_def.auto_generate {
                        secrets.insert(secret_def.key.clone(), generate_value(auto_gen)?);
                    }
                }
            }
        }
    }

    let enabled_features: Vec<String> = schema.features.iter()
        .filter(|f| config.features.get(&f.id).copied().unwrap_or(f.default_enabled))
        .map(|f| f.id.clone())
        .collect();

    let namespace = config.namespace.clone()
        .unwrap_or_else(|| schema.defaults.namespace.clone());

    // Validate provider requirement
    let has_provider = schema.provider_validation.require_at_least_one.iter()
        .any(|key| secrets.get(key).map_or(false, |v| !v.is_empty()));
    if !has_provider {
        bail!("{}", schema.provider_validation.message);
    }

    Ok(InterviewResult {
        secrets,
        enabled_features,
        namespace,
        agent_name: schema.defaults.agent_name.clone(),
    })
}

/// TUI-driven interactive interview (stub — implemented in Task 15).
pub async fn run_interactive(_schema: &ConfigSchema) -> Result<InterviewResult> {
    todo!("Interactive interview will be implemented in Task 15 (TUI)")
}

/// Build an InterviewResult from environment variables (CI/headless mode).
pub fn from_env(schema: &ConfigSchema) -> Result<InterviewResult> {
    let mut secrets = HashMap::new();
    for secret_def in &schema.secrets {
        if let Ok(val) = std::env::var(&secret_def.key) {
            secrets.insert(secret_def.key.clone(), val);
        } else if let Some(ref auto_gen) = secret_def.auto_generate {
            secrets.insert(secret_def.key.clone(), generate_value(auto_gen)?);
        }
    }

    let enabled_features: Vec<String> = schema.features.iter()
        .filter(|f| f.default_enabled)
        .map(|f| f.id.clone())
        .collect();

    let has_provider = schema.provider_validation.require_at_least_one.iter()
        .any(|key| secrets.get(key).map_or(false, |v| !v.is_empty()));
    if !has_provider {
        bail!("{}", schema.provider_validation.message);
    }

    Ok(InterviewResult {
        secrets,
        enabled_features,
        namespace: schema.defaults.namespace.clone(),
        agent_name: schema.defaults.agent_name.clone(),
    })
}

/// Generate a value from a spec string (e.g., "hex:32" = 32 random hex bytes).
fn generate_value(spec: &str) -> Result<String> {
    if let Some(len_str) = spec.strip_prefix("hex:") {
        let len: usize = len_str.parse()?;
        let mut bytes = vec![0u8; len];
        getrandom::getrandom(&mut bytes)
            .map_err(|e| anyhow::anyhow!("Failed to generate random bytes: {}", e))?;
        Ok(hex::encode(bytes))
    } else {
        bail!("Unknown autoGenerate format: {}", spec);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_hex_value() {
        let val = generate_value("hex:32").unwrap();
        assert_eq!(val.len(), 64); // 32 bytes = 64 hex chars
        assert!(val.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_generate_unknown_format() {
        assert!(generate_value("base64:32").is_err());
    }

    #[test]
    fn test_generate_produces_different_values() {
        let v1 = generate_value("hex:32").unwrap();
        let v2 = generate_value("hex:32").unwrap();
        assert_ne!(v1, v2);
    }
}
