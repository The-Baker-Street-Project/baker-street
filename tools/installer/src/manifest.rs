use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub schema_version: u32,
    #[serde(default)]
    pub manifest_version: String,
    pub version: String,
    pub images: Vec<ManifestImage>,
    /// v2: top-level secrets (replaces v1 `requiredSecrets`)
    #[serde(alias = "requiredSecrets")]
    pub secrets: Vec<ManifestSecret>,
    /// v2: features with inline secrets and featureFlags (replaces v1 `optionalFeatures`)
    #[serde(alias = "optionalFeatures")]
    pub features: Vec<ManifestFeature>,
    pub defaults: ManifestDefaults,
    #[serde(default)]
    pub provider_validation: Option<ProviderValidation>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestImage {
    pub component: String,
    pub image: String,
    pub version: String,
    pub required: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSecret {
    pub key: String,
    pub description: String,
    #[serde(default)]
    pub required: bool,
    pub input_type: String,
    #[serde(default)]
    pub target_secrets: Vec<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub depends_on: Option<String>,
    #[serde(default)]
    pub auto_generate: Option<String>,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub silent: bool,
    #[serde(default)]
    pub choices: Vec<SecretChoice>,
    #[serde(default)]
    pub validate: Option<String>,
    #[serde(default)]
    pub secret_key_mapping: Option<SecretKeyMapping>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SecretChoice {
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
pub struct ManifestFeature {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_enabled: bool,
    /// v2: inline secret definitions. v1 compat: bare string list deserialized via custom impl.
    #[serde(deserialize_with = "deserialize_feature_secrets")]
    pub secrets: Vec<ManifestSecret>,
    #[serde(default)]
    pub feature_flags: Option<HashMap<String, HashMap<String, String>>>,
}

/// Deserialize feature secrets that can be either:
/// - v1: `["KEY1", "KEY2"]` (bare strings)
/// - v2: `[{ "key": "KEY1", ... }]` (full secret objects)
fn deserialize_feature_secrets<'de, D>(deserializer: D) -> Result<Vec<ManifestSecret>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum SecretOrString {
        Secret(ManifestSecret),
        Str(String),
    }

    let items: Vec<SecretOrString> = Vec::deserialize(deserializer)?;
    Ok(items
        .into_iter()
        .map(|item| match item {
            SecretOrString::Secret(s) => s,
            SecretOrString::Str(key) => ManifestSecret {
                key: key.clone(),
                description: key.clone(),
                required: false,
                input_type: if key.contains("TOKEN") || key.contains("KEY") {
                    "secret".into()
                } else {
                    "text".into()
                },
                target_secrets: Vec::new(),
                prompt: None,
                group: None,
                depends_on: None,
                auto_generate: None,
                default: None,
                placeholder: None,
                instructions: None,
                silent: false,
                choices: Vec::new(),
                validate: None,
                secret_key_mapping: None,
            },
        })
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestDefaults {
    pub agent_name: String,
    pub namespace: String,
    pub resource_profile: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderValidation {
    pub require_at_least_one: Vec<String>,
    pub message: String,
}

impl ReleaseManifest {
    /// Collect all secret keys defined in the manifest (top-level + feature secrets).
    pub fn all_secret_keys(&self) -> Vec<&str> {
        let mut keys: Vec<&str> = self.secrets.iter().map(|s| s.key.as_str()).collect();
        for feature in &self.features {
            for secret in &feature.secrets {
                if !keys.contains(&secret.key.as_str()) {
                    keys.push(&secret.key);
                }
            }
        }
        keys
    }

    /// Find the target secrets for a given key across all secret definitions.
    pub fn target_secrets_for(&self, key: &str) -> Vec<String> {
        for s in &self.secrets {
            if s.key == key {
                return s.target_secrets.clone();
            }
        }
        for feature in &self.features {
            for s in &feature.secrets {
                if s.key == key {
                    return s.target_secrets.clone();
                }
            }
        }
        Vec::new()
    }
}

const EMBEDDED_JSON: &str = include_str!("../release-manifest.json");

/// Parse the manifest embedded at compile time.
pub fn embedded_manifest() -> anyhow::Result<ReleaseManifest> {
    Ok(serde_json::from_str(EMBEDDED_JSON)?)
}

/// Load a manifest from a local file path (--manifest override).
pub fn load_manifest_from_file(path: &str) -> anyhow::Result<ReleaseManifest> {
    let content = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_parses() {
        let m = embedded_manifest().unwrap();
        assert!(!m.version.is_empty());
        assert_eq!(m.schema_version, 2);
        assert_eq!(m.manifest_version, "2.0.0");
    }

    #[test]
    fn embedded_manifest_has_required_images() {
        let m = embedded_manifest().unwrap();
        let required: Vec<_> = m.images.iter().filter(|i| i.required).collect();
        assert_eq!(required.len(), 4); // brain, worker, ui, gateway
    }

    #[test]
    fn embedded_manifest_has_anthropic_secret_optional() {
        let m = embedded_manifest().unwrap();
        let anthropic = m.secrets.iter().find(|s| s.key == "ANTHROPIC_API_KEY");
        assert!(anthropic.is_some(), "ANTHROPIC_API_KEY should exist in manifest");
        assert!(!anthropic.unwrap().required, "ANTHROPIC_API_KEY should not be required");
    }

    #[test]
    fn embedded_manifest_has_default_model_secret() {
        let m = embedded_manifest().unwrap();
        assert!(m.secrets.iter().any(|s| s.key == "DEFAULT_MODEL"));
    }

    #[test]
    fn default_model_has_choices() {
        let m = embedded_manifest().unwrap();
        let dm = m.secrets.iter().find(|s| s.key == "DEFAULT_MODEL").unwrap();
        assert!(!dm.choices.is_empty());
        assert_eq!(dm.choices[0].value, "claude-sonnet-4-20250514");
    }

    #[test]
    fn default_model_depends_on_anthropic() {
        let m = embedded_manifest().unwrap();
        let dm = m.secrets.iter().find(|s| s.key == "DEFAULT_MODEL").unwrap();
        assert_eq!(dm.depends_on.as_deref(), Some("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn embedded_manifest_has_openai_secret() {
        let m = embedded_manifest().unwrap();
        assert!(m.secrets.iter().any(|s| s.key == "OPENAI_API_KEY"));
    }

    #[test]
    fn embedded_manifest_has_ollama_endpoints() {
        let m = embedded_manifest().unwrap();
        assert!(m.secrets.iter().any(|s| s.key == "OLLAMA_ENDPOINTS"));
    }

    #[test]
    fn embedded_manifest_has_features() {
        let m = embedded_manifest().unwrap();
        assert!(!m.features.is_empty());
    }

    #[test]
    fn features_have_inline_secrets() {
        let m = embedded_manifest().unwrap();
        let telegram = m.features.iter().find(|f| f.id == "telegram").unwrap();
        assert!(!telegram.secrets.is_empty());
        assert_eq!(telegram.secrets[0].key, "TELEGRAM_BOT_TOKEN");
        assert!(!telegram.secrets[0].target_secrets.is_empty());
    }

    #[test]
    fn features_have_feature_flags() {
        let m = embedded_manifest().unwrap();
        let telegram = m.features.iter().find(|f| f.id == "telegram").unwrap();
        let flags = telegram.feature_flags.as_ref().unwrap();
        assert_eq!(flags["brain"]["FEATURE_TELEGRAM"], "true");
        assert_eq!(flags["gateway"]["FEATURE_TELEGRAM"], "true");
    }

    #[test]
    fn google_workspace_has_instructions() {
        let m = embedded_manifest().unwrap();
        let gw = m.features.iter().find(|f| f.id == "google-workspace").unwrap();
        let client_id = gw.secrets.iter().find(|s| s.key == "GOOGLE_OAUTH_CLIENT_ID").unwrap();
        assert!(client_id.instructions.is_some());
    }

    #[test]
    fn google_workspace_has_silent_cred_file() {
        let m = embedded_manifest().unwrap();
        let gw = m.features.iter().find(|f| f.id == "google-workspace").unwrap();
        let cred = gw.secrets.iter().find(|s| s.key == "GOOGLE_CREDENTIAL_FILE").unwrap();
        assert!(cred.silent);
        assert!(cred.secret_key_mapping.is_some());
    }

    #[test]
    fn auth_token_has_auto_generate() {
        let m = embedded_manifest().unwrap();
        let auth = m.secrets.iter().find(|s| s.key == "AUTH_TOKEN").unwrap();
        assert_eq!(auth.auto_generate.as_deref(), Some("hex:32"));
    }

    #[test]
    fn provider_validation_present() {
        let m = embedded_manifest().unwrap();
        let pv = m.provider_validation.as_ref().unwrap();
        assert_eq!(pv.require_at_least_one.len(), 3);
    }

    #[test]
    fn all_secret_keys_includes_features() {
        let m = embedded_manifest().unwrap();
        let keys = m.all_secret_keys();
        assert!(keys.contains(&"ANTHROPIC_API_KEY"));
        assert!(keys.contains(&"TELEGRAM_BOT_TOKEN"));
        assert!(keys.contains(&"GITHUB_TOKEN"));
    }

    #[test]
    fn target_secrets_for_works() {
        let m = embedded_manifest().unwrap();
        let targets = m.target_secrets_for("ANTHROPIC_API_KEY");
        assert!(targets.contains(&"bakerst-brain-secrets".to_string()));
        assert!(targets.contains(&"bakerst-worker-secrets".to_string()));
    }

    #[test]
    fn target_secrets_for_feature_secret() {
        let m = embedded_manifest().unwrap();
        let targets = m.target_secrets_for("TELEGRAM_BOT_TOKEN");
        assert!(targets.contains(&"bakerst-gateway-secrets".to_string()));
    }

    #[test]
    fn load_from_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("manifest.json");
        std::fs::write(&path, EMBEDDED_JSON).unwrap();
        let m = load_manifest_from_file(path.to_str().unwrap()).unwrap();
        assert!(!m.version.is_empty());
    }
}
