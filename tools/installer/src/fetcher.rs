//! Runtime fetcher — downloads manifest, template tarball, and OS files
//! from GitHub Releases at install time. No embedded assets.

use anyhow::{Result, Context, bail};
use std::path::{Path, PathBuf};
use crate::manifest::Manifest;

const GITHUB_API: &str = "https://api.github.com";
const REPO: &str = "The-Baker-Street-Project/baker-street";

/// Fetch the release manifest JSON from GitHub for a given version.
/// If `local_path` is provided, reads from the local file instead.
/// If `version` is None, fetches the latest release.
pub async fn fetch_manifest(
    local_path: Option<&Path>,
    version: Option<&str>,
) -> Result<Manifest> {
    if let Some(path) = local_path {
        tracing::info!("Loading manifest from local file: {}", path.display());
        return Manifest::from_file(path);
    }

    let release_url = match version {
        Some(v) => format!("{}/repos/{}/releases/tags/v{}", GITHUB_API, REPO, v),
        None => format!("{}/repos/{}/releases/latest", GITHUB_API, REPO),
    };

    tracing::info!("Fetching release info from: {}", release_url);
    let client = reqwest::Client::new();
    let release: serde_json::Value = client
        .get(&release_url)
        .header("User-Agent", "bakerst-install")
        .header("Accept", "application/vnd.github+json")
        .send().await?
        .error_for_status()
        .context("Failed to fetch release info from GitHub")?
        .json().await?;

    let assets = release["assets"].as_array()
        .context("No assets found in release")?;

    let manifest_asset = assets.iter()
        .find(|a| a["name"].as_str() == Some("manifest.json"))
        .context("manifest.json not found in release assets")?;

    let download_url = manifest_asset["browser_download_url"]
        .as_str()
        .context("No download URL for manifest.json")?;

    tracing::info!("Downloading manifest from: {}", download_url);
    let manifest_json = client
        .get(download_url)
        .header("User-Agent", "bakerst-install")
        .send().await?
        .text().await?;

    Manifest::from_json(&manifest_json)
}

/// Download the install template tarball, verify its SHA256, and extract it.
/// If a local manifest path was provided, looks for a sibling `install-template.tar.gz` first.
pub async fn fetch_template(
    manifest: &Manifest,
    local_manifest_path: Option<&Path>,
    dest: &Path,
) -> Result<PathBuf> {
    let template_path = dest.join("install-template");

    if let Some(manifest_path) = local_manifest_path {
        let local_template = manifest_path
            .parent().unwrap_or(Path::new("."))
            .join("install-template.tar.gz");
        if local_template.exists() {
            tracing::info!("Using local template: {}", local_template.display());
            extract_tarball(&local_template, dest)?;
            return Ok(template_path);
        }
    }

    let url = &manifest.template_url;
    tracing::info!("Downloading template from: {}", url);

    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header("User-Agent", "bakerst-install")
        .send().await?;

    if !response.status().is_success() {
        bail!("Failed to download template: HTTP {}", response.status());
    }

    let bytes = response.bytes().await?;

    if !manifest.template_sha256.is_empty() {
        verify_sha256(&bytes, &manifest.template_sha256)?;
    }

    let tarball_path = dest.join("install-template.tar.gz");
    std::fs::write(&tarball_path, &bytes)?;

    extract_tarball(&tarball_path, dest)?;
    Ok(template_path)
}

/// Extract a local install template tarball (for --template flag).
pub fn extract_template(tarball: &Path, dest: &Path) -> Result<PathBuf> {
    let template_path = dest.join("install-template");
    extract_tarball(tarball, dest)?;
    Ok(template_path)
}

/// Return the cache directory for downloaded assets (~/.bakerst/cache/).
pub fn cache_dir() -> Result<PathBuf> {
    let dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?
        .join(".bakerst")
        .join("cache");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn verify_sha256(data: &[u8], expected: &str) -> Result<()> {
    use sha2::{Sha256, Digest};
    let hash = hex::encode(Sha256::digest(data));
    if hash != expected {
        bail!(
            "Template checksum mismatch! Expected: {}, got: {}. \
             The download may be corrupted or tampered with.",
            expected, hash
        );
    }
    Ok(())
}

fn extract_tarball(tarball: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(tarball)?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(dest)?;
    Ok(())
}
