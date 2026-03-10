//! Config file loader — reads a YAML config file for non-interactive installs.
//!
//! Supports environment variable interpolation via `${VAR_NAME}` syntax
//! so that CI pipelines can inject secrets from GitHub Actions secrets
//! without committing them to the config file.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

/// A user-provided config file for non-interactive installation.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    /// Version of Baker Street to install (optional, defaults to latest)
    #[serde(default)]
    pub version: Option<String>,

    /// Namespace to deploy into
    #[serde(default)]
    pub namespace: Option<String>,

    /// AI persona name override
    #[serde(default)]
    pub agent_name: Option<String>,

    /// Key-value pairs for secrets/credentials
    #[serde(default)]
    pub secrets: HashMap<String, String>,

    /// Feature toggles
    #[serde(default)]
    pub features: HashMap<String, bool>,

    /// Verification configuration
    #[serde(default)]
    pub verify: Option<VerifyConfig>,
}

/// Optional verification settings that override defaults.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VerifyConfig {
    /// Expected pod name prefixes (e.g. "brain-blue", "worker", "nats")
    #[serde(default)]
    pub expected_pods: Vec<String>,

    /// A prompt to send after deploy to verify the AI responds
    pub chat_prompt: Option<String>,

    /// Timeout in seconds for verification checks
    pub timeout_seconds: Option<u64>,
}

/// Load and parse a config file from disk, resolving `${VAR}` env references.
pub fn load_config(path: &Path) -> Result<ConfigFile> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read config file: {}", path.display()))?;
    let resolved = resolve_env_vars(&content);
    let config: ConfigFile = serde_yaml::from_str(&resolved)
        .with_context(|| format!("Failed to parse config YAML: {}", path.display()))?;
    Ok(config)
}

/// Replace `${VAR_NAME}` patterns with values from the environment.
/// Missing env vars resolve to empty strings.
fn resolve_env_vars(input: &str) -> String {
    let re = regex::Regex::new(r"\$\{(\w+)\}").unwrap();
    re.replace_all(input, |caps: &regex::Captures| {
        std::env::var(&caps[1]).unwrap_or_default()
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_env_vars_basic() {
        std::env::set_var("TEST_RESOLVE_KEY", "hello");
        let result = resolve_env_vars("value: ${TEST_RESOLVE_KEY}");
        assert_eq!(result, "value: hello");
        std::env::remove_var("TEST_RESOLVE_KEY");
    }

    #[test]
    fn resolve_env_vars_missing_returns_empty() {
        std::env::remove_var("NONEXISTENT_VAR_12345");
        let result = resolve_env_vars("key: ${NONEXISTENT_VAR_12345}");
        assert_eq!(result, "key: ");
    }

    #[test]
    fn resolve_env_vars_multiple() {
        std::env::set_var("RESOLVE_A", "aaa");
        std::env::set_var("RESOLVE_B", "bbb");
        let result = resolve_env_vars("${RESOLVE_A} and ${RESOLVE_B}");
        assert_eq!(result, "aaa and bbb");
        std::env::remove_var("RESOLVE_A");
        std::env::remove_var("RESOLVE_B");
    }

    #[test]
    fn resolve_leaves_non_matching_text_alone() {
        let input = "no vars here, just $PLAIN text";
        assert_eq!(resolve_env_vars(input), input);
    }
}
