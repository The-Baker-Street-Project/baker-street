//! Interview engine — drives the secret/feature collection process.
//!
//! Three modes:
//! - `from_config_file`: non-interactive, reads a YAML config file
//! - `from_env`: non-interactive, reads secrets from environment variables
//! - `run_interactive`: stdin-based interactive interview

use anyhow::{bail, Result};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};

use crate::config_file::ConfigFile;
use crate::config_schema::{ConfigSchema, SecretDef};

#[derive(Debug)]
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
pub fn from_config_file(schema: &ConfigSchema, config: &ConfigFile) -> Result<InterviewResult> {
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
        if config
            .features
            .get(&feature.id)
            .copied()
            .unwrap_or(feature.default_enabled)
        {
            for secret_def in &feature.secrets {
                if !secrets.contains_key(&secret_def.key) {
                    if let Some(ref auto_gen) = secret_def.auto_generate {
                        secrets.insert(secret_def.key.clone(), generate_value(auto_gen)?);
                    }
                }
            }
        }
    }

    let enabled_features: Vec<String> = schema
        .features
        .iter()
        .filter(|f| {
            config
                .features
                .get(&f.id)
                .copied()
                .unwrap_or(f.default_enabled)
        })
        .map(|f| f.id.clone())
        .collect();

    let namespace = config
        .namespace
        .clone()
        .unwrap_or_else(|| schema.defaults.namespace.clone());

    // Validate provider requirement
    let has_provider = schema
        .provider_validation
        .require_at_least_one
        .iter()
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

/// Interactive interview — walks the user through prompts from the schema.
pub async fn run_interactive(schema: &ConfigSchema) -> Result<InterviewResult> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut secrets = HashMap::new();

    println!();
    println!("  Let's set up Baker Street!");
    println!("  Press Enter to skip optional fields. Env vars are used as defaults.");
    println!();

    // Collect namespace
    let namespace = prompt_text(
        &mut reader,
        "Kubernetes namespace",
        Some(&schema.defaults.namespace),
        false,
    )?;
    let namespace = if namespace.is_empty() {
        schema.defaults.namespace.clone()
    } else {
        namespace
    };

    // Collect agent name
    let agent_name = prompt_text(
        &mut reader,
        "What would you like to call your agent?",
        Some(&schema.defaults.agent_name),
        false,
    )?;
    let agent_name = if agent_name.is_empty() {
        schema.defaults.agent_name.clone()
    } else {
        agent_name
    };

    // Collect secrets by group
    let groups = ["providers", "core", "memory"];
    for group in &groups {
        let group_secrets: Vec<&SecretDef> = schema
            .secrets
            .iter()
            .filter(|s| s.group.as_deref() == Some(group))
            .collect();
        if group_secrets.is_empty() {
            continue;
        }

        println!();
        let label = match *group {
            "providers" => "AI Providers",
            "core" => "Core Settings",
            "memory" => "Memory & Embeddings",
            _ => group,
        };
        println!("  --- {} ---", label);

        for secret_def in &group_secrets {
            // Check dependsOn: skip if none of the dependencies have values
            if let Some(ref deps) = secret_def.depends_on {
                let any_dep_set = deps
                    .iter()
                    .any(|d| secrets.get(d).map_or(false, |v: &String| !v.is_empty()));
                if !any_dep_set {
                    continue;
                }
            }

            // Skip silent fields
            if secret_def.silent {
                continue;
            }

            let value = collect_secret(&mut reader, secret_def, &secrets)?;
            if !value.is_empty() {
                secrets.insert(secret_def.key.clone(), value);
            } else if let Some(ref auto_gen) = secret_def.auto_generate {
                secrets.insert(secret_def.key.clone(), generate_value(auto_gen)?);
            }
        }
    }

    // Validate provider requirement
    let has_provider = schema
        .provider_validation
        .require_at_least_one
        .iter()
        .any(|key| secrets.get(key).map_or(false, |v: &String| !v.is_empty()));
    if !has_provider {
        println!();
        bail!(
            "{}. Set at least one of: {}",
            schema.provider_validation.message,
            schema.provider_validation.require_at_least_one.join(", ")
        );
    }

    // Collect features
    println!();
    println!("  --- Features ---");
    let mut enabled_features = Vec::new();

    for feature in &schema.features {
        // Check dependsOn: skip features whose dependencies aren't met
        if let Some(ref deps) = feature.depends_on {
            let any_dep_set = deps
                .iter()
                .any(|d| secrets.get(d).map_or(false, |v: &String| !v.is_empty()));
            if !any_dep_set {
                continue;
            }
        }

        let default_yn = if feature.default_enabled { "Y" } else { "n" };
        let answer = prompt_text(
            &mut reader,
            &format!("Enable {}? ({})", feature.name, feature.description),
            Some(default_yn),
            false,
        )?;

        let enabled = if answer.is_empty() {
            feature.default_enabled
        } else {
            matches!(answer.to_lowercase().as_str(), "y" | "yes" | "true" | "1")
        };

        if enabled {
            // Collect feature-specific secrets
            for secret_def in &feature.secrets {
                if secret_def.silent {
                    continue;
                }
                let value = collect_secret(&mut reader, secret_def, &secrets)?;
                if !value.is_empty() {
                    secrets.insert(secret_def.key.clone(), value);
                } else if secret_def.required {
                    println!("    Skipping {} (required secret not provided)", feature.name);
                    continue;
                }
            }
            enabled_features.push(feature.id.clone());
        }
    }

    println!();

    Ok(InterviewResult {
        secrets,
        enabled_features,
        namespace,
        agent_name,
    })
}

/// Collect a single secret value, checking env vars as fallback.
fn collect_secret(
    reader: &mut impl BufRead,
    secret_def: &SecretDef,
    _existing: &HashMap<String, String>,
) -> Result<String> {
    // Check env var first for default
    let env_val = std::env::var(&secret_def.key).ok().filter(|v| !v.is_empty());

    if let Some(ref choices) = secret_def.choices {
        // Choice prompt
        let prompt = secret_def
            .prompt
            .as_deref()
            .unwrap_or(&secret_def.description);
        println!();
        println!("  {}", prompt);
        for (i, choice) in choices.iter().enumerate() {
            let desc = choice
                .description
                .as_deref()
                .map(|d| format!(" ({})", d))
                .unwrap_or_default();
            println!("    {}) {}{}", i + 1, choice.label, desc);
        }

        let default_display = env_val
            .as_ref()
            .and_then(|v| {
                choices
                    .iter()
                    .position(|c| c.value == *v)
                    .map(|i| format!("{}", i + 1))
            })
            .unwrap_or_default();

        let default_hint = if default_display.is_empty() {
            "skip".to_string()
        } else {
            default_display.clone()
        };

        print!("  Choice [{}]: ", default_hint);
        io::stdout().flush()?;
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim();

        if line.is_empty() {
            return Ok(env_val.unwrap_or_default());
        }

        if let Ok(idx) = line.parse::<usize>() {
            if idx >= 1 && idx <= choices.len() {
                return Ok(choices[idx - 1].value.clone());
            }
        }
        // Try matching by value or label
        for choice in choices {
            if choice.value == line || choice.label.eq_ignore_ascii_case(line) {
                return Ok(choice.value.clone());
            }
        }
        Ok(line.to_string())
    } else {
        // Text/secret prompt
        let prompt = secret_def
            .prompt
            .as_deref()
            .unwrap_or(&secret_def.description);

        let is_secret = secret_def.input_type == "secret";

        if let Some(ref env) = env_val {
            let display = if is_secret {
                let masked: String = if env.len() > 8 {
                    format!("{}...{}", &env[..4], &env[env.len() - 4..])
                } else {
                    "*".repeat(env.len())
                };
                masked
            } else {
                env.clone()
            };
            let value = prompt_text(reader, prompt, Some(&display), false)?;
            if value.is_empty() {
                return Ok(env.clone());
            }
            return Ok(value);
        }

        let placeholder = secret_def.placeholder.as_deref().unwrap_or("skip");
        let value = prompt_text(reader, prompt, Some(placeholder), false)?;
        Ok(value)
    }
}

/// Print a prompt and read a line from stdin.
fn prompt_text(
    reader: &mut impl BufRead,
    prompt: &str,
    default: Option<&str>,
    _required: bool,
) -> Result<String> {
    match default {
        Some(d) => print!("  {} [{}]: ", prompt, d),
        None => print!("  {}: ", prompt),
    }
    io::stdout().flush()?;
    let mut line = String::new();
    reader.read_line(&mut line)?;
    Ok(line.trim().to_string())
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

    let enabled_features: Vec<String> = schema
        .features
        .iter()
        .filter(|f| f.default_enabled)
        .map(|f| f.id.clone())
        .collect();

    let has_provider = schema
        .provider_validation
        .require_at_least_one
        .iter()
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
