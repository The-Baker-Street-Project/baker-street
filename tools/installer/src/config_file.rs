//! Config file loader — reads a YAML config file for non-interactive installs.
//!
//! This module will be fully implemented in Task 14.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

/// A user-provided config file for non-interactive installation.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ConfigFile {
    /// Version of Baker Street to install (optional, defaults to latest)
    #[serde(default)]
    pub version: Option<String>,

    /// Namespace to deploy into
    #[serde(default)]
    pub namespace: Option<String>,

    /// Key-value pairs for secrets/credentials
    #[serde(default)]
    pub secrets: HashMap<String, String>,

    /// Feature toggles
    #[serde(default)]
    pub features: HashMap<String, bool>,
}

/// Load and parse a config file from disk.
pub fn load_config(path: &Path) -> Result<ConfigFile> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read config file: {}", path.display()))?;
    let config: ConfigFile = serde_yaml::from_str(&content)
        .with_context(|| format!("Failed to parse config YAML: {}", path.display()))?;
    Ok(config)
}
