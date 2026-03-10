# Build, Release & Installer Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the entire build/release/installer pipeline with a clean-slate design: dumb Rust installer that fetches a versioned manifest, native multi-arch CI builds, and an acceptance test gate that blocks broken releases.

**Architecture:** Three release artifacts (manifest.json, install-template.tar.gz, installer binaries) produced by a linear CI pipeline with an acceptance test gate. The installer has zero embedded knowledge — it fetches the manifest at runtime, downloads the template, walks the user through config, applies K8s manifests, and verifies the deployment. Dev workflow uses a simplified `deploy-all.sh` that shares the same K8s manifests but builds from source.

**Tech Stack:** Rust (installer binary), GitHub Actions (CI/CD), Kustomize (K8s manifests), kind (acceptance testing), Telegram Bot API (notifications)

**Design Doc:** `docs/plans/2026-03-10-build-release-installer-redesign.md`

---

## Phase 1: K8s Manifest Cleanup

Clean up the existing K8s manifests so they can be bundled into the install template tarball. Fix hardcoded paths, add kustomize overlays for different image pull strategies.

### Task 1: Fix hardcoded hostPaths in K8s manifests

**Files:**
- Modify: `k8s/brain/deployment-blue.yaml`
- Modify: `k8s/brain/deployment-green.yaml`
- Modify: `k8s/gateway/deployment.yaml`
- Modify: `k8s/qdrant/deployment.yaml`

**Step 1: Replace hardcoded hostPaths with emptyDir defaults**

The current manifests hardcode `/Users/gary/bakerst-data` (macOS-specific). Change all `hostPath` volumes to `emptyDir` as the default. The installer will patch these via kustomize overlay if the user wants persistent storage.

In `k8s/brain/deployment-blue.yaml` and `deployment-green.yaml`, change the `data` volume from:
```yaml
- name: data
  hostPath:
    path: /Users/gary/bakerst-data
    type: DirectoryOrCreate
```
to:
```yaml
- name: data
  emptyDir: {}
```

In `k8s/gateway/deployment.yaml`, same change for the `data` volume.

In `k8s/qdrant/deployment.yaml`, change the `data` volume from:
```yaml
- name: data
  hostPath:
    path: /Users/gary/bakerst-qdrant
    type: DirectoryOrCreate
```
to:
```yaml
- name: data
  emptyDir: {}
```

**Step 2: Verify kustomize still builds**

Run: `kubectl kustomize k8s/`
Expected: Valid YAML output, no errors about missing paths.

**Step 3: Commit**
```bash
git add k8s/brain/ k8s/gateway/deployment.yaml k8s/qdrant/deployment.yaml
git commit -m "fix(k8s): replace hardcoded hostPaths with emptyDir defaults"
```

---

### Task 2: Add kustomize overlay for GHCR image pull

**Files:**
- Create: `k8s/overlays/remote/kustomization.yaml`

**Step 1: Create the remote overlay**

This overlay patches all deployments to use `imagePullPolicy: IfNotPresent` and full GHCR image references. The installer will use this overlay; local dev uses the base (which keeps `imagePullPolicy: Never` and short image names).

Create `k8s/overlays/remote/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../

patches:
  - target:
      kind: Deployment
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/imagePullPolicy
        value: IfNotPresent
```

Note: The installer will further patch image names using kustomize's `images` transformer to set the correct GHCR tags from the manifest.

**Step 2: Verify overlay builds**

Run: `kubectl kustomize k8s/overlays/remote/`
Expected: Valid YAML with `imagePullPolicy: IfNotPresent` on all deployments.

**Step 3: Commit**
```bash
git add k8s/overlays/remote/
git commit -m "feat(k8s): add remote overlay for GHCR image pull"
```

---

### Task 3: Add extensions to kustomize structure

**Files:**
- Create: `k8s/extensions/toolbox/kustomization.yaml`
- Create: `k8s/extensions/browser/kustomization.yaml`
- Create: `k8s/extensions/google-workspace/kustomization.yaml`
- Create: `k8s/extensions/github/kustomization.yaml`
- Move/copy deployment manifests from `examples/extension-*/k8s/` to `k8s/extensions/*/`

**Step 1: Create extension kustomizations**

Move each extension's K8s manifests into the `k8s/extensions/` directory with proper kustomization files. Each extension gets its own kustomization so the installer can selectively include them.

For each extension (toolbox, browser, google-workspace, github), create a kustomization.yaml:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: bakerst

resources:
  - deployment.yaml
```

Copy the deployment.yaml from `examples/extension-<name>/k8s/deployment.yaml` to `k8s/extensions/<name>/deployment.yaml`.

**Step 2: Verify each extension builds independently**

Run for each: `kubectl kustomize k8s/extensions/toolbox/` (etc.)
Expected: Valid YAML for each extension.

**Step 3: Update the existing deploy scripts to reference the new paths**

In `scripts/deploy-all.sh`, update extension deployment paths from `examples/extension-*/k8s/` to `k8s/extensions/*/`. This keeps existing dev workflow working during the transition.

**Step 4: Commit**
```bash
git add k8s/extensions/
git commit -m "feat(k8s): add extension manifests to kustomize structure"
```

---

### Task 4: Remove hardcoded voice service IPs

**Files:**
- Modify: `k8s/voice/deployment.yaml`

**Step 1: Replace hardcoded IPs with configurable env vars**

The voice deployment has hardcoded `WHISPER_URL=http://host.docker.internal:8083` and `TTS_BASE_URL=http://192.168.4.42:8084`. These should come from the secret/configmap so they're configurable per install.

Move `WHISPER_URL` and `TTS_BASE_URL` to be sourced from `bakerst-voice-secrets` (optional). Keep sane defaults only if the env vars are not set (the service code should handle this, not the manifest).

Remove the hardcoded env vars from the deployment. They'll be injected via the voice secrets when the user configures voice.

**Step 2: Verify kustomize still builds**

Run: `kubectl kustomize k8s/`
Expected: Valid YAML.

**Step 3: Commit**
```bash
git add k8s/voice/deployment.yaml
git commit -m "fix(k8s): remove hardcoded IPs from voice deployment"
```

---

## Phase 2: Artifact Schema & Generation

Define the manifest.json and config-schema.json formats, and create the tooling to generate them.

### Task 5: Create config-schema.json

**Files:**
- Create: `tools/install-template/config-schema.json`

**Step 1: Write the config schema**

This file drives the installer's interactive interview. It defines all secrets, features, defaults, and validation rules. Source the complete list from the current `release-manifest.json` (417 lines) and `scripts/secrets.sh`.

Create `tools/install-template/config-schema.json` with:
- `schemaVersion: 1`
- `defaults`: namespace (bakerst), agentName (Baker)
- `secrets[]`: every secret with key, description, inputType, required, group, targetSecrets, autoGenerate, choices, dependsOn, validate
- `features[]`: telegram, discord, voyage, github, obsidian, voice, google-workspace — each with dependsOn secrets and enables (which services/extensions to deploy)
- `providerValidation`: atLeastOne of ANTHROPIC_API_KEY, OPENAI_API_KEY, OLLAMA_ENDPOINTS

Groups for secrets:
- `providers` — ANTHROPIC_API_KEY, DEFAULT_MODEL, WORKER_MODEL, OPENAI_API_KEY, OLLAMA_ENDPOINTS
- `core` — AUTH_TOKEN (autoGenerate: hex:32), AGENT_NAME
- `memory` — VOYAGE_API_KEY

Refer to `tools/installer/release-manifest.json` for the complete secret definitions with targetSecrets mappings, choices, and validation rules. Port all of them.

**Step 2: Validate JSON is parseable**

Run: `python3 -c "import json; json.load(open('tools/install-template/config-schema.json'))"`
Expected: No error.

**Step 3: Commit**
```bash
git add tools/install-template/config-schema.json
git commit -m "feat(installer): create config-schema.json for install interview"
```

---

### Task 6: Create manifest generation script

**Files:**
- Create: `scripts/generate-manifest.sh`

**Step 1: Write the manifest generator**

This script runs in CI after images are built. It queries GHCR for actual image availability and architectures, then produces `manifest.json`.

Inputs (environment variables):
- `VERSION` — release version (from git tag)
- `GITHUB_REPOSITORY` — org/repo
- `SERVICES` — space-separated list of service names that were built

The script:
1. For each service, query `docker manifest inspect ghcr.io/the-baker-street-project/bakerst-<name>:<version>` to get available architectures
2. Build the manifest JSON with `jq`:
   - `schemaVersion: 1`
   - `version: $VERSION`
   - `releaseDate: $(date -u +%Y-%m-%dT%H:%M:%SZ)`
   - `templateUrl: https://github.com/$GITHUB_REPOSITORY/releases/download/v$VERSION/install-template.tar.gz`
   - `images[]`: one entry per service with name, image, tag, required flag, architectures
   - `installers[]`: one entry per binary with os, arch, url, sha256
3. Write to `manifest.json`

Required images (hardcode in script): brain, worker, ui, nats-sidecar
Optional images: gateway, sysadmin, voice, ext-toolbox, ext-browser, ext-google-workspace

**Step 2: Test locally with a mock**

Run: `VERSION=0.0.1-test GITHUB_REPOSITORY=test/test SERVICES="brain worker ui" bash scripts/generate-manifest.sh`
Expected: Produces valid JSON (will show missing images since they're not in GHCR, but structure is correct).

**Step 3: Commit**
```bash
git add scripts/generate-manifest.sh
git commit -m "feat(ci): add manifest generation script"
```

---

### Task 7: Create template bundling script

**Files:**
- Create: `scripts/bundle-template.sh`

**Step 1: Write the template bundler**

This script runs in CI to create `install-template.tar.gz`. It:
1. Creates a temp directory `install-template/`
2. Copies `tools/install-template/config-schema.json` into it
3. Copies the `k8s/` directory into it (including base, overlays, extensions)
4. Copies `operating_system/` directory into it (personality files for ConfigMap)
5. Creates `tar -czf install-template.tar.gz -C <tmpdir> install-template/`

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VERSION:-dev}"
OUTPUT="${OUTPUT:-install-template.tar.gz}"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

mkdir -p "$tmpdir/install-template"

# Config schema
cp "$REPO_ROOT/tools/install-template/config-schema.json" "$tmpdir/install-template/"

# K8s manifests (full kustomize structure)
cp -r "$REPO_ROOT/k8s" "$tmpdir/install-template/k8s"

# Operating system files (for ConfigMap)
cp -r "$REPO_ROOT/operating_system" "$tmpdir/install-template/operating_system"

# Version stamp
echo "$VERSION" > "$tmpdir/install-template/VERSION"

tar -czf "$OUTPUT" -C "$tmpdir" install-template/

echo "Created $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
```

**Step 2: Test locally**

Run: `VERSION=0.0.1-test bash scripts/bundle-template.sh`
Expected: Creates `install-template.tar.gz`, extracts cleanly with expected structure.

Verify: `tar -tzf install-template.tar.gz | head -20`
Expected: Shows `install-template/config-schema.json`, `install-template/k8s/kustomization.yaml`, etc.

**Step 3: Commit**
```bash
git add scripts/bundle-template.sh
git commit -m "feat(ci): add template bundling script"
```

---

## Phase 3: Installer Rewrite

Rewrite the Rust installer from scratch. Reuse proven modules (k8s.rs, health.rs, images.rs) but restructure everything else around the "dumb" architecture.

### Task 8: Scaffold new installer structure

**Files:**
- Modify: `tools/installer/Cargo.toml` (update deps, bump version to 0.3.0)
- Rewrite: `tools/installer/src/main.rs`
- Rewrite: `tools/installer/src/cli.rs`
- Rewrite: `tools/installer/src/lib.rs`
- Delete: `tools/installer/release-manifest.json` (no longer embedded)
- Delete: `tools/installer/src/templates/` (K8s templates no longer embedded)
- Delete: `tools/installer/src/os_files/` (OS files no longer embedded)

**Step 1: Update Cargo.toml**

Bump version to `0.3.0`. Add new dependencies:
- `reqwest` (with `rustls-tls` feature) — for HTTP downloads
- `flate2` — for gzip decompression
- `tar` — for tarball extraction
- `sha2` — for checksum verification
- `indicatif` — for download progress bars (simpler than ratatui for non-TUI progress)

Remove:
- `rand` (no longer generating tokens in binary — config schema handles autoGenerate)

Keep all existing deps (kube, tokio, ratatui, crossterm, clap, serde, etc.)

**Step 2: Rewrite lib.rs**

```rust
pub mod cli;
pub mod manifest;
pub mod config_schema;
pub mod config_file;
pub mod fetcher;
pub mod k8s;
pub mod health;
pub mod images;
pub mod interview;
pub mod app;
pub mod tui;
pub mod verify;
```

**Step 3: Rewrite cli.rs**

New CLI structure with clap derive:
```rust
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "bakerst-install", version, about = "Baker Street Installer")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,

    /// Kubernetes namespace
    #[arg(long, default_value = "bakerst")]
    pub namespace: String,

    /// Enable verbose logging
    #[arg(short, long)]
    pub verbose: bool,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Install Baker Street (default)
    Install(InstallArgs),
    /// Check deployment status
    Status(StatusArgs),
    /// Update to latest version
    Update(UpdateArgs),
    /// Remove Baker Street
    Uninstall(UninstallArgs),
}

#[derive(clap::Args)]
pub struct InstallArgs {
    /// Path to config file (skip interactive interview)
    #[arg(long)]
    pub config: Option<PathBuf>,

    /// Path to local manifest file (skip GitHub fetch)
    #[arg(long)]
    pub manifest: Option<PathBuf>,

    /// Install specific version (default: latest)
    #[arg(long)]
    pub version: Option<String>,

    /// Path for structured JSON log
    #[arg(long, default_value = "bakerst-install.log")]
    pub log: PathBuf,

    /// Fail on missing required values instead of prompting
    #[arg(long)]
    pub non_interactive: bool,

    /// Show what would be applied without applying
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(clap::Args)]
pub struct StatusArgs {
    /// Output as JSON
    #[arg(long)]
    pub json: bool,

    /// Watch mode (poll every 5s)
    #[arg(long)]
    pub watch: bool,
}

#[derive(clap::Args)]
pub struct UpdateArgs {
    /// Skip confirmation prompt
    #[arg(long, short = 'y')]
    pub non_interactive: bool,

    /// Reconfigure secrets (re-run interview)
    #[arg(long)]
    pub reconfigure: bool,
}

#[derive(clap::Args)]
pub struct UninstallArgs {
    /// Skip confirmation prompt
    #[arg(long, short = 'y')]
    pub non_interactive: bool,
}
```

**Step 4: Rewrite main.rs**

```rust
mod cli;
mod manifest;
mod config_schema;
mod config_file;
mod fetcher;
mod k8s;
mod health;
mod images;
mod interview;
mod app;
mod tui;
mod verify;

use clap::Parser;
use anyhow::Result;
use tracing_subscriber::{fmt, EnvFilter};
use std::fs;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = cli::Cli::parse();

    // Ensure ~/.bakerst/ exists
    let bakerst_dir = dirs::home_dir()
        .expect("Cannot determine home directory")
        .join(".bakerst");
    fs::create_dir_all(&bakerst_dir)?;

    // Setup logging
    let log_file = if let Some(cli::Commands::Install(ref args)) = cli.command {
        args.log.clone()
    } else {
        bakerst_dir.join("install.log")
    };

    let file_appender = tracing_appender::rolling::never(
        log_file.parent().unwrap_or(".".as_ref()),
        log_file.file_name().unwrap_or("install.log".as_ref()),
    );
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| if cli.verbose { "debug".into() } else { "info".into() })
        )
        .with_writer(non_blocking)
        .json()
        .init();

    // Setup panic hook for terminal cleanup
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let _ = crossterm::terminal::disable_raw_mode();
        let _ = crossterm::execute!(
            std::io::stderr(),
            crossterm::terminal::LeaveAlternateScreen
        );
        original_hook(panic_info);
    }));

    match cli.command.unwrap_or(cli::Commands::Install(cli::InstallArgs::default())) {
        cli::Commands::Install(args) => cmd_install::run(&cli, args).await,
        cli::Commands::Status(args) => cmd_status::run(&cli, args).await,
        cli::Commands::Update(args) => cmd_update::run(&cli, args).await,
        cli::Commands::Uninstall(args) => cmd_uninstall::run(&cli, args).await,
    }
}
```

Note: `InstallArgs` needs `Default` derive or manual impl for the default command case.

**Step 5: Delete embedded files**

```bash
rm tools/installer/release-manifest.json
rm -rf tools/installer/src/templates/
rm -rf tools/installer/src/os_files/
```

**Step 6: Verify it compiles (with stubs)**

Create stub modules for any referenced but not-yet-written modules. Each stub just has a `// TODO` comment.

Run: `cd tools/installer && cargo check`
Expected: Compiles (with warnings about unused modules).

**Step 7: Commit**
```bash
git add tools/installer/
git commit -m "feat(installer): scaffold new dumb installer structure"
```

---

### Task 9: Implement manifest fetcher

**Files:**
- Create: `tools/installer/src/manifest.rs` (new, replaces old)
- Create: `tools/installer/src/fetcher.rs`
- Create: `tools/installer/tests/manifest_test.rs`

**Step 1: Write failing tests for manifest parsing**

```rust
// tests/manifest_test.rs
use bakerst_install::manifest::{Manifest, ManifestImage};

#[test]
fn test_parse_manifest() {
    let json = r#"{
        "schemaVersion": 1,
        "version": "0.6.0",
        "releaseDate": "2026-03-10T00:00:00Z",
        "templateUrl": "https://example.com/template.tar.gz",
        "images": [{
            "name": "bakerst-brain",
            "image": "ghcr.io/the-baker-street-project/bakerst-brain",
            "tag": "0.6.0",
            "required": true,
            "architectures": ["amd64", "arm64"]
        }],
        "installers": [{
            "os": "linux",
            "arch": "amd64",
            "url": "https://example.com/installer",
            "sha256": "abc123"
        }]
    }"#;
    let manifest: Manifest = serde_json::from_str(json).unwrap();
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.version, "0.6.0");
    assert_eq!(manifest.images.len(), 1);
    assert_eq!(manifest.images[0].architectures, vec!["amd64", "arm64"]);
}

#[test]
fn test_schema_version_check() {
    let manifest = Manifest {
        schema_version: 99,
        ..Default::default()
    };
    assert!(manifest.check_schema_version(1).is_err());
}

#[test]
fn test_required_images() {
    let manifest = Manifest {
        images: vec![
            ManifestImage { name: "brain".into(), required: true, ..Default::default() },
            ManifestImage { name: "voice".into(), required: false, ..Default::default() },
        ],
        ..Default::default()
    };
    let required: Vec<_> = manifest.required_images().collect();
    assert_eq!(required.len(), 1);
    assert_eq!(required[0].name, "brain");
}
```

**Step 2: Run tests to verify they fail**

Run: `cd tools/installer && cargo test`
Expected: Compilation errors (types don't exist yet).

**Step 3: Implement manifest.rs**

```rust
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
                self.schema_version,
                max_supported
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
```

**Step 4: Implement fetcher.rs**

```rust
use anyhow::{Result, Context, bail};
use std::path::{Path, PathBuf};
use crate::manifest::Manifest;

const GITHUB_API: &str = "https://api.github.com";
const REPO: &str = "The-Baker-Street-Project/baker-street";

/// Fetch manifest from GitHub latest release, a specific version, or a local file.
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
        .send()
        .await?
        .json()
        .await?;

    // Find manifest.json in release assets
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
        .send()
        .await?
        .text()
        .await?;

    Manifest::from_json(&manifest_json)
}

/// Download and extract the install template tarball.
pub async fn fetch_template(
    manifest: &Manifest,
    local_manifest_path: Option<&Path>,
    dest: &Path,
) -> Result<PathBuf> {
    let template_path = dest.join("install-template");

    // If using local manifest, look for template relative to it
    if let Some(manifest_path) = local_manifest_path {
        let local_template = manifest_path
            .parent()
            .unwrap_or(Path::new("."))
            .join("install-template.tar.gz");
        if local_template.exists() {
            tracing::info!("Using local template: {}", local_template.display());
            extract_tarball(&local_template, dest)?;
            return Ok(template_path);
        }
    }

    // Download from URL in manifest
    let url = &manifest.template_url;
    tracing::info!("Downloading template from: {}", url);

    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header("User-Agent", "bakerst-install")
        .send()
        .await?;

    if !response.status().is_success() {
        bail!("Failed to download template: HTTP {}", response.status());
    }

    let bytes = response.bytes().await?;
    let tarball_path = dest.join("install-template.tar.gz");
    std::fs::write(&tarball_path, &bytes)?;

    extract_tarball(&tarball_path, dest)?;
    Ok(template_path)
}

fn extract_tarball(tarball: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(tarball)?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(dest)?;
    Ok(())
}
```

**Step 5: Run tests to verify they pass**

Run: `cd tools/installer && cargo test`
Expected: All manifest tests pass.

**Step 6: Commit**
```bash
git add tools/installer/src/manifest.rs tools/installer/src/fetcher.rs tools/installer/tests/
git commit -m "feat(installer): implement manifest parsing and remote fetching"
```

---

### Task 10: Implement config schema parser and interview engine

**Files:**
- Create: `tools/installer/src/config_schema.rs`
- Create: `tools/installer/src/interview.rs`
- Create: `tools/installer/tests/config_schema_test.rs`

**Step 1: Write failing tests**

Test that config-schema.json can be parsed, secrets are grouped, features resolve dependencies, and providerValidation works.

**Step 2: Implement config_schema.rs**

Types for the config schema:
```rust
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
pub struct SecretDef {
    pub key: String,
    pub description: String,
    pub input_type: String,        // "password", "text", "choice"
    pub required: bool,
    pub group: Option<String>,
    pub target_secrets: Vec<String>,
    pub auto_generate: Option<String>,  // "hex:32"
    pub choices: Option<Vec<Choice>>,
    pub depends_on: Option<String>,
    pub validate: Option<String>,
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDef {
    pub key: String,
    pub description: String,
    pub depends_on: Vec<String>,  // secret keys that must be set
    pub enables: Vec<String>,     // services/extensions to deploy
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderValidation {
    pub at_least_one: Vec<String>,
    pub message: String,
}
```

**Step 3: Implement interview.rs**

The interview engine:
- Takes a `ConfigSchema` and an optional pre-filled `ConfigFile`
- For each secret in order: if pre-filled, use it; if autoGenerate, generate; otherwise prompt
- Group secrets by `group` field for organized prompting
- After secrets, present features as toggles
- Validate providerValidation constraint
- Return a `HashMap<String, String>` of collected values + a `Vec<String>` of enabled features

Key function:
```rust
pub async fn run_interview(
    schema: &ConfigSchema,
    prefilled: Option<&ConfigFile>,
    non_interactive: bool,
) -> Result<InterviewResult> { ... }

pub struct InterviewResult {
    pub secrets: HashMap<String, String>,
    pub enabled_features: Vec<String>,
    pub namespace: String,
}
```

For non-interactive mode: use prefilled values, auto-generate where specified, fail if required values are missing.

**Step 4: Run tests**

Run: `cd tools/installer && cargo test`
Expected: Pass.

**Step 5: Commit**
```bash
git add tools/installer/src/config_schema.rs tools/installer/src/interview.rs tools/installer/tests/
git commit -m "feat(installer): implement config schema parser and interview engine"
```

---

### Task 11: Implement K8s context detection and selection

**Files:**
- Modify: `tools/installer/src/k8s.rs`
- Create: `tools/installer/tests/k8s_context_test.rs`

**Step 1: Add context detection to k8s.rs**

Reuse the existing `k8s.rs` module but add context detection and selection:

```rust
/// Detect available K8s contexts
pub async fn detect_contexts() -> Result<Vec<K8sContext>> {
    let output = tokio::process::Command::new("kubectl")
        .args(["config", "get-contexts", "-o", "name"])
        .output()
        .await?;

    if !output.status.success() {
        bail!("kubectl not found or not configured. Install kubectl and configure a Kubernetes cluster.");
    }

    let contexts: Vec<K8sContext> = String::from_utf8(output.stdout)?
        .lines()
        .filter(|l| !l.is_empty())
        .map(|name| K8sContext {
            name: name.to_string(),
            cluster_type: classify_context(name),
        })
        .collect();

    Ok(contexts)
}

fn classify_context(name: &str) -> ClusterType {
    if name.contains("docker-desktop") { ClusterType::DockerDesktop }
    else if name.contains("orbstack") || name.contains("orb") { ClusterType::OrbStack }
    else if name.contains("minikube") { ClusterType::Minikube }
    else if name.contains("kind") { ClusterType::Kind }
    else if name.contains("rancher") { ClusterType::RancherDesktop }
    else { ClusterType::Other }
}

/// Switch to a specific K8s context
pub async fn use_context(name: &str) -> Result<()> {
    let status = tokio::process::Command::new("kubectl")
        .args(["config", "use-context", name])
        .status()
        .await?;
    if !status.success() {
        bail!("Failed to switch to context: {}", name);
    }
    Ok(())
}
```

Preserve all existing functions from the current `k8s.rs` (apply_yaml, create_secret, create_namespace, etc.) — they're well-written and standalone.

**Step 2: Run tests**

Run: `cd tools/installer && cargo test`
Expected: Pass (context tests may need to be integration tests that require kubectl).

**Step 3: Commit**
```bash
git add tools/installer/src/k8s.rs tools/installer/tests/
git commit -m "feat(installer): add K8s context detection and selection"
```

---

### Task 12: Implement the install command orchestrator

**Files:**
- Rewrite: `tools/installer/src/cmd_install.rs`
- Modify: `tools/installer/src/app.rs` (simplify state)

**Step 1: Simplify app.rs state**

The current `app.rs` has 60+ fields. Simplify to match the new 10-step flow:

```rust
pub enum Phase {
    Preflight,
    FetchManifest,
    DownloadTemplate,
    Configure,
    PullImages,
    Apply,
    Verify,
    Complete,
    Failed,
}

pub struct App {
    pub phase: Phase,
    pub manifest: Option<Manifest>,
    pub config: Option<InterviewResult>,
    pub template_dir: Option<PathBuf>,
    pub k8s_context: Option<String>,
    pub namespace: String,
    pub log_entries: Vec<LogEntry>,
    pub errors: Vec<String>,
    pub dry_run: bool,
}
```

**Step 2: Rewrite cmd_install.rs**

The new install command is a linear pipeline, not a complex state machine:

```rust
pub async fn run(cli: &Cli, args: InstallArgs) -> Result<()> {
    // 1. Preflight: detect kubectl, K8s contexts, ask user to pick
    let contexts = k8s::detect_contexts().await?;
    if contexts.is_empty() {
        bail!("No Kubernetes contexts found. Install Docker Desktop or OrbStack with Kubernetes enabled.");
    }
    let selected = if contexts.len() == 1 {
        &contexts[0]
    } else {
        // Ask user to pick
        prompt_context_selection(&contexts)?
    };
    k8s::use_context(&selected.name).await?;

    // 2. Fetch manifest
    let manifest = fetcher::fetch_manifest(
        args.manifest.as_deref(),
        args.version.as_deref(),
    ).await?;

    // 3. Download and extract template
    let work_dir = tempfile::tempdir()?;
    let template_dir = fetcher::fetch_template(
        &manifest,
        args.manifest.as_deref(),
        work_dir.path(),
    ).await?;

    // 4. Load config schema from template
    let schema_path = template_dir.join("config-schema.json");
    let schema = ConfigSchema::from_file(&schema_path)?;

    // 5. Configure (interview or config file)
    let config = if let Some(config_path) = &args.config {
        let file = ConfigFile::load(config_path)?;
        interview::from_config_file(&schema, &file)?
    } else if args.non_interactive {
        interview::from_env(&schema)?
    } else {
        interview::run_interactive(&schema).await?
    };

    // 6. Save config for future updates
    let config_save_path = dirs::home_dir().unwrap().join(".bakerst/config.json");
    config.save(&config_save_path)?;

    if args.dry_run {
        println!("Dry run complete. Would apply manifests from: {}", template_dir.display());
        return Ok(());
    }

    // 7. Pull images
    let images_to_pull = resolve_images(&manifest, &config);
    images::pull_all(&images_to_pull).await?;

    // 8. Apply K8s manifests
    apply_manifests(&template_dir, &manifest, &config, &cli.namespace).await?;

    // 9. Verify
    let result = verify::run_checks(&cli.namespace, &config).await?;

    // 10. Report
    result.write_log(&args.log)?;
    if result.all_passed() {
        println!("Installation complete! Access Baker Street at http://localhost:30080");
        Ok(())
    } else {
        bail!("Installation completed but verification failed. Check log: {}", args.log.display());
    }
}
```

The `apply_manifests` function:
1. Creates namespace
2. Creates K8s secrets from config (routed by targetSecrets in schema)
3. Creates ConfigMap from `operating_system/` files in template
4. Generates a kustomization overlay that sets correct image tags from manifest
5. Runs `kubectl apply -k` on the appropriate overlay (remote for GHCR, dev for local)
6. Conditionally applies extension manifests based on enabled features

**Step 3: Run `cargo check`**

Run: `cd tools/installer && cargo check`
Expected: Compiles.

**Step 4: Commit**
```bash
git add tools/installer/src/cmd_install.rs tools/installer/src/app.rs
git commit -m "feat(installer): implement install command orchestrator"
```

---

### Task 13: Implement verification module

**Files:**
- Create: `tools/installer/src/verify.rs`
- Create: `tools/installer/tests/verify_test.rs`

**Step 1: Write verification checks**

```rust
use anyhow::Result;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct VerifyResult {
    pub checks: Vec<Check>,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct Check {
    pub name: String,
    pub passed: bool,
    pub message: String,
    pub duration_ms: u64,
}

impl VerifyResult {
    pub fn all_passed(&self) -> bool {
        self.checks.iter().all(|c| c.passed)
    }

    pub fn write_log(&self, path: &Path) -> Result<()> {
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(path, json)?;
        Ok(())
    }
}

pub async fn run_checks(namespace: &str, config: &InterviewResult) -> Result<VerifyResult> {
    let start = std::time::Instant::now();
    let mut checks = Vec::new();

    // Check 1: All expected pods are Running
    checks.push(check_pods_running(namespace).await);

    // Check 2: Brain health endpoint
    checks.push(check_brain_health(namespace).await);

    // Check 3: NATS connectivity
    checks.push(check_nats_health(namespace).await);

    // Check 4: Send test prompt (if API key configured)
    if config.secrets.contains_key("ANTHROPIC_API_KEY")
        || config.secrets.contains_key("OPENAI_API_KEY")
        || config.secrets.contains_key("OLLAMA_ENDPOINTS")
    {
        checks.push(check_test_prompt(namespace, config).await);
    }

    Ok(VerifyResult {
        checks,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}
```

Each check function:
- Uses `kubectl port-forward` or `kubectl exec` to reach services
- Has a timeout (30s for health, 60s for test prompt)
- Returns a `Check` with pass/fail and message

**Step 2: Run tests**

Run: `cd tools/installer && cargo test`
Expected: Unit tests pass (integration tests need a cluster).

**Step 3: Commit**
```bash
git add tools/installer/src/verify.rs tools/installer/tests/
git commit -m "feat(installer): implement verification module"
```

---

### Task 14: Implement config file format for automation

**Files:**
- Rewrite: `tools/installer/src/config_file.rs`
- Create: `tools/installer/tests/config_file_test.rs`
- Create: `test/acceptance/test-config.yaml`

**Step 1: Define config file format**

The config file is what `--config` takes. It's also what the acceptance test uses:

```yaml
# test/acceptance/test-config.yaml
namespace: bakerst
agentName: Baker

secrets:
  ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"  # Resolved from env
  OLLAMA_ENDPOINTS: "http://host.docker.internal:11434"
  AUTH_TOKEN: auto  # Triggers auto-generation

features:
  telegram: false
  discord: false
  github: false
  obsidian: false
  voice: false
  google-workspace: false

verify:
  expected_pods:
    - brain
    - worker
    - ui
    - nats
    - qdrant
  chat_prompt: "Say hello in exactly 3 words"
  timeout_seconds: 120
```

**Step 2: Implement config_file.rs**

```rust
#[derive(Debug, Deserialize)]
pub struct ConfigFile {
    pub namespace: Option<String>,
    #[serde(rename = "agentName")]
    pub agent_name: Option<String>,
    pub secrets: HashMap<String, String>,
    pub features: HashMap<String, bool>,
    pub verify: Option<VerifyConfig>,
}

#[derive(Debug, Deserialize)]
pub struct VerifyConfig {
    pub expected_pods: Vec<String>,
    pub chat_prompt: Option<String>,
    pub timeout_seconds: Option<u64>,
}

impl ConfigFile {
    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        // Resolve ${ENV_VAR} references
        let resolved = resolve_env_vars(&content);
        let config: Self = serde_yaml::from_str(&resolved)?;
        Ok(config)
    }
}

fn resolve_env_vars(input: &str) -> String {
    // Replace ${VAR_NAME} with env var value, leave as-is if not set
    let re = regex::Regex::new(r"\$\{(\w+)\}").unwrap();
    re.replace_all(input, |caps: &regex::Captures| {
        std::env::var(&caps[1]).unwrap_or_default()
    }).to_string()
}
```

**Step 3: Add `regex` to Cargo.toml deps**

**Step 4: Run tests**

Run: `cd tools/installer && cargo test`
Expected: Pass.

**Step 5: Commit**
```bash
git add tools/installer/src/config_file.rs tools/installer/tests/ test/acceptance/
git commit -m "feat(installer): implement config file with env var resolution"
```

---

### Task 15: Update TUI for new flow

**Files:**
- Modify: `tools/installer/src/tui.rs`

**Step 1: Simplify TUI to match new phases**

The TUI needs to render the new 8-phase flow (Preflight, FetchManifest, DownloadTemplate, Configure, PullImages, Apply, Verify, Complete). Reuse the existing color palette and ratatui patterns from the current `tui.rs`.

Key changes:
- Remove the 10 old phase renderers
- Add renderers for the new phases
- The Configure phase should render grouped secret prompts and feature toggles from config-schema.json
- The PullImages/Apply/Verify phases show progress with spinners and checkmarks
- The Complete/Failed phase shows the verification report

Preserve the Tui struct, setup/restore terminal, and the three-zone layout (header, main, status bar).

**Step 2: Verify it compiles**

Run: `cd tools/installer && cargo check`
Expected: Compiles.

**Step 3: Commit**
```bash
git add tools/installer/src/tui.rs
git commit -m "feat(installer): update TUI for new install flow"
```

---

### Task 16: Implement status, update, and uninstall commands

**Files:**
- Rewrite: `tools/installer/src/cmd_status.rs`
- Rewrite: `tools/installer/src/cmd_update.rs`
- Rewrite: `tools/installer/src/cmd_uninstall.rs`

**Step 1: Implement status command**

Reads `~/.bakerst/config.json`, queries K8s for pod status, compares installed version with latest available:
- Pod names, status, image versions
- Current version vs latest release
- Feature flags enabled
- JSON output with `--json` flag

**Step 2: Implement update command**

1. Load saved config from `~/.bakerst/config.json`
2. Fetch latest manifest
3. Compare versions
4. If newer: pull new images, re-apply manifests, verify
5. If `--reconfigure`: re-run interview with existing values as defaults

**Step 3: Implement uninstall command**

1. Confirm with user (unless `--non-interactive`)
2. `kubectl delete namespace bakerst`
3. Optionally delete `~/.bakerst/`

**Step 4: Run `cargo check`**

Run: `cd tools/installer && cargo check`
Expected: Compiles.

**Step 5: Commit**
```bash
git add tools/installer/src/cmd_status.rs tools/installer/src/cmd_update.rs tools/installer/src/cmd_uninstall.rs
git commit -m "feat(installer): implement status, update, and uninstall commands"
```

---

### Task 17: Write installer integration tests

**Files:**
- Create: `tools/installer/tests/integration.rs`

**Step 1: Write integration tests**

Tests that don't require a cluster (mock/local manifest):
- Parse a local manifest file
- Load a config file with env var resolution
- Parse config-schema.json
- Verify interview produces correct output from config file
- Verify image list resolution from manifest + features

Tests that require a cluster (behind `#[cfg(feature = "integration")]`):
- Context detection
- Namespace creation/deletion
- Full install with local manifest → verify → uninstall

**Step 2: Run unit tests**

Run: `cd tools/installer && cargo test`
Expected: All pass.

**Step 3: Commit**
```bash
git add tools/installer/tests/
git commit -m "test(installer): add integration tests"
```

---

## Phase 4: CI/CD Pipeline

### Task 18: Write new release workflow

**Files:**
- Rewrite: `.github/workflows/release.yml`

**Step 1: Write the new workflow**

Structure:
```yaml
name: Release
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to release (without v prefix)'
        required: true

permissions:
  contents: write
  packages: write

jobs:
  # Stage 1: Build Docker images (native, per-arch)
  build-image-amd64:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        service: [brain, worker, ui, gateway, sysadmin, voice, nats-sidecar, ext-toolbox, ext-browser, ext-google-workspace]
        include:
          - service: brain
            context: .
            dockerfile: services/brain/Dockerfile
          # ... etc for each service
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: ${{ matrix.context }}
          file: ${{ matrix.dockerfile }}
          platforms: linux/amd64
          push: true
          tags: ghcr.io/the-baker-street-project/bakerst-${{ matrix.service }}:${{ env.VERSION }}-amd64
          cache-from: type=gha
          cache-to: type=gha,mode=max

  build-image-arm64:
    runs-on: ubuntu-24.04-arm
    strategy:
      fail-fast: false
      matrix:
        service: [brain, worker, ui, gateway, sysadmin, voice, nats-sidecar, ext-toolbox, ext-browser, ext-google-workspace]
        # Same matrix includes as amd64
    steps:
      # Same as amd64 but platform: linux/arm64 and tag suffix: -arm64

  # Create multi-arch manifests
  create-manifests:
    needs: [build-image-amd64, build-image-arm64]
    runs-on: ubuntu-latest
    steps:
      - uses: docker/login-action@v3
      - name: Create multi-arch manifests
        run: |
          for service in brain worker ui gateway sysadmin voice nats-sidecar ext-toolbox ext-browser ext-google-workspace; do
            docker manifest create \
              ghcr.io/the-baker-street-project/bakerst-${service}:${VERSION} \
              ghcr.io/the-baker-street-project/bakerst-${service}:${VERSION}-amd64 \
              ghcr.io/the-baker-street-project/bakerst-${service}:${VERSION}-arm64
            docker manifest push ghcr.io/the-baker-street-project/bakerst-${service}:${VERSION}
            # Also tag as latest
            docker manifest create \
              ghcr.io/the-baker-street-project/bakerst-${service}:latest \
              ghcr.io/the-baker-street-project/bakerst-${service}:${VERSION}-amd64 \
              ghcr.io/the-baker-street-project/bakerst-${service}:${VERSION}-arm64
            docker manifest push ghcr.io/the-baker-street-project/bakerst-${service}:latest
          done
      - name: Telegram notification
        if: always()
        run: |
          STATUS=${{ job.status == 'success' && '✅ Images built' || '❌ Image build failed' }}
          curl -s -X POST "https://api.telegram.org/bot${{ secrets.TELEGRAM_BOT_TOKEN }}/sendMessage" \
            -d chat_id=${{ secrets.TELEGRAM_CHAT_ID }} \
            -d text="${STATUS} for v${VERSION}"

  # Stage 2: Build installer binaries
  build-installer:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
            binary_name: bakerst-install-linux-amd64
          - os: macos-latest
            target: aarch64-apple-darwin
            binary_name: bakerst-install-darwin-arm64
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      - run: cargo build --release --target ${{ matrix.target }}
        working-directory: tools/installer
      - run: |
          cp target/${{ matrix.target }}/release/bakerst-install ${{ matrix.binary_name }}
          shasum -a 256 ${{ matrix.binary_name }} > ${{ matrix.binary_name }}.sha256
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.binary_name }}
          path: |
            ${{ matrix.binary_name }}
            ${{ matrix.binary_name }}.sha256

  # Stage 3: Package release artifacts
  package-artifacts:
    needs: [create-manifests, build-installer]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Generate manifest.json
        run: bash scripts/generate-manifest.sh
        env:
          VERSION: ${{ env.VERSION }}
          GITHUB_REPOSITORY: ${{ github.repository }}
      - name: Bundle install template
        run: bash scripts/bundle-template.sh
        env:
          VERSION: ${{ env.VERSION }}
      - uses: actions/upload-artifact@v4
        with:
          name: release-artifacts
          path: |
            manifest.json
            install-template.tar.gz

  # Stage 4: Acceptance test (THE GATE)
  acceptance-test:
    needs: [package-artifacts, build-installer]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: helm/kind-action@v1
        with:
          cluster_name: acceptance
      - name: Download artifacts
        uses: actions/download-artifact@v4
      - name: Load images into kind
        run: |
          for service in brain worker ui gateway nats-sidecar sysadmin; do
            docker pull ghcr.io/the-baker-street-project/bakerst-${service}:${VERSION}
            kind load docker-image ghcr.io/the-baker-street-project/bakerst-${service}:${VERSION} --name acceptance
          done
      - name: Run installer with test config
        run: |
          chmod +x bakerst-install-linux-amd64/bakerst-install-linux-amd64
          ./bakerst-install-linux-amd64/bakerst-install-linux-amd64 install \
            --config test/acceptance/test-config.yaml \
            --manifest release-artifacts/manifest.json \
            --log acceptance-test.log \
            --non-interactive
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Upload test log
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: acceptance-test-log
          path: acceptance-test.log
      - name: Telegram notification
        if: always()
        run: |
          if [ "${{ job.status }}" = "success" ]; then
            MSG="✅ Acceptance test PASSED for v${VERSION}"
          else
            MSG="❌ Acceptance test FAILED for v${VERSION} — check logs"
          fi
          curl -s -X POST "https://api.telegram.org/bot${{ secrets.TELEGRAM_BOT_TOKEN }}/sendMessage" \
            -d chat_id=${{ secrets.TELEGRAM_CHAT_ID }} \
            -d text="${MSG}"

  # Stage 5: Publish release (only if acceptance passes)
  publish-release:
    needs: [acceptance-test]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ env.VERSION }}
          generate_release_notes: true
          files: |
            release-artifacts/manifest.json
            release-artifacts/install-template.tar.gz
            bakerst-install-linux-amd64/*
            bakerst-install-darwin-arm64/*
      - name: Telegram notification
        run: |
          curl -s -X POST "https://api.telegram.org/bot${{ secrets.TELEGRAM_BOT_TOKEN }}/sendMessage" \
            -d chat_id=${{ secrets.TELEGRAM_CHAT_ID }} \
            -d text="🚀 Release v${VERSION} published! https://github.com/${{ github.repository }}/releases/tag/v${VERSION}"
```

Note: This is a structural outline. The actual workflow needs proper `env.VERSION` extraction from the tag, correct artifact paths, and proper matrix includes with Dockerfile paths for each service.

**Step 2: Validate workflow syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"`
Expected: No YAML syntax errors.

**Step 3: Commit**
```bash
git add .github/workflows/release.yml
git commit -m "feat(ci): rewrite release workflow with native builds and acceptance gate"
```

---

## Phase 5: Dev Scripts

### Task 19: Rewrite deploy-all.sh

**Files:**
- Rewrite: `scripts/deploy-all.sh`

**Step 1: Write simplified deploy-all.sh**

~200 lines max (down from 1044). Structure:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAMESPACE="bakerst"

# --- Helpers ---
info()  { printf '\033[0;36m[INFO]\033[0m %s\n' "$1"; }
ok()    { printf '\033[0;32m[OK]\033[0m %s\n' "$1"; }
warn()  { printf '\033[0;33m[WARN]\033[0m %s\n' "$1"; }
fail()  { printf '\033[0;31m[FAIL]\033[0m %s\n' "$1"; exit 1; }

# --- Parse flags ---
SKIP_BUILD=false
SKIP_IMAGES=false
DEV_MODE=false
NO_CACHE=""
VERSION=$(git rev-parse --short HEAD)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)   SKIP_BUILD=true ;;
    --skip-images)  SKIP_IMAGES=true ;;
    --dev)          DEV_MODE=true ;;
    --no-cache)     NO_CACHE="--no-cache" ;;
    --version)      VERSION="$2"; shift ;;
    *)              fail "Unknown flag: $1" ;;
  esac
  shift
done

# --- Step 1: Preflight ---
info "Checking prerequisites..."
command -v docker >/dev/null || fail "docker not found"
command -v kubectl >/dev/null || fail "kubectl not found"
command -v pnpm >/dev/null || fail "pnpm not found"
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
[[ $((NODE_VERSION % 2)) -eq 0 ]] || fail "Node.js must be an even version (got v${NODE_VERSION})"
kubectl cluster-info >/dev/null 2>&1 || fail "No Kubernetes cluster reachable"
ok "Prerequisites satisfied"

# --- Step 2: Secrets source ---
echo ""
echo "Where are your secrets?"
echo "  1) Environment variables (already loaded in shell)"
echo "  2) .env-secrets file"
read -rp "Choice [1]: " SECRETS_SOURCE
SECRETS_SOURCE="${SECRETS_SOURCE:-1}"

if [[ "$SECRETS_SOURCE" == "2" ]]; then
  [[ -f "$REPO_ROOT/.env-secrets" ]] || fail ".env-secrets not found"
  set -a
  source "$REPO_ROOT/.env-secrets"
  set +a
  ok "Loaded secrets from .env-secrets"
else
  ok "Using environment variables"
fi

# Validate at least one provider
if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" && -z "${OLLAMA_ENDPOINTS:-}" ]]; then
  warn "No AI provider configured (ANTHROPIC_API_KEY, OPENAI_API_KEY, or OLLAMA_ENDPOINTS)"
fi

# --- Step 3: Build ---
if [[ "$SKIP_BUILD" == "false" ]]; then
  info "Building TypeScript..."
  pnpm install --frozen-lockfile
  pnpm -r build
  ok "TypeScript build complete"
fi

# --- Step 4: Docker images ---
if [[ "$SKIP_IMAGES" == "false" ]]; then
  info "Building Docker images..."
  bash "$REPO_ROOT/scripts/build.sh" --version "$VERSION" $NO_CACHE
  ok "Docker images built"
fi

# --- Step 5: Apply ---
info "Creating namespace and secrets..."
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# Create scoped secrets (reuse secrets.sh logic but inline)
# Brain secrets
kubectl create secret generic bakerst-brain-secrets -n "$NAMESPACE" \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --from-literal=DEFAULT_MODEL="${DEFAULT_MODEL:-}" \
  --from-literal=WORKER_MODEL="${WORKER_MODEL:-}" \
  --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  --from-literal=OLLAMA_ENDPOINTS="${OLLAMA_ENDPOINTS:-}" \
  --from-literal=VOYAGE_API_KEY="${VOYAGE_API_KEY:-}" \
  --from-literal=AUTH_TOKEN="${AUTH_TOKEN:-}" \
  --from-literal=AGENT_NAME="${AGENT_NAME:-Baker}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Worker secrets
kubectl create secret generic bakerst-worker-secrets -n "$NAMESPACE" \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --from-literal=DEFAULT_MODEL="${DEFAULT_MODEL:-}" \
  --from-literal=WORKER_MODEL="${WORKER_MODEL:-}" \
  --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  --from-literal=OLLAMA_ENDPOINTS="${OLLAMA_ENDPOINTS:-}" \
  --from-literal=AGENT_NAME="${AGENT_NAME:-Baker}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Gateway secrets
kubectl create secret generic bakerst-gateway-secrets -n "$NAMESPACE" \
  --from-literal=TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
  --from-literal=DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}" \
  --from-literal=AUTH_TOKEN="${AUTH_TOKEN:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

# ConfigMap from operating_system/
kubectl create configmap bakerst-os -n "$NAMESPACE" \
  --from-file="$REPO_ROOT/operating_system/" \
  --dry-run=client -o yaml | kubectl apply -f -

# Apply manifests
if [[ "$DEV_MODE" == "true" ]]; then
  kubectl apply -k "$REPO_ROOT/k8s/overlays/dev/"
else
  kubectl apply -k "$REPO_ROOT/k8s/"
fi
ok "Manifests applied"

# --- Step 6: Verify ---
info "Waiting for rollout..."
for deploy in nats qdrant brain-blue worker ui gateway sysadmin; do
  if kubectl -n "$NAMESPACE" get deployment "$deploy" >/dev/null 2>&1; then
    kubectl -n "$NAMESPACE" rollout status deployment/"$deploy" --timeout=120s || warn "$deploy rollout timed out"
  fi
done
ok "Rollout complete"

# --- Step 7: Summary ---
echo ""
echo "=== Baker Street Deployed ==="
kubectl -n "$NAMESPACE" get pods
echo ""
echo "Access: http://localhost:30080"
```

**Step 2: Test locally**

Run: `bash scripts/deploy-all.sh --skip-build --skip-images`
Expected: Creates secrets and applies manifests (or fails clearly on missing cluster).

**Step 3: Commit**
```bash
git add scripts/deploy-all.sh
git commit -m "feat(scripts): rewrite deploy-all.sh (simplified)"
```

---

### Task 20: Rewrite release.sh

**Files:**
- Rewrite: `scripts/release.sh`

**Step 1: Simplify release.sh**

Keep the same flow but remove manifest.json manipulation (CI generates it now):

1. Preflight: must be on main, clean tree, up-to-date
2. Determine version (auto-increment or explicit)
3. Show changelog
4. Confirm
5. Tag and push (no manifest commit — CI does everything)
6. Watch pipeline (gh run watch)

Remove the `jq` manifest update step entirely — the manifest is generated by CI from build outputs.

**Step 2: Commit**
```bash
git add scripts/release.sh
git commit -m "feat(scripts): simplify release.sh (CI generates manifest)"
```

---

### Task 21: Clean up legacy files

**Files:**
- Delete: `scripts/secrets.sh` (superseded by deploy-all.sh inline + installer)
- Delete: `scripts/deploy.sh` (superseded by deploy-all.sh)
- Delete: `tools/installer/release-manifest.json` (if not already deleted)
- Delete: `tools/installer/src/templates/` directory (if not already deleted)
- Delete: `tools/installer/src/os_files/` directory (if not already deleted)
- Modify: `scripts/build.sh` — clean up but keep hash-based change detection

**Step 1: Remove deprecated files**

```bash
git rm scripts/secrets.sh scripts/deploy.sh
git rm -r tools/installer/src/templates/ tools/installer/src/os_files/ || true
git rm tools/installer/release-manifest.json || true
```

**Step 2: Update any references**

Search for references to deleted files in CLAUDE.md, other scripts, README, etc. Update or remove them.

**Step 3: Commit**
```bash
git commit -m "chore: remove legacy build/deploy files superseded by redesign"
```

---

## Phase 6: Acceptance Test

### Task 22: Create acceptance test config and CI integration

**Files:**
- Create: `test/acceptance/test-config.yaml`
- Create: `test/acceptance/README.md`

**Step 1: Write the test config**

```yaml
# test/acceptance/test-config.yaml
# Used by CI acceptance test and local validation.
# Secrets reference env vars that CI provides via GitHub Actions secrets.
namespace: bakerst
agentName: Baker

secrets:
  ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
  AUTH_TOKEN: auto
  AGENT_NAME: Baker

features:
  telegram: false
  discord: false
  github: false
  obsidian: false
  voice: false
  google-workspace: false

verify:
  expected_pods:
    - brain-blue
    - worker
    - ui
    - nats
    - qdrant
  chat_prompt: "Respond with exactly: ACCEPTANCE_TEST_PASSED"
  timeout_seconds: 180
```

**Step 2: Write README explaining the acceptance test**

```markdown
# Acceptance Test

This test validates that the installer can deploy a working Baker Street
instance from scratch. It runs in CI as a release gate.

## Running locally

```bash
export ANTHROPIC_API_KEY=your-key
cd tools/installer
cargo build --release
./target/release/bakerst-install install \
  --config ../../test/acceptance/test-config.yaml \
  --manifest ../../manifest.json \
  --log test-result.log
cat test-result.log
```

## CI

The acceptance test runs automatically in the release workflow after
images and installer are built. It uses a `kind` cluster and real API
keys from GitHub Actions secrets.
```

**Step 3: Commit**
```bash
git add test/acceptance/
git commit -m "feat(test): add acceptance test config and documentation"
```

---

## Phase 7: End-to-End Validation

### Task 23: Local end-to-end test

**Step 1: Build the installer**

```bash
cd tools/installer && cargo build --release
```
Expected: Binary at `target/release/bakerst-install`.

**Step 2: Create a local manifest for testing**

Generate a local `manifest.json` pointing to locally-built images:
```bash
VERSION=test bash scripts/generate-manifest.sh
```

**Step 3: Bundle the template**

```bash
VERSION=test bash scripts/bundle-template.sh
```

**Step 4: Run the installer locally**

```bash
./tools/installer/target/release/bakerst-install install \
  --manifest ./manifest.json \
  --config ./test/acceptance/test-config.yaml \
  --log ./test-result.log
```

Expected: Installer fetches template, applies manifests, verifies pods are healthy.

**Step 5: Check the log**

```bash
cat test-result.log | python3 -m json.tool
```

Expected: All checks passed, exit code 0.

**Step 6: Clean up**

```bash
./tools/installer/target/release/bakerst-install uninstall -y
```

**Step 7: Fix any issues found**

Iterate until the full flow works end-to-end without manual intervention.

---

### Task 24: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update Build & Deploy section**

Replace the current build/deploy documentation to reflect:
- New `deploy-all.sh` flags and flow
- New `release.sh` (no manifest commit)
- Manifest and template are CI-generated
- Installer commands and flags
- Acceptance test instructions

**Step 2: Update Secrets section**

Document the new secrets source prompt (env vars vs .env-secrets).

**Step 3: Commit**
```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for new build/release/installer pipeline"
```

---

## GitHub Actions Secrets Required

Before the first release, these secrets must be configured in the GitHub repo:

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Acceptance test — sends real prompt to verify working system |
| `TELEGRAM_BOT_TOKEN` | Release notifications |
| `TELEGRAM_CHAT_ID` | Release notifications — your chat/group ID |

`GITHUB_TOKEN` is auto-provided by GitHub Actions for GHCR access.

---

## Dependency Order

```
Phase 1 (K8s cleanup) → Phase 2 (schemas + scripts) → Phase 3 (installer) → Phase 4 (CI/CD) → Phase 5 (dev scripts) → Phase 6 (acceptance test) → Phase 7 (validation)
```

Phases 3 and 4 can be partially parallelized (installer and CI workflow are independent until the acceptance test ties them together).
