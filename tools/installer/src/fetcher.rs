//! Runtime fetcher — downloads manifest, K8s YAML bundles, and OS files
//! from GitHub Releases at install time. No embedded assets.
//!
//! This module will be fully implemented in Task 9.

use anyhow::Result;
use std::path::{Path, PathBuf};

/// Fetch the release manifest JSON from GitHub for a given version.
/// If `version` is None, fetches the latest release.
pub async fn fetch_manifest(_version: Option<&str>) -> Result<String> {
    todo!("fetcher::fetch_manifest")
}

/// Download a tarball from `url`, verify its SHA256 against `expected_sha256`,
/// and extract it into `dest_dir`.
pub async fn download_and_extract(
    _url: &str,
    _expected_sha256: Option<&str>,
    _dest_dir: &Path,
) -> Result<PathBuf> {
    todo!("fetcher::download_and_extract")
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
