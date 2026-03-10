use serde::Deserialize;
use anyhow::{Result, Context};
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSchema {
    pub schema_version: u32,
    pub defaults: Defaults,
    pub secrets: Vec<SecretDef>,
    pub features: Vec<FeatureDef>,
    pub provider_validation: ProviderValidation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    pub namespace: String,
    pub agent_name: String,
    #[serde(default)]
    pub resource_profile: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretDef {
    pub key: String,
    pub description: String,
    pub input_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub target_secrets: Vec<String>,
    #[serde(default)]
    pub auto_generate: Option<String>,
    #[serde(default)]
    pub choices: Option<Vec<Choice>>,
    #[serde(default)]
    pub depends_on: Option<Vec<String>>,
    #[serde(default)]
    pub validate: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(rename = "default", default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub silent: bool,
    #[serde(default)]
    pub secret_key_mapping: Option<SecretKeyMapping>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Choice {
    pub value: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretKeyMapping {
    pub file_basename: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDef {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub default_enabled: bool,
    #[serde(default)]
    pub secrets: Vec<SecretDef>,
    #[serde(default)]
    pub depends_on: Option<Vec<String>>,
    #[serde(default)]
    pub feature_flags: Option<HashMap<String, HashMap<String, String>>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderValidation {
    pub require_at_least_one: Vec<String>,
    pub message: String,
}

impl ConfigSchema {
    pub fn from_file(path: &std::path::Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read config schema: {}", path.display()))?;
        let schema: Self = serde_json::from_str(&content)
            .with_context(|| "Failed to parse config schema JSON")?;
        Ok(schema)
    }

    pub fn secrets_by_group(&self) -> HashMap<String, Vec<&SecretDef>> {
        let mut groups: HashMap<String, Vec<&SecretDef>> = HashMap::new();
        for secret in &self.secrets {
            let group = secret.group.clone().unwrap_or_else(|| "other".to_string());
            groups.entry(group).or_default().push(secret);
        }
        groups
    }
}
