use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
pub struct ConfigFile {
    pub credentials: Credentials,
    #[serde(default)]
    pub features: HashMap<String, FeatureConfig>,
    pub verify: VerifyConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Credentials {
    pub anthropic_api_key: Option<String>,
    pub openai_api_key: Option<String>,
    pub ollama_endpoints: Option<String>,
    pub voyage_api_key: Option<String>,
    pub agent_name: Option<String>,
    pub auth_token: Option<String>,
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FeatureConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub secrets: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VerifyConfig {
    #[serde(default)]
    pub expected_pods: Vec<String>,
    #[serde(default)]
    pub chat_prompt: Option<String>,
    #[serde(default)]
    pub expected_capabilities: Vec<String>,
}

pub fn load_config(path: &str) -> Result<ConfigFile> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read config file: {}", path))?;
    let config: ConfigFile = serde_yaml::from_str(&content)
        .with_context(|| format!("Failed to parse config YAML: {}", path))?;

    // Validate: API key is required
    if config.credentials.anthropic_api_key.is_none() {
        anyhow::bail!("Config must provide anthropic_api_key");
    }

    Ok(config)
}
