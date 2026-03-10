use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub schema_version: u32,
    #[serde(default)]
    pub manifest_version: String,
    pub version: String,
    /// Registry prefix for pulling images (e.g. "ghcr.io/the-baker-street-project").
    #[serde(default)]
    pub registry: Option<String>,
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
    /// URL to the K8s manifests tarball for this version
    #[serde(default)]
    pub manifests_url: Option<String>,
    /// URL to the operating system files tarball for this version
    #[serde(default)]
    pub os_files_url: Option<String>,
    /// SHA256 checksum for the manifests tarball
    #[serde(default)]
    pub manifests_sha256: Option<String>,
    /// SHA256 checksum for the OS files tarball
    #[serde(default)]
    pub os_files_sha256: Option<String>,
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
    /// Resolve an image name by prepending the registry prefix (if configured).
    pub fn resolve_image(&self, image: &str) -> String {
        match &self.registry {
            Some(registry) if !registry.is_empty() => format!("{}/{}", registry, image),
            _ => image.to_string(),
        }
    }

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

/// Load a manifest from a JSON string.
pub fn parse_manifest(json: &str) -> anyhow::Result<ReleaseManifest> {
    Ok(serde_json::from_str(json)?)
}

/// Load a manifest from a local file path.
pub fn load_manifest_from_file(path: &std::path::Path) -> anyhow::Result<ReleaseManifest> {
    let content = std::fs::read_to_string(path)?;
    parse_manifest(&content)
}
