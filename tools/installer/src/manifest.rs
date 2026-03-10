use serde::{Deserialize, Serialize};
use anyhow::{Result, bail};

const MAX_SUPPORTED_SCHEMA: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub version: String,
    pub release_date: Option<String>,
    pub template_url: String,
    pub template_sha256: String,
    pub images: Vec<ManifestImage>,
    #[serde(default)]
    pub installers: Vec<ManifestInstaller>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ManifestImage {
    pub name: String,
    pub image: String,
    pub tag: String,
    pub required: bool,
    pub architectures: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ManifestInstaller {
    pub os: String,
    pub arch: String,
    pub url: String,
    pub sha256: String,
}

impl Manifest {
    pub fn check_schema_version(&self, max_supported: u32) -> Result<()> {
        if self.schema_version > max_supported {
            bail!(
                "Manifest schema version {} is newer than this installer supports (max: {}). \
                 Please download the latest installer.",
                self.schema_version, max_supported
            );
        }
        if self.schema_version == 0 {
            bail!("Invalid manifest: missing or zero schemaVersion");
        }
        Ok(())
    }

    pub fn required_images(&self) -> impl Iterator<Item = &ManifestImage> {
        self.images.iter().filter(|i| i.required)
    }

    pub fn from_json(json: &str) -> Result<Self> {
        let manifest: Self = serde_json::from_str(json)?;
        manifest.check_schema_version(MAX_SUPPORTED_SCHEMA)?;
        Ok(manifest)
    }

    pub fn from_file(path: &std::path::Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        Self::from_json(&content)
    }
}
