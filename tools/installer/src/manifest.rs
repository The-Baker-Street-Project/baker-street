use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub schema_version: u32,
    pub version: String,
    pub images: Vec<ManifestImage>,
    pub required_secrets: Vec<ManifestSecret>,
    pub optional_features: Vec<ManifestFeature>,
    pub defaults: ManifestDefaults,
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
    pub required: bool,
    pub input_type: String,
    pub target_secrets: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFeature {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_enabled: bool,
    pub secrets: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestDefaults {
    pub agent_name: String,
    pub namespace: String,
    pub resource_profile: String,
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
    }

    #[test]
    fn embedded_manifest_has_required_images() {
        let m = embedded_manifest().unwrap();
        let required: Vec<_> = m.images.iter().filter(|i| i.required).collect();
        assert_eq!(required.len(), 4); // brain, worker, ui, gateway
    }

    #[test]
    fn embedded_manifest_has_anthropic_secret() {
        let m = embedded_manifest().unwrap();
        assert!(m.required_secrets.iter().any(|s| s.key == "ANTHROPIC_API_KEY"));
    }

    #[test]
    fn embedded_manifest_has_default_model_secret() {
        let m = embedded_manifest().unwrap();
        assert!(m.required_secrets.iter().any(|s| s.key == "DEFAULT_MODEL"));
    }

    #[test]
    fn embedded_manifest_has_openai_secret() {
        let m = embedded_manifest().unwrap();
        assert!(m.required_secrets.iter().any(|s| s.key == "OPENAI_API_KEY"));
    }

    #[test]
    fn embedded_manifest_has_ollama_endpoints() {
        let m = embedded_manifest().unwrap();
        assert!(m.required_secrets.iter().any(|s| s.key == "OLLAMA_ENDPOINTS"));
    }

    #[test]
    fn embedded_manifest_has_features() {
        let m = embedded_manifest().unwrap();
        assert!(!m.optional_features.is_empty());
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
