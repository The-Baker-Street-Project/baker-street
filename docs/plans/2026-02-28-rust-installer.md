# Rust Installer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a deterministic, full-screen TUI installer (`bakerst-install`) in Rust that replaces all shell deploy scripts and the sysadmin pod's deploy mode.

**Architecture:** Single monolithic binary with embedded K8s YAML templates. Uses `kube` crate for native K8s API access, `tokio` for async parallel image pulls, and `ratatui` for a full-screen TUI with real-time progress. Eight-phase state machine: Preflight → Secrets → Features → Confirm → Pull → Deploy → Health → Complete.

**Tech Stack:** Rust 2021 edition, ratatui + crossterm (TUI), kube + k8s-openapi (K8s API), tokio (async), reqwest (HTTP), clap (CLI), serde + serde_json + serde_yaml (serialization)

**Design Doc:** `docs/plans/2026-02-28-rust-installer-design.md`

---

## Task 1: Scaffold Rust Project + CLI

**Files:**
- Create: `tools/installer/Cargo.toml`
- Create: `tools/installer/src/main.rs`
- Create: `tools/installer/src/cli.rs`

**Step 1: Create Cargo.toml with all dependencies**

```toml
[package]
name = "bakerst-install"
version = "0.1.0"
edition = "2021"
description = "Baker Street Kubernetes installer"
license = "MIT"

[[bin]]
name = "bakerst-install"
path = "src/main.rs"

[dependencies]
# TUI
ratatui = "0.29"
crossterm = "0.28"

# Kubernetes
kube = { version = "0.98", features = ["client", "runtime", "derive"] }
k8s-openapi = { version = "0.24", features = ["v1_31"] }

# Async
tokio = { version = "1", features = ["full"] }

# HTTP
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"

# CLI
clap = { version = "4", features = ["derive"] }

# Utilities
anyhow = "1"
rand = "0.8"
hex = "0.4"
base64 = "0.22"
open = "5"

[dev-dependencies]
assert_cmd = "2"
predicates = "3"
```

**Step 2: Create CLI argument parser**

File: `tools/installer/src/cli.rs`

```rust
use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "bakerst-install", version, about = "Baker Street Kubernetes installer")]
pub struct Cli {
    /// Install a specific release version (default: latest)
    #[arg(long = "release", value_name = "TAG")]
    pub release_version: Option<String>,

    /// Use a local manifest file instead of fetching from GitHub
    #[arg(long, value_name = "PATH")]
    pub manifest: Option<String>,

    /// Non-interactive mode: use env vars, no TUI
    #[arg(long)]
    pub non_interactive: bool,

    /// Remove all Baker Street resources
    #[arg(long)]
    pub uninstall: bool,

    /// Show deployment status and exit
    #[arg(long)]
    pub status: bool,

    /// Override PVC with hostPath at this directory
    #[arg(long, value_name = "PATH")]
    pub data_dir: Option<String>,

    /// Skip telemetry stack
    #[arg(long)]
    pub skip_telemetry: bool,

    /// Skip extension pods
    #[arg(long)]
    pub skip_extensions: bool,

    /// Override namespace (default: bakerst)
    #[arg(long, default_value = "bakerst")]
    pub namespace: String,

    /// Show debug output
    #[arg(short, long)]
    pub verbose: bool,
}
```

**Step 3: Create main.rs entry point**

File: `tools/installer/src/main.rs`

```rust
mod cli;

use clap::Parser;
use cli::Cli;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if cli.status {
        println!("Status mode not yet implemented");
        return Ok(());
    }
    if cli.uninstall {
        println!("Uninstall mode not yet implemented");
        return Ok(());
    }

    println!("Baker Street Installer v{}", env!("CARGO_PKG_VERSION"));
    println!("Namespace: {}", cli.namespace);
    Ok(())
}
```

**Step 4: Verify it compiles and runs**

Run: `cd tools/installer && cargo build 2>&1`
Expected: Compiles without errors

Run: `cargo run -- --help`
Expected: Shows help with all flags listed

Run: `cargo run -- --version`
Expected: `bakerst-install 0.1.0`

**Step 5: Commit**

```bash
git add tools/installer/
git commit -m "feat(installer): scaffold Rust project with CLI args"
```

---

## Task 2: App State Machine

**Files:**
- Create: `tools/installer/src/app.rs`
- Test: inline `#[cfg(test)]` module

**Step 1: Write failing tests for phase transitions**

Add to `tools/installer/src/app.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Preflight,
    Secrets,
    Features,
    Confirm,
    Pull,
    Deploy,
    Health,
    Complete,
}

impl Phase {
    pub fn index(&self) -> usize {
        match self {
            Phase::Preflight => 0,
            Phase::Secrets => 1,
            Phase::Features => 2,
            Phase::Confirm => 3,
            Phase::Pull => 4,
            Phase::Deploy => 5,
            Phase::Health => 6,
            Phase::Complete => 7,
        }
    }

    pub fn total() -> usize {
        8
    }

    pub fn label(&self) -> &'static str {
        match self {
            Phase::Preflight => "Preflight",
            Phase::Secrets => "Secrets",
            Phase::Features => "Features",
            Phase::Confirm => "Confirm",
            Phase::Pull => "Pull Images",
            Phase::Deploy => "Deploy",
            Phase::Health => "Health Check",
            Phase::Complete => "Complete",
        }
    }

    pub fn next(&self) -> Option<Phase> {
        match self {
            Phase::Preflight => Some(Phase::Secrets),
            Phase::Secrets => Some(Phase::Features),
            Phase::Features => Some(Phase::Confirm),
            Phase::Confirm => Some(Phase::Pull),
            Phase::Pull => Some(Phase::Deploy),
            Phase::Deploy => Some(Phase::Health),
            Phase::Health => Some(Phase::Complete),
            Phase::Complete => None,
        }
    }
}

/// Status of an individual item (image pull, resource creation, pod health)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemStatus {
    Pending,
    InProgress,
    Done,
    Failed(String),
    Skipped,
}

/// Collected secrets and configuration
#[derive(Debug, Clone, Default)]
pub struct InstallConfig {
    pub oauth_token: Option<String>,
    pub api_key: Option<String>,
    pub agent_name: String,
    pub auth_token: String,
    pub features: Vec<FeatureSelection>,
    pub namespace: String,
}

#[derive(Debug, Clone)]
pub struct FeatureSelection {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub secrets: Vec<(String, Option<String>)>, // (key, value)
}

/// Top-level app state
pub struct App {
    pub phase: Phase,
    pub config: InstallConfig,
    pub should_quit: bool,
    pub cluster_name: String,
}

impl App {
    pub fn new(namespace: String) -> Self {
        Self {
            phase: Phase::Preflight,
            config: InstallConfig {
                namespace,
                agent_name: "Baker".into(),
                auth_token: String::new(),
                ..Default::default()
            },
            should_quit: false,
            cluster_name: String::new(),
        }
    }

    pub fn advance(&mut self) -> bool {
        if let Some(next) = self.phase.next() {
            self.phase = next;
            true
        } else {
            false
        }
    }

    /// Only valid from Confirm → back to Secrets
    pub fn back_to_secrets(&mut self) {
        if self.phase == Phase::Confirm {
            self.phase = Phase::Secrets;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_advances_through_all_stages() {
        let mut phase = Phase::Preflight;
        let mut count = 0;
        while let Some(next) = phase.next() {
            phase = next;
            count += 1;
        }
        assert_eq!(count, 7);
        assert_eq!(phase, Phase::Complete);
    }

    #[test]
    fn complete_has_no_next() {
        assert_eq!(Phase::Complete.next(), None);
    }

    #[test]
    fn phase_index_is_sequential() {
        assert_eq!(Phase::Preflight.index(), 0);
        assert_eq!(Phase::Complete.index(), 7);
    }

    #[test]
    fn app_advance_works() {
        let mut app = App::new("bakerst".into());
        assert_eq!(app.phase, Phase::Preflight);
        assert!(app.advance());
        assert_eq!(app.phase, Phase::Secrets);
    }

    #[test]
    fn app_back_to_secrets_only_from_confirm() {
        let mut app = App::new("bakerst".into());
        app.phase = Phase::Confirm;
        app.back_to_secrets();
        assert_eq!(app.phase, Phase::Secrets);
    }

    #[test]
    fn app_back_to_secrets_noop_from_other_phases() {
        let mut app = App::new("bakerst".into());
        app.phase = Phase::Deploy;
        app.back_to_secrets();
        assert_eq!(app.phase, Phase::Deploy);
    }
}
```

**Step 2: Run tests**

Run: `cd tools/installer && cargo test`
Expected: All 6 tests pass

**Step 3: Register module in main.rs**

Add `mod app;` to `tools/installer/src/main.rs`.

**Step 4: Commit**

```bash
git add tools/installer/src/app.rs tools/installer/src/main.rs
git commit -m "feat(installer): app state machine with phase transitions"
```

---

## Task 3: Release Manifest Fetching + Parsing

**Files:**
- Create: `tools/installer/src/manifest.rs`
- Test: inline `#[cfg(test)]` module

**Step 1: Define Rust types mirroring the TypeScript release manifest**

File: `tools/installer/src/manifest.rs`

```rust
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
        ],
        required_secrets: vec![
            ManifestSecret {
                key: "ANTHROPIC_OAUTH_TOKEN".into(),
                description: "Anthropic OAuth token for Claude".into(),
                required: true,
                input_type: "secret".into(),
                target_secrets: vec!["bakerst-brain-secrets".into(), "bakerst-worker-secrets".into()],
            },
        ],
        optional_features: vec![],
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
```

Note: add `chrono = "0.4"` and `tempfile = "3"` (dev) to Cargo.toml.

**Step 2: Run tests**

Run: `cd tools/installer && cargo test manifest`
Expected: All 3 tests pass

**Step 3: Register module, commit**

Add `mod manifest;` to main.rs.

```bash
git add tools/installer/
git commit -m "feat(installer): release manifest fetch + parse"
```

---

## Task 4: Template Rendering Engine

**Files:**
- Create: `tools/installer/src/templates.rs`
- Create: `tools/installer/src/templates/` (directory with YAML files)

**Step 1: Write template renderer with tests**

File: `tools/installer/src/templates.rs`

```rust
use std::collections::HashMap;

/// Simple mustache-style template rendering: replaces `{{KEY}}` with values.
pub fn render(template: &str, vars: &HashMap<&str, &str>) -> String {
    let mut out = template.to_string();
    for (key, val) in vars {
        out = out.replace(&format!("{{{{{}}}}}", key), val);
    }
    out
}

/// Mask a secret value showing only the last 4 characters.
pub fn mask_secret(value: &str) -> String {
    if value.len() <= 4 {
        return "****".to_string();
    }
    format!("****{}", &value[value.len() - 4..])
}

/// Generate a random 32-byte hex auth token.
pub fn generate_auth_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

// --- Embedded templates ---
// These are the K8s YAML templates compiled into the binary.
// Each one may contain {{VARIABLE}} placeholders.

pub const NAMESPACE_YAML: &str = include_str!("templates/namespace.yaml");
pub const PVCS_YAML: &str = include_str!("templates/pvcs.yaml");
pub const NATS_YAML: &str = include_str!("templates/nats.yaml");
pub const QDRANT_YAML: &str = include_str!("templates/qdrant.yaml");
pub const BRAIN_YAML: &str = include_str!("templates/brain.yaml");
pub const WORKER_YAML: &str = include_str!("templates/worker.yaml");
pub const GATEWAY_YAML: &str = include_str!("templates/gateway.yaml");
pub const UI_YAML: &str = include_str!("templates/ui.yaml");
pub const VOICE_YAML: &str = include_str!("templates/voice.yaml");
pub const SYSADMIN_YAML: &str = include_str!("templates/sysadmin.yaml");
pub const NETWORK_POLICIES_YAML: &str = include_str!("templates/network-policies.yaml");
pub const RBAC_YAML: &str = include_str!("templates/rbac.yaml");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_replaces_variables() {
        let vars = HashMap::from([("NAME", "bakerst"), ("IMAGE", "brain:1.0")]);
        let result = render("namespace: {{NAME}}, image: {{IMAGE}}", &vars);
        assert_eq!(result, "namespace: bakerst, image: brain:1.0");
    }

    #[test]
    fn render_leaves_unknown_variables() {
        let vars = HashMap::from([("NAME", "bakerst")]);
        let result = render("{{NAME}} and {{OTHER}}", &vars);
        assert_eq!(result, "bakerst and {{OTHER}}");
    }

    #[test]
    fn mask_secret_shows_last_4() {
        assert_eq!(mask_secret("sk-ant-oat01-abcdefXYZ"), "****dXYZ");
    }

    #[test]
    fn mask_secret_short_value() {
        assert_eq!(mask_secret("abc"), "****");
    }

    #[test]
    fn generate_auth_token_is_64_hex_chars() {
        let token = generate_auth_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
```

**Step 2: Create template YAML files**

Create `tools/installer/src/templates/` directory. Populate each YAML template file by adapting the existing K8s manifests from `k8s/` — replacing hardcoded values with `{{VARIABLE}}` placeholders and swapping hostPath volumes for PVC references.

The template files are large (full K8s YAML), so rather than inlining them all here, the implementing engineer should:

1. Copy each manifest from `k8s/` into `tools/installer/src/templates/`
2. Replace hardcoded images with `{{IMAGE_BRAIN}}`, `{{IMAGE_WORKER}}`, etc.
3. Replace `namespace: bakerst` with `{{NAMESPACE}}`
4. Replace hostPath volumes with PVC references
5. Combine related manifests (deployment + service) into single files per component
6. Add `{{AGENT_NAME}}` placeholder in brain/worker env vars

Key mappings:
- `k8s/namespace.yaml` → `templates/namespace.yaml` (add `{{NAMESPACE}}`)
- `k8s/nats/` (deployment + service + configmap) → `templates/nats.yaml`
- `k8s/qdrant/` (deployment + service) → `templates/qdrant.yaml` (PVC instead of hostPath)
- `k8s/brain/deployment-blue.yaml` + `k8s/brain/service.yaml` + `k8s/brain/rbac.yaml` → `templates/brain.yaml` (PVC, `{{IMAGE_BRAIN}}`)
- `k8s/worker/deployment.yaml` → `templates/worker.yaml` (`{{IMAGE_WORKER}}`)
- `k8s/gateway/deployment.yaml` → `templates/gateway.yaml` (PVC, `{{IMAGE_GATEWAY}}`)
- `k8s/ui/` → `templates/ui.yaml` (`{{IMAGE_UI}}`)
- `k8s/voice/deployment.yaml` → `templates/voice.yaml` (`{{IMAGE_VOICE}}`)
- `k8s/sysadmin/` (deployment + service + rbac) → `templates/sysadmin.yaml` (`{{IMAGE_SYSADMIN}}`)
- `k8s/network-policies.yaml` + `k8s/sysadmin/network-policy.yaml` → `templates/network-policies.yaml`
- New file: `templates/pvcs.yaml` (brain-data 1Gi, qdrant-data 2Gi, gateway-data 512Mi)
- `k8s/brain/rbac.yaml` + `k8s/task/rbac.yaml` + `k8s/sysadmin/rbac.yaml` → `templates/rbac.yaml`

**Step 3: Run tests**

Run: `cd tools/installer && cargo test templates`
Expected: All 5 tests pass

**Step 4: Commit**

```bash
git add tools/installer/src/templates.rs tools/installer/src/templates/
git commit -m "feat(installer): template rendering engine + embedded K8s YAML"
```

---

## Task 5: Parallel Image Pulling

**Files:**
- Create: `tools/installer/src/images.rs`

**Step 1: Write the image pull module**

File: `tools/installer/src/images.rs`

```rust
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::mpsc;

const MAX_CONCURRENT: usize = 4;
const MAX_RETRIES: u32 = 3;

#[derive(Debug, Clone)]
pub enum PullEvent {
    Started { index: usize, image: String },
    Completed { index: usize, image: String, elapsed: Duration },
    Failed { index: usize, image: String, error: String, attempt: u32 },
    Retrying { index: usize, image: String, attempt: u32 },
}

/// Pull a single image via `docker pull`, with retries.
async fn pull_one(image: &str) -> Result<Duration, String> {
    for attempt in 1..=MAX_RETRIES {
        let start = Instant::now();
        let output = Command::new("docker")
            .args(["pull", image])
            .output()
            .await
            .map_err(|e| format!("failed to run docker: {}", e))?;

        if output.status.success() {
            return Ok(start.elapsed());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if attempt < MAX_RETRIES {
            let backoff = Duration::from_secs(2u64.pow(attempt));
            tokio::time::sleep(backoff).await;
            continue;
        }
        return Err(stderr.trim().to_string());
    }
    unreachable!()
}

/// Pull all images in parallel (max MAX_CONCURRENT at once).
/// Sends PullEvent messages on the channel for TUI updates.
pub async fn pull_all(
    images: Vec<String>,
    tx: mpsc::UnboundedSender<PullEvent>,
) -> Vec<Result<Duration, String>> {
    use tokio::sync::Semaphore;
    use std::sync::Arc;

    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut handles = Vec::new();

    for (index, image) in images.into_iter().enumerate() {
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let tx = tx.clone();
        let img = image.clone();

        let handle = tokio::spawn(async move {
            tx.send(PullEvent::Started { index, image: img.clone() }).ok();

            let result = pull_one(&img).await;

            match &result {
                Ok(elapsed) => {
                    tx.send(PullEvent::Completed { index, image: img, elapsed: *elapsed }).ok();
                }
                Err(err) => {
                    tx.send(PullEvent::Failed { index, image: img, error: err.clone(), attempt: MAX_RETRIES }).ok();
                }
            }

            drop(permit);
            result
        });

        handles.push(handle);
    }

    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.unwrap());
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pull_nonexistent_image_fails() {
        let result = pull_one("ghcr.io/nonexistent/image:99.99.99").await;
        assert!(result.is_err());
    }
}
```

**Step 2: Run tests**

Run: `cd tools/installer && cargo test images`
Expected: `pull_nonexistent_image_fails` passes (Docker is running on this machine)

**Step 3: Commit**

```bash
git add tools/installer/src/images.rs
git commit -m "feat(installer): parallel image pulling with retry + events"
```

---

## Task 6: K8s API Client

**Files:**
- Create: `tools/installer/src/k8s.rs`

**Step 1: Write the K8s operations module**

File: `tools/installer/src/k8s.rs`

This module uses the `kube` crate for native K8s API access. Each function is idempotent (create-or-update).

```rust
use anyhow::{Context, Result};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{
    ConfigMap, Namespace, PersistentVolumeClaim, Secret, Service, ServiceAccount,
};
use k8s_openapi::api::networking::v1::NetworkPolicy;
use k8s_openapi::api::rbac::v1::{Role, RoleBinding};
use kube::api::{Api, DeleteParams, ListParams, LogParams, Patch, PatchParams, PostParams};
use kube::Client;
use std::collections::BTreeMap;
use std::time::Duration;

const PATCH_PARAMS: &str = "bakerst-install";

/// Check if the K8s cluster is reachable. Returns the context/cluster name.
pub async fn check_cluster() -> Result<String> {
    let client = Client::try_default().await?;
    let ver = client.apiserver_version().await?;
    Ok(format!("{}.{}", ver.major, ver.minor))
}

/// Create a namespace (idempotent).
pub async fn create_namespace(client: &Client, name: &str) -> Result<()> {
    let api: Api<Namespace> = Api::all(client.clone());
    let ns: Namespace = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": { "name": name }
    }))?;
    api.patch(name, &PatchParams::apply(PATCH_PARAMS), &Patch::Apply(&ns))
        .await
        .context("create namespace")?;
    Ok(())
}

/// Apply a YAML document containing one or more K8s resources.
/// Parses multi-document YAML (separated by ---) and applies each.
pub async fn apply_yaml(client: &Client, namespace: &str, yaml: &str) -> Result<Vec<String>> {
    let mut applied = Vec::new();
    for doc in yaml.split("\n---") {
        let doc = doc.trim();
        if doc.is_empty() || doc.starts_with('#') {
            continue;
        }
        let resource: serde_json::Value = serde_yaml::from_str(doc)
            .context("parse YAML document")?;
        let kind = resource["kind"].as_str().unwrap_or("Unknown");
        let name = resource["metadata"]["name"].as_str().unwrap_or("unnamed");
        let label = format!("{}/{}", kind, name);

        apply_resource(client, namespace, &resource).await
            .with_context(|| format!("apply {}", label))?;
        applied.push(label);
    }
    Ok(applied)
}

/// Apply a single parsed K8s resource using server-side apply.
async fn apply_resource(client: &Client, namespace: &str, resource: &serde_json::Value) -> Result<()> {
    let kind = resource["kind"].as_str().unwrap_or("");
    let name = resource["metadata"]["name"].as_str().unwrap_or("");
    let pp = PatchParams::apply(PATCH_PARAMS).force();

    match kind {
        "Namespace" => {
            let api: Api<Namespace> = Api::all(client.clone());
            let obj: Namespace = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
            let obj: Deployment = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "Service" => {
            let api: Api<Service> = Api::namespaced(client.clone(), namespace);
            let obj: Service = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "ConfigMap" => {
            let api: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
            let obj: ConfigMap = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "Secret" => {
            let api: Api<Secret> = Api::namespaced(client.clone(), namespace);
            let obj: Secret = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "PersistentVolumeClaim" => {
            let api: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), namespace);
            let obj: PersistentVolumeClaim = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "ServiceAccount" => {
            let api: Api<ServiceAccount> = Api::namespaced(client.clone(), namespace);
            let obj: ServiceAccount = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "Role" => {
            let api: Api<Role> = Api::namespaced(client.clone(), namespace);
            let obj: Role = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "RoleBinding" => {
            let api: Api<RoleBinding> = Api::namespaced(client.clone(), namespace);
            let obj: RoleBinding = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "NetworkPolicy" => {
            let api: Api<NetworkPolicy> = Api::namespaced(client.clone(), namespace);
            let obj: NetworkPolicy = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        _ => anyhow::bail!("unsupported resource kind: {}", kind),
    }
    Ok(())
}

/// Create a K8s Secret from key-value pairs (values are base64-encoded automatically).
pub async fn create_secret(
    client: &Client,
    namespace: &str,
    name: &str,
    data: &BTreeMap<String, String>,
) -> Result<()> {
    let encoded: BTreeMap<String, k8s_openapi::ByteString> = data
        .iter()
        .map(|(k, v)| (k.clone(), k8s_openapi::ByteString(v.as_bytes().to_vec())))
        .collect();

    let secret = Secret {
        metadata: kube::api::ObjectMeta {
            name: Some(name.into()),
            namespace: Some(namespace.into()),
            ..Default::default()
        },
        data: Some(encoded),
        ..Default::default()
    };

    let api: Api<Secret> = Api::namespaced(client.clone(), namespace);
    api.patch(name, &PatchParams::apply(PATCH_PARAMS).force(), &Patch::Apply(&secret))
        .await
        .context("create secret")?;
    Ok(())
}

/// Create the bakerst-os ConfigMap from operating system files.
pub async fn create_os_configmap(client: &Client, namespace: &str) -> Result<()> {
    let mut data = BTreeMap::new();
    data.insert("BRAIN.md".into(), include_str!("os_files/BRAIN.md").into());
    data.insert("WORKER.md".into(), include_str!("os_files/WORKER.md").into());
    data.insert("SOUL.md".into(), include_str!("os_files/SOUL.md").into());
    data.insert("PLUGINS.json".into(), include_str!("os_files/PLUGINS.json").into());
    data.insert("CRONS.json".into(), include_str!("os_files/CRONS.json").into());
    data.insert("TRIGGERS.json".into(), include_str!("os_files/TRIGGERS.json").into());
    data.insert("prompts.json".into(), include_str!("os_files/prompts.json").into());

    let cm = ConfigMap {
        metadata: kube::api::ObjectMeta {
            name: Some("bakerst-os".into()),
            namespace: Some(namespace.into()),
            ..Default::default()
        },
        data: Some(data),
        ..Default::default()
    };

    let api: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
    api.patch("bakerst-os", &PatchParams::apply(PATCH_PARAMS).force(), &Patch::Apply(&cm))
        .await
        .context("create bakerst-os configmap")?;
    Ok(())
}

/// Delete a namespace (cascades to all resources within).
pub async fn delete_namespace(client: &Client, name: &str) -> Result<()> {
    let api: Api<Namespace> = Api::all(client.clone());
    api.delete(name, &DeleteParams::default()).await.ok();
    Ok(())
}
```

**Step 2: Copy operating system files into `src/os_files/`**

```bash
mkdir -p tools/installer/src/os_files
cp operating_system/BRAIN.md tools/installer/src/os_files/
cp operating_system/WORKER.md tools/installer/src/os_files/
cp operating_system/SOUL.md tools/installer/src/os_files/
cp operating_system/PLUGINS.json tools/installer/src/os_files/
cp operating_system/CRONS.json tools/installer/src/os_files/
cp operating_system/TRIGGERS.json tools/installer/src/os_files/
cp operating_system/prompts.json tools/installer/src/os_files/
```

**Step 3: Verify compilation**

Run: `cd tools/installer && cargo build`
Expected: Compiles (tests that need a live cluster are skipped)

**Step 4: Commit**

```bash
git add tools/installer/src/k8s.rs tools/installer/src/os_files/
git commit -m "feat(installer): K8s API client with server-side apply"
```

---

## Task 7: Health Check Polling + Auto-Recovery

**Files:**
- Create: `tools/installer/src/health.rs`

**Step 1: Write the health polling module**

File: `tools/installer/src/health.rs`

```rust
use anyhow::Result;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, DeleteParams, ListParams, LogParams};
use kube::Client;
use std::time::Duration;
use tokio::sync::mpsc;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const POD_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RECOVERY_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone)]
pub struct PodHealth {
    pub name: String,
    pub deployment: String,
    pub ready: bool,
    pub phase: String,
    pub image: String,
    pub restarts: i32,
    pub error: Option<String>,
    pub logs_tail: Option<String>,
}

#[derive(Debug, Clone)]
pub enum HealthEvent {
    PodUpdate(PodHealth),
    RecoveryAttempt { deployment: String, attempt: u32 },
    AllHealthy,
    Failed { unhealthy: Vec<PodHealth> },
}

/// Wait for a single deployment to have all replicas ready.
pub async fn wait_for_rollout(
    client: &Client,
    namespace: &str,
    name: &str,
    timeout: Duration,
) -> Result<()> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let start = tokio::time::Instant::now();

    loop {
        if start.elapsed() > timeout {
            anyhow::bail!("timeout waiting for deployment {} rollout", name);
        }

        let deploy = api.get(name).await?;
        let status = deploy.status.as_ref();
        let desired = status
            .and_then(|s| s.replicas)
            .unwrap_or(1);
        let ready = status
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0);

        if ready >= desired && desired > 0 {
            return Ok(());
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Poll all deployments, send health events, auto-recover crashed pods.
pub async fn poll_health(
    client: &Client,
    namespace: &str,
    deployment_names: &[&str],
    tx: mpsc::UnboundedSender<HealthEvent>,
) -> Result<()> {
    let pod_api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let mut recovery_attempts: std::collections::HashMap<String, u32> = Default::default();

    let start = tokio::time::Instant::now();

    loop {
        let mut all_healthy = true;
        let mut unhealthy = Vec::new();

        for deploy_name in deployment_names {
            let lp = ListParams::default().labels(&format!("app={}", deploy_name));
            let pods = pod_api.list(&lp).await?;

            for pod in &pods.items {
                let pod_name = pod.metadata.name.clone().unwrap_or_default();
                let status = pod.status.as_ref();
                let phase = status
                    .and_then(|s| s.phase.clone())
                    .unwrap_or_else(|| "Unknown".into());

                let container_statuses = status
                    .and_then(|s| s.container_statuses.clone())
                    .unwrap_or_default();

                let ready = container_statuses.iter().all(|cs| cs.ready);
                let restarts: i32 = container_statuses.iter().map(|cs| cs.restart_count).sum();
                let image = container_statuses
                    .first()
                    .map(|cs| cs.image.clone())
                    .unwrap_or_default();

                // Check for CrashLoopBackOff
                let is_crash_loop = container_statuses.iter().any(|cs| {
                    cs.state.as_ref().map_or(false, |s| {
                        s.waiting.as_ref().map_or(false, |w| {
                            w.reason.as_deref() == Some("CrashLoopBackOff")
                        })
                    })
                });

                let mut error = None;
                if is_crash_loop {
                    error = Some("CrashLoopBackOff".into());
                    let attempts = recovery_attempts.entry(deploy_name.to_string()).or_insert(0);

                    if *attempts < MAX_RECOVERY_ATTEMPTS {
                        *attempts += 1;
                        tx.send(HealthEvent::RecoveryAttempt {
                            deployment: deploy_name.to_string(),
                            attempt: *attempts,
                        }).ok();

                        // Fetch logs before deleting
                        let logs = pod_api.logs(&pod_name, &LogParams {
                            tail_lines: Some(50),
                            ..Default::default()
                        }).await.unwrap_or_default();

                        // Delete pod to trigger recreation
                        pod_api.delete(&pod_name, &DeleteParams::default()).await.ok();
                    }
                }

                let health = PodHealth {
                    name: pod_name,
                    deployment: deploy_name.to_string(),
                    ready,
                    phase,
                    image,
                    restarts,
                    error: error.clone(),
                    logs_tail: None,
                };

                if !ready {
                    all_healthy = false;
                    unhealthy.push(health.clone());
                }

                tx.send(HealthEvent::PodUpdate(health)).ok();
            }
        }

        if all_healthy && !deployment_names.is_empty() {
            tx.send(HealthEvent::AllHealthy).ok();
            return Ok(());
        }

        if start.elapsed() > POD_TIMEOUT {
            // Fetch logs for unhealthy pods
            for pod in &mut unhealthy {
                let logs = pod_api.logs(&pod.name, &LogParams {
                    tail_lines: Some(5),
                    ..Default::default()
                }).await.unwrap_or_default();
                pod.logs_tail = Some(logs);
            }
            tx.send(HealthEvent::Failed { unhealthy }).ok();
            return Ok(());
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
```

**Step 2: Verify compilation**

Run: `cd tools/installer && cargo build`
Expected: Compiles successfully

**Step 3: Commit**

```bash
git add tools/installer/src/health.rs
git commit -m "feat(installer): health check polling with auto-recovery"
```

---

## Task 8: TUI Rendering

**Files:**
- Create: `tools/installer/src/tui.rs`

**Step 1: Build the ratatui rendering layer**

File: `tools/installer/src/tui.rs`

This is the largest module. It handles terminal setup/teardown and renders each phase screen. Key structure:

```rust
use crossterm::{
    event::{self, Event, KeyCode, KeyEvent},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Gauge, List, ListItem, Paragraph},
    Frame, Terminal,
};
use std::io::stdout;

use crate::app::{App, Phase, ItemStatus};

// Baker Street color palette
const BG: Color = Color::Rgb(26, 26, 46);         // #1a1a2e
const FG: Color = Color::Rgb(224, 224, 224);       // #e0e0e0
const ACCENT: Color = Color::Rgb(233, 69, 96);     // #e94560
const SUCCESS: Color = Color::Rgb(74, 222, 128);   // #4ade80
const WARNING: Color = Color::Rgb(251, 191, 36);   // #fbbf24
const INFO: Color = Color::Rgb(126, 200, 227);     // #7ec8e3
const MUTED: Color = Color::Rgb(102, 102, 102);    // #666666

pub struct Tui {
    terminal: Terminal<CrosstermBackend<std::io::Stdout>>,
}

impl Tui {
    pub fn new() -> anyhow::Result<Self> {
        enable_raw_mode()?;
        stdout().execute(EnterAlternateScreen)?;
        let backend = CrosstermBackend::new(stdout());
        let terminal = Terminal::new(backend)?;
        Ok(Self { terminal })
    }

    pub fn restore(&mut self) -> anyhow::Result<()> {
        disable_raw_mode()?;
        stdout().execute(LeaveAlternateScreen)?;
        Ok(())
    }

    pub fn draw(&mut self, app: &App) -> anyhow::Result<()> {
        self.terminal.draw(|frame| render(frame, app))?;
        Ok(())
    }
}

impl Drop for Tui {
    fn drop(&mut self) {
        self.restore().ok();
    }
}

fn render(frame: &mut Frame, app: &App) {
    let size = frame.area();

    // Three-zone layout: header, main, status bar
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),    // header
            Constraint::Min(10),     // main panel
            Constraint::Length(3),    // status bar
        ])
        .split(size);

    render_header(frame, chunks[0], app);
    render_phase(frame, chunks[1], app);
    render_status_bar(frame, chunks[2], app);
}

fn render_header(frame: &mut Frame, area: Rect, app: &App) {
    let title = format!(
        " Baker Street Installer v{} ",
        env!("CARGO_PKG_VERSION")
    );
    let cluster = format!(" {} ", app.cluster_name);

    let header = Paragraph::new(Line::from(vec![
        Span::styled(title, Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)),
        Span::styled("─".repeat(area.width.saturating_sub(40) as usize), Style::default().fg(MUTED)),
        Span::styled(cluster, Style::default().fg(INFO)),
    ]))
    .block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(MUTED)));

    frame.render_widget(header, area);
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let phase_text = format!(
        "  Phase {}/{}: {}",
        app.phase.index() + 1,
        Phase::total(),
        app.phase.label(),
    );

    let keys = match app.phase {
        Phase::Secrets => "Enter to submit",
        Phase::Features => "↑↓ move  Space toggle  Enter ▸",
        Phase::Confirm => "←→ select  Enter ▸",
        Phase::Complete => "o open browser  q quit",
        _ => "Enter ▸",
    };

    let bar = Paragraph::new(Line::from(vec![
        Span::styled(phase_text, Style::default().fg(FG)),
        Span::raw("  "),
        Span::styled(
            format!("{:>width$}", keys, width = area.width.saturating_sub(30) as usize),
            Style::default().fg(MUTED),
        ),
    ]))
    .block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(MUTED)));

    frame.render_widget(bar, area);
}

fn render_phase(frame: &mut Frame, area: Rect, app: &App) {
    // Each phase has its own render function.
    // Implementation delegates to render_preflight, render_secrets, etc.
    // These are populated in subsequent tasks as each phase is wired up.
    let placeholder = Paragraph::new(format!("Phase: {} (rendering TODO)", app.phase.label()))
        .style(Style::default().fg(FG).bg(BG))
        .block(Block::default().borders(Borders::NONE));
    frame.render_widget(placeholder, area);
}
```

Note: The per-phase render functions (`render_preflight`, `render_secrets`, `render_features`, `render_confirm`, `render_pull`, `render_deploy`, `render_health`, `render_complete`) are large. Each will be implemented in the following tasks as we wire up each phase. The structure above provides the shell that all phases plug into.

**Step 2: Wire TUI into main.rs**

Update `tools/installer/src/main.rs`:

```rust
mod app;
mod cli;
mod health;
mod images;
mod k8s;
mod manifest;
mod templates;
mod tui;

use anyhow::Result;
use clap::Parser;
use cli::Cli;
use app::App;
use tui::Tui;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    if cli.status {
        println!("Status mode not yet implemented");
        return Ok(());
    }
    if cli.uninstall {
        println!("Uninstall mode not yet implemented");
        return Ok(());
    }

    if cli.non_interactive {
        println!("Baker Street Installer v{}", env!("CARGO_PKG_VERSION"));
        println!("Non-interactive mode not yet implemented");
        return Ok(());
    }

    // Interactive TUI mode
    let mut app = App::new(cli.namespace.clone());
    let mut tui = Tui::new()?;

    loop {
        tui.draw(&app)?;

        if let crossterm::event::Event::Key(key) = crossterm::event::read()? {
            match key.code {
                crossterm::event::KeyCode::Char('q') => break,
                crossterm::event::KeyCode::Enter => {
                    if !app.advance() {
                        break; // Complete phase, exit
                    }
                }
                _ => {}
            }
        }

        if app.should_quit {
            break;
        }
    }

    tui.restore()?;
    Ok(())
}
```

**Step 3: Verify it compiles and renders**

Run: `cd tools/installer && cargo build`
Expected: Compiles successfully

Run: `cargo run` (manually verify TUI appears, press `q` to quit)
Expected: Full-screen TUI with header, placeholder main panel, status bar

**Step 4: Commit**

```bash
git add tools/installer/src/tui.rs tools/installer/src/main.rs
git commit -m "feat(installer): ratatui TUI shell with header, status bar, phase routing"
```

---

## Task 9: Wire Up All Phases (Preflight → Complete)

**Files:**
- Modify: `tools/installer/src/tui.rs` (add per-phase render functions)
- Modify: `tools/installer/src/app.rs` (add phase-specific state: secret inputs, feature selections, pull progress, deploy progress, health results)
- Modify: `tools/installer/src/main.rs` (wire async operations to phases)

This is the largest task. The implementing engineer should work phase by phase:

**Step 1: Preflight phase**
- On Enter: run `k8s::check_cluster()`, check Docker (`docker info`), fetch manifest
- Render: checkmarks for each check with result text
- Auto-advance on success

**Step 2: Secrets phase**
- Render one secret prompt at a time (text input with cursor)
- Handle character input, backspace, Enter to submit
- Mask password fields with `•`
- Show completed fields with masked values
- Check env vars first — skip prompt if already set
- Auto-generate AUTH_TOKEN

**Step 3: Features phase**
- Render checkbox list from manifest's `optionalFeatures`
- Arrow keys to navigate, Space to toggle, Enter to confirm
- After confirm: prompt for each selected feature's secrets

**Step 4: Confirm phase**
- Render summary card (box-drawing characters)
- Masked secret values via `templates::mask_secret()`
- Two buttons: Confirm / Cancel
- Cancel calls `app.back_to_secrets()`

**Step 5: Pull phase**
- Launch `images::pull_all()` in a tokio task
- Receive `PullEvent` messages on channel
- Update per-image status in app state
- Render progress bar + per-image list
- Auto-advance when all done

**Step 6: Deploy phase**
- Sequentially apply templates via `k8s::apply_yaml()`
- After each resource: `health::wait_for_rollout()`
- Update per-resource status in app state
- Render progress bar + per-resource list

**Step 7: Health phase**
- Launch `health::poll_health()` in a tokio task
- Receive `HealthEvent` messages
- Render per-pod status with colors
- Show recovery attempts
- Auto-advance when all healthy

**Step 8: Complete phase**
- Render success message + URLs
- Handle `o` key: `open::that("http://localhost:30080")`
- Handle `Enter`/`q`: exit

**Step 9: Verify full flow**

Run: `cargo run` and walk through all 8 phases manually against the live cluster.
Expected: Full deploy completes, all pods healthy, UI accessible at :30080

**Step 10: Commit**

```bash
git add tools/installer/
git commit -m "feat(installer): wire all 8 TUI phases end-to-end"
```

---

## Task 10: Non-Interactive Mode

**Files:**
- Modify: `tools/installer/src/main.rs`

**Step 1: Add plain-text output path**

When `--non-interactive` is set, skip TUI and run all phases with log-line output:

```rust
if cli.non_interactive {
    run_non_interactive(&cli).await?;
    return Ok(());
}
```

```rust
async fn run_non_interactive(cli: &Cli) -> Result<()> {
    println!("[1/8] Preflight checks...");
    // check cluster, docker, fetch manifest
    println!("[2/8] Secrets: loading from environment...");
    // read ANTHROPIC_OAUTH_TOKEN, etc. from env
    println!("[3/8] Features: from environment...");
    // auto-enable features that have env vars set
    println!("[4/8] Confirm: deploying Baker Street v{}...", version);
    println!("[5/8] Pulling images...");
    // pull_all with simple progress
    println!("[6/8] Deploying resources...");
    // apply all templates
    println!("[7/8] Health check...");
    // poll health
    println!("[8/8] Complete! UI: http://localhost:30080");
    Ok(())
}
```

**Step 2: Commit**

```bash
git add tools/installer/src/main.rs
git commit -m "feat(installer): non-interactive mode for CI"
```

---

## Task 11: Uninstall + Status Commands

**Files:**
- Modify: `tools/installer/src/main.rs`
- Modify: `tools/installer/src/k8s.rs` (add `get_deployments_status`)

**Step 1: Implement --uninstall**

TUI-based confirmation, then `k8s::delete_namespace()` for both namespaces.

**Step 2: Implement --status**

Fetch all deployments in namespace, display pod health table. JSON output if `--non-interactive`.

**Step 3: Commit**

```bash
git add tools/installer/
git commit -m "feat(installer): --uninstall and --status commands"
```

---

## Task 12: Sysadmin Pod Changes

**Files:**
- Modify: `services/sysadmin/src/state-machine.ts` (add `verify` state, remove `deploy`)
- Delete: `services/sysadmin/prompts/deploy.md`
- Modify: `services/sysadmin/src/tool-registry.ts` (remove deploy tools from verify/runtime)
- Modify: `services/sysadmin/src/index.ts` (handle verify → runtime transition)
- Create: `services/sysadmin/prompts/verify.md`

**Step 1: Add verify prompt**

File: `services/sysadmin/prompts/verify.md`

```markdown
# Baker Street SysAdmin — Verify Mode

You have just been deployed by the Baker Street installer. Run a one-time health check on all services.

## Procedure

1. Use `check_pod_health` to verify all pods are running and ready
2. Use `verify_running_digests` to confirm image integrity (if manifest is available)
3. Report the results briefly
4. Call `transition_to_runtime` to enter monitoring mode

If any pod is unhealthy, report the issue but still transition to runtime — the runtime health timer will continue monitoring.
```

**Step 2: Update state machine**

Remove `deploy` from valid states. Add `verify` with transition to `runtime`. Update `VALID_TRANSITIONS`.

**Step 3: Update tool registry**

`verify` state gets the same tools as `runtime` plus `transition_to_runtime`.

**Step 4: Update index.ts**

When initial state is `verify`, auto-trigger a chat message: "Run initial health verification."

**Step 5: Rebuild sysadmin image**

```bash
docker build -t bakerst-sysadmin:latest -f services/sysadmin/Dockerfile .
```

**Step 6: Commit**

```bash
git add services/sysadmin/
git commit -m "feat(sysadmin): replace deploy mode with verify mode"
```

---

## Task 13: CI Pipeline — Cross-Compile + Release

**Files:**
- Modify: `.github/workflows/release.yml`
- Create: `scripts/install.sh`

**Step 1: Add installer build job to release workflow**

Add a `build-installer` job with a matrix strategy for 4 targets. Use `dtolnay/rust-toolchain` and `cross` for ARM64 Linux. Upload binaries + checksums to the GitHub Release.

**Step 2: Create install.sh convenience script**

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="The-Baker-Street-Project/baker-street"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  linux-x86_64)  BINARY="bakerst-install-linux-amd64" ;;
  linux-aarch64) BINARY="bakerst-install-linux-arm64" ;;
  darwin-x86_64) BINARY="bakerst-install-darwin-amd64" ;;
  darwin-arm64)  BINARY="bakerst-install-darwin-arm64" ;;
  *) echo "Unsupported platform: $OS-$ARCH"; exit 1 ;;
esac

URL="https://github.com/$REPO/releases/latest/download/$BINARY"
echo "Downloading $BINARY..."
curl -fsSL "$URL" -o bakerst-install
chmod +x bakerst-install
echo "Running installer..."
./bakerst-install
```

**Step 3: Commit**

```bash
git add .github/workflows/release.yml scripts/install.sh
git commit -m "ci: cross-compile Rust installer for 4 targets + install.sh"
```

---

## Task 14: Integration Test — Full Deploy Cycle

**Files:**
- Create: `tools/installer/tests/integration.rs`

**Step 1: Write an integration test that exercises the non-interactive flow**

```rust
#[tokio::test]
#[ignore] // Only runs with `cargo test -- --ignored` (needs live cluster)
async fn full_deploy_cycle() {
    // 1. Run installer in non-interactive mode
    // 2. Verify all pods are healthy
    // 3. Run --status and check output
    // 4. Run --uninstall
    // 5. Verify namespace is gone
}
```

**Step 2: Manual verification checklist**

- [ ] `cargo run` — full TUI flow completes
- [ ] All 9 pods healthy after deploy
- [ ] Qdrant uses PVC (no hostPath crash)
- [ ] `cargo run -- --status` shows all green
- [ ] `cargo run -- --uninstall` cleans up both namespaces
- [ ] `cargo run -- --non-interactive` with env vars works
- [ ] Ctrl+C during pull phase exits cleanly

**Step 3: Commit**

```bash
git add tools/installer/tests/
git commit -m "test(installer): integration test for full deploy cycle"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Scaffold + CLI | Cargo.toml, main.rs, cli.rs |
| 2 | State machine | app.rs |
| 3 | Manifest fetch | manifest.rs |
| 4 | Template engine | templates.rs, templates/*.yaml |
| 5 | Image pulling | images.rs |
| 6 | K8s API client | k8s.rs, os_files/ |
| 7 | Health checks | health.rs |
| 8 | TUI rendering | tui.rs |
| 9 | Wire all phases | main.rs, tui.rs, app.rs |
| 10 | Non-interactive | main.rs |
| 11 | Uninstall + status | main.rs, k8s.rs |
| 12 | Sysadmin changes | services/sysadmin/ |
| 13 | CI pipeline | release.yml, install.sh |
| 14 | Integration test | tests/integration.rs |
