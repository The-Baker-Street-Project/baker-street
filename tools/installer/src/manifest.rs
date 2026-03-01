use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub schema_version: u32,
    pub version: String,
    pub date: String,
    pub min_sysadmin_version: String,
    pub release_notes: String,
    pub images: Vec<ManifestImage>,
    pub required_secrets: Vec<ManifestSecret>,
    pub optional_features: Vec<ManifestFeature>,
    pub defaults: ManifestDefaults,
    #[serde(default)]
    pub checksums: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestImage {
    pub component: String,
    pub image: String,
    pub version: String,
    pub digest: String,
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

/// Fetch the release manifest from the latest GitHub Release.
/// Falls back to `default_manifest()` if fetch fails.
pub async fn fetch_manifest(version: Option<&str>) -> anyhow::Result<ReleaseManifest> {
    let release_url = match version {
        Some(tag) => format!(
            "https://api.github.com/repos/The-Baker-Street-Project/baker-street/releases/tags/{}",
            tag
        ),
        None => "https://api.github.com/repos/The-Baker-Street-Project/baker-street/releases/latest".to_string(),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("bakerst-install")
        .build()?;

    let release: serde_json::Value = client.get(&release_url).send().await?.json().await?;

    // Find the release-manifest.json asset
    let assets = release["assets"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("no assets in release"))?;

    let manifest_asset = assets
        .iter()
        .find(|a| a["name"].as_str() == Some("release-manifest.json"))
        .ok_or_else(|| anyhow::anyhow!("release-manifest.json not found in release assets"))?;

    let download_url = manifest_asset["browser_download_url"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("no download URL for manifest"))?;

    let manifest: ReleaseManifest = client.get(download_url).send().await?.json().await?;
    Ok(manifest)
}

/// Load a manifest from a local file path.
pub fn load_manifest_from_file(path: &str) -> anyhow::Result<ReleaseManifest> {
    let content = std::fs::read_to_string(path)?;
    let manifest: ReleaseManifest = serde_json::from_str(&content)?;
    Ok(manifest)
}

/// Default manifest for when GitHub is unreachable (uses local :latest images).
pub fn default_manifest() -> ReleaseManifest {
    ReleaseManifest {
        schema_version: 1,
        version: "local".into(),
        date: chrono::Utc::now().to_rfc3339(),
        min_sysadmin_version: "0.0.0".into(),
        release_notes: "Local development deployment".into(),
        images: vec![
            image("brain", true),
            image("worker", true),
            image("ui", true),
            image("gateway", true),
            image("sysadmin", false),
            image("voice", false),
            image("ext-toolbox", false),
            image("ext-browser", false),
        ],
        required_secrets: vec![
            ManifestSecret {
                key: "ANTHROPIC_OAUTH_TOKEN".into(),
                description: "Anthropic OAuth token for Claude".into(),
                required: true,
                input_type: "secret".into(),
                target_secrets: vec!["bakerst-brain-secrets".into(), "bakerst-worker-secrets".into()],
            },
            ManifestSecret {
                key: "ANTHROPIC_API_KEY".into(),
                description: "Anthropic API key (fallback if no OAuth token)".into(),
                required: false,
                input_type: "secret".into(),
                target_secrets: vec!["bakerst-brain-secrets".into(), "bakerst-worker-secrets".into()],
            },
            ManifestSecret {
                key: "VOYAGE_API_KEY".into(),
                description: "Voyage AI API key for embeddings".into(),
                required: false,
                input_type: "secret".into(),
                target_secrets: vec!["bakerst-brain-secrets".into()],
            },
        ],
        optional_features: vec![
            ManifestFeature {
                id: "telegram".into(),
                name: "Telegram".into(),
                description: "Telegram bot gateway adapter".into(),
                default_enabled: false,
                secrets: vec!["TELEGRAM_BOT_TOKEN".into()],
            },
            ManifestFeature {
                id: "github".into(),
                name: "GitHub".into(),
                description: "GitHub extension for repo access".into(),
                default_enabled: false,
                secrets: vec!["GITHUB_TOKEN".into()],
            },
            ManifestFeature {
                id: "perplexity".into(),
                name: "Perplexity".into(),
                description: "Perplexity AI search and research tools".into(),
                default_enabled: false,
                secrets: vec!["PERPLEXITY_API_KEY".into()],
            },
            ManifestFeature {
                id: "browser".into(),
                name: "Browser".into(),
                description: "AI-driven browser automation extension".into(),
                default_enabled: false,
                secrets: vec![],
            },
            ManifestFeature {
                id: "obsidian".into(),
                name: "Obsidian".into(),
                description: "Obsidian vault extension".into(),
                default_enabled: false,
                secrets: vec!["OBSIDIAN_VAULT_PATH".into()],
            },
        ],
        defaults: ManifestDefaults {
            agent_name: "Baker".into(),
            namespace: "bakerst".into(),
            resource_profile: "standard".into(),
        },
        checksums: Default::default(),
    }
}

fn image(name: &str, required: bool) -> ManifestImage {
    ManifestImage {
        component: name.into(),
        image: format!("bakerst-{}:latest", name),
        version: "latest".into(),
        digest: String::new(),
        required,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_MANIFEST: &str = r#"{
        "schemaVersion": 1,
        "version": "0.1.0",
        "date": "2026-02-28T00:00:00Z",
        "minSysadminVersion": "0.1.0",
        "releaseNotes": "Test release",
        "images": [
            {"component": "brain", "image": "ghcr.io/test/brain:0.1.0", "version": "0.1.0", "digest": "sha256:abc", "required": true}
        ],
        "requiredSecrets": [
            {"key": "ANTHROPIC_OAUTH_TOKEN", "description": "OAuth token", "required": true, "inputType": "secret", "targetSecrets": ["bakerst-brain-secrets"]}
        ],
        "optionalFeatures": [
            {"id": "telegram", "name": "Telegram", "description": "Telegram bot", "defaultEnabled": false, "secrets": ["TELEGRAM_BOT_TOKEN"]}
        ],
        "defaults": {"agentName": "Baker", "namespace": "bakerst", "resourceProfile": "standard"},
        "checksums": {}
    }"#;

    #[test]
    fn parse_manifest_json() {
        let manifest: ReleaseManifest = serde_json::from_str(SAMPLE_MANIFEST).unwrap();
        assert_eq!(manifest.version, "0.1.0");
        assert_eq!(manifest.images.len(), 1);
        assert_eq!(manifest.images[0].component, "brain");
        assert!(manifest.images[0].required);
        assert_eq!(manifest.required_secrets.len(), 1);
        assert_eq!(manifest.required_secrets[0].key, "ANTHROPIC_OAUTH_TOKEN");
        assert_eq!(manifest.optional_features.len(), 1);
        assert_eq!(manifest.optional_features[0].id, "telegram");
    }

    #[test]
    fn default_manifest_has_required_images() {
        let m = default_manifest();
        assert_eq!(m.version, "local");
        let required: Vec<_> = m.images.iter().filter(|i| i.required).collect();
        assert_eq!(required.len(), 4); // brain, worker, ui, gateway
    }

    #[test]
    fn load_from_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("manifest.json");
        std::fs::write(&path, SAMPLE_MANIFEST).unwrap();
        let m = load_manifest_from_file(path.to_str().unwrap()).unwrap();
        assert_eq!(m.version, "0.1.0");
    }
}
