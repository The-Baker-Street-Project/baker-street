# Embedded Manifest Installer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Embed the release manifest directly in the installer binary so `cargo build && ./bakerst-install` always reflects current code — no runtime GitHub fetch, no stale data.

**Architecture:** A checked-in `tools/installer/release-manifest.json` is embedded via `include_str!` at compile time. The runtime manifest resolution is: `--manifest <file>` override OR embedded manifest. That's it. `fetch_manifest()`, `default_manifest()`, `--release-version`, `reqwest`, and `chrono` are all removed. `scripts/generate-manifest.mjs` is deleted.

**Tech Stack:** Rust (build.rs, include_str!), serde_json

---

### Task 1: Create the canonical release-manifest.json

**Files:**
- Create: `tools/installer/release-manifest.json`

**Step 1: Create the manifest file**

This is the single source of truth for everything the installer shows to users: secret prompts, feature lists, image references, defaults. Content derived from the current `default_manifest()` in `manifest.rs` and the live GitHub release manifest, with OAuth removed and DEFAULT_MODEL added (from PR #30).

```json
{
  "schemaVersion": 1,
  "version": "0.2.0",
  "images": [
    { "component": "brain", "image": "ghcr.io/the-baker-street-project/bakerst-brain:0.1.0", "version": "0.1.0", "required": true },
    { "component": "worker", "image": "ghcr.io/the-baker-street-project/bakerst-worker:0.1.0", "version": "0.1.0", "required": true },
    { "component": "ui", "image": "ghcr.io/the-baker-street-project/bakerst-ui:0.1.0", "version": "0.1.0", "required": true },
    { "component": "gateway", "image": "ghcr.io/the-baker-street-project/bakerst-gateway:0.1.0", "version": "0.1.0", "required": true },
    { "component": "sysadmin", "image": "ghcr.io/the-baker-street-project/bakerst-sysadmin:0.1.0", "version": "0.1.0", "required": false },
    { "component": "ext-utilities", "image": "ghcr.io/the-baker-street-project/bakerst-ext-utilities:0.1.0", "version": "0.1.0", "required": false },
    { "component": "ext-github", "image": "ghcr.io/the-baker-street-project/bakerst-ext-github:0.1.0", "version": "0.1.0", "required": false },
    { "component": "ext-obsidian", "image": "ghcr.io/the-baker-street-project/bakerst-ext-obsidian:0.1.0", "version": "0.1.0", "required": false },
    { "component": "ext-toolbox", "image": "ghcr.io/the-baker-street-project/bakerst-ext-toolbox:0.1.0", "version": "0.1.0", "required": false },
    { "component": "ext-browser", "image": "ghcr.io/the-baker-street-project/bakerst-ext-browser:0.1.0", "version": "0.1.0", "required": false }
  ],
  "requiredSecrets": [
    {
      "key": "ANTHROPIC_API_KEY",
      "description": "Anthropic API key for Claude",
      "required": true,
      "inputType": "secret",
      "targetSecrets": ["bakerst-brain-secrets", "bakerst-worker-secrets"]
    },
    {
      "key": "DEFAULT_MODEL",
      "description": "Default model for the agent",
      "required": false,
      "inputType": "choice",
      "targetSecrets": ["bakerst-brain-secrets", "bakerst-worker-secrets"]
    },
    {
      "key": "AUTH_TOKEN",
      "description": "API auth token (auto-generated if not provided)",
      "required": false,
      "inputType": "secret",
      "targetSecrets": ["bakerst-brain-secrets", "bakerst-gateway-secrets"]
    },
    {
      "key": "AGENT_NAME",
      "description": "AI persona name",
      "required": false,
      "inputType": "text",
      "targetSecrets": ["bakerst-brain-secrets", "bakerst-worker-secrets"]
    }
  ],
  "optionalFeatures": [
    {
      "id": "telegram",
      "name": "Telegram Gateway",
      "description": "Enable Telegram bot adapter",
      "defaultEnabled": false,
      "secrets": ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_CHAT_IDS"]
    },
    {
      "id": "discord",
      "name": "Discord Gateway",
      "description": "Enable Discord bot adapter",
      "defaultEnabled": false,
      "secrets": ["DISCORD_BOT_TOKEN"]
    },
    {
      "id": "voyage",
      "name": "Voyage Embeddings",
      "description": "Enable Voyage AI for long-term memory embeddings",
      "defaultEnabled": true,
      "secrets": ["VOYAGE_API_KEY"]
    },
    {
      "id": "github",
      "name": "GitHub Extension",
      "description": "Enable GitHub integration extension",
      "defaultEnabled": false,
      "secrets": ["GITHUB_TOKEN"]
    },
    {
      "id": "perplexity",
      "name": "Perplexity Search",
      "description": "Enable Perplexity AI search and research tools",
      "defaultEnabled": false,
      "secrets": ["PERPLEXITY_API_KEY"]
    },
    {
      "id": "obsidian",
      "name": "Obsidian Extension",
      "description": "Enable Obsidian vault integration",
      "defaultEnabled": false,
      "secrets": ["OBSIDIAN_VAULT_PATH"]
    }
  ],
  "defaults": {
    "agentName": "Baker",
    "namespace": "bakerst",
    "resourceProfile": "standard"
  }
}
```

**Step 2: Commit**

```bash
git add tools/installer/release-manifest.json
git commit -m "feat(installer): add canonical release-manifest.json"
```

---

### Task 2: Simplify the ReleaseManifest struct and embed the manifest

**Files:**
- Modify: `tools/installer/src/manifest.rs` (rewrite)

**Step 1: Write tests for the new manifest module**

Replace the entire test module in `manifest.rs`. The tests validate: embedded manifest parses correctly, has required images, has required secrets including ANTHROPIC_API_KEY and DEFAULT_MODEL, has features, and load-from-file still works.

```rust
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
```

**Step 2: Run tests to verify they fail**

```bash
cd tools/installer && cargo test manifest -- --nocapture
```

Expected: compilation error — `embedded_manifest` doesn't exist yet.

**Step 3: Rewrite manifest.rs**

Replace the entire file. Remove `fetch_manifest()`, `default_manifest()`, the `image()` helper. Remove all `reqwest` and `chrono` usage. The struct drops `date`, `min_sysadmin_version`, `release_notes`, `checksums`, and `digest` from `ManifestImage` — all made optional via `#[serde(default)]` so the file can still include them without breaking.

```rust
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
        assert_eq!(required.len(), 4);
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
```

**Step 4: Run tests to verify they pass**

```bash
cd tools/installer && cargo test manifest -- --nocapture
```

Expected: all 6 tests pass.

**Step 5: Commit**

```bash
git add tools/installer/src/manifest.rs
git commit -m "feat(installer): embed manifest at compile time, remove fetch_manifest"
```

---

### Task 3: Remove `--release-version` CLI flag

**Files:**
- Modify: `tools/installer/src/cli.rs`

**Step 1: Remove the release_version field**

Delete lines 6-8 from `cli.rs`:

```rust
    /// Install a specific release version (default: latest)
    #[arg(long = "release", value_name = "TAG")]
    pub release_version: Option<String>,
```

**Step 2: Fix compilation errors in main.rs**

Find and remove the two references to `cli.release_version` in `main.rs`:

- Line 152: `manifest::fetch_manifest(cli.release_version.as_deref())` — this entire block is replaced in Task 4.
- Line 1093: same pattern — replaced in Task 4.

Since Task 4 rewrites these blocks, this step only removes the field from `cli.rs`. Compilation may break until Task 4 is done — that's OK, we fix it immediately in the next task.

**Step 3: Commit (with Task 4)**

Committed together with Task 4 since they're interdependent.

---

### Task 4: Simplify manifest loading in main.rs

**Files:**
- Modify: `tools/installer/src/main.rs` (two locations)

**Step 1: Simplify `run_preflight()`**

Replace lines 146-159 in `main.rs` (the manifest fetch block):

```rust
    // OLD:
    // Check 3: Fetch/load manifest
    app.preflight_checks
        .push(("Release manifest".into(), ItemStatus::InProgress));
    let manifest_result = if let Some(ref path) = cli.manifest {
        manifest::load_manifest_from_file(path).map_err(|e| e.to_string())
    } else {
        match manifest::fetch_manifest(cli.release_version.as_deref()).await {
            Ok(m) => Ok(m),
            Err(_) => {
                // Fallback to default manifest
                Ok(manifest::default_manifest())
            }
        }
    };
```

Replace with:

```rust
    // Check 3: Load manifest
    app.preflight_checks
        .push(("Release manifest".into(), ItemStatus::InProgress));
    let manifest_result: Result<ReleaseManifest, String> = if let Some(ref path) = cli.manifest {
        manifest::load_manifest_from_file(path).map_err(|e| e.to_string())
    } else {
        manifest::embedded_manifest().map_err(|e| e.to_string())
    };
```

**Step 2: Simplify `run_non_interactive()`**

Find the manifest loading block in `run_non_interactive()` (around line 1088-1099):

```rust
    // OLD:
    let manifest = if let Some(ref path) = cli.manifest {
        manifest::load_manifest_from_file(path)?
    } else {
        manifest::fetch_manifest(cli.release_version.as_deref())
            .await
            .unwrap_or_else(|_| {
                println!("  WARNING: Could not fetch manifest, using defaults");
                manifest::default_manifest()
            })
    };
```

Replace with:

```rust
    let manifest = if let Some(ref path) = cli.manifest {
        manifest::load_manifest_from_file(path)?
    } else {
        manifest::embedded_manifest()?
    };
```

**Step 3: Check for any other references to removed functions**

Search for `fetch_manifest`, `default_manifest`, `release_version` in main.rs. There should be zero remaining.

```bash
cd tools/installer && grep -n 'fetch_manifest\|default_manifest\|release_version' src/main.rs
```

Expected: no output.

**Step 4: Run full test suite**

```bash
cd tools/installer && cargo test
```

Expected: all tests pass, no compilation errors.

**Step 5: Commit**

```bash
git add tools/installer/src/cli.rs tools/installer/src/main.rs
git commit -m "feat(installer): use embedded manifest, remove GitHub fetch and --release flag"
```

---

### Task 5: Remove `reqwest` and `chrono` dependencies

**Files:**
- Modify: `tools/installer/Cargo.toml`

**Step 1: Remove the dependencies**

Remove these two lines from Cargo.toml:

```toml
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
chrono = "0.4"
```

**Step 2: Verify no remaining references**

```bash
cd tools/installer && grep -rn 'reqwest\|chrono' src/
```

Expected: no output (both were only used in the deleted `fetch_manifest` and `default_manifest` functions).

**Step 3: Build and test**

```bash
cd tools/installer && cargo test
```

Expected: all tests pass. Binary should be noticeably smaller.

**Step 4: Commit**

```bash
git add tools/installer/Cargo.toml
git commit -m "chore(installer): remove reqwest and chrono dependencies"
```

---

### Task 6: Delete generate-manifest.mjs and update release workflow

**Files:**
- Delete: `scripts/generate-manifest.mjs`
- Modify: `.github/workflows/release.yml`

**Step 1: Delete generate-manifest.mjs**

```bash
git rm scripts/generate-manifest.mjs
```

**Step 2: Update release.yml**

In the `create-release` job, remove:

1. The `actions/setup-node@v4` step (lines 238-240) — no longer needed for manifest generation.
2. The `Download digest artifacts` step (lines 242-247) — no longer needed.
3. The `Read digests` step (lines 249-255) — no longer needed.
4. The `Generate release manifest` step (lines 257-284) — the manifest is now in the binary.

Replace with a step that copies the checked-in manifest as a release asset for reference:

```yaml
      - name: Attach manifest to release
        run: cp tools/installer/release-manifest.json release-manifest.json

```

Keep the `Download SBOMs` and `Create GitHub Release` steps. Update `Create GitHub Release` files list — it still includes `release-manifest.json` and `sbom-*.spdx.json`.

The `build-and-push` job still needs to upload digest artifacts (they're used for cosign signing), but the `create-release` job no longer downloads them for manifest generation. However, since `build-and-push` uploads them and nothing else uses them in `create-release`, we can remove the download steps from `create-release`. The digests are still saved by `build-and-push` for its own cosign signing step.

**Step 3: Verify the workflow is valid YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "valid"
```

**Step 4: Commit**

```bash
git add -A scripts/generate-manifest.mjs .github/workflows/release.yml
git commit -m "chore: delete generate-manifest.mjs, simplify release workflow"
```

---

### Task 7: Build, verify, and do a final end-to-end check

**Files:** None (verification only)

**Step 1: Full rebuild**

```bash
cd tools/installer && cargo build --release 2>&1 | tail -5
```

Expected: compiles successfully with no warnings about unused deps.

**Step 2: Run full test suite**

```bash
cd tools/installer && cargo test
```

Expected: all tests pass.

**Step 3: Verify no remaining references to deleted code**

```bash
grep -rn 'fetch_manifest\|default_manifest\|generate-manifest\|reqwest\|chrono' tools/installer/src/ scripts/ 2>/dev/null | grep -v '.md' | grep -v 'target/'
```

Expected: no output.

**Step 4: Verify the binary uses the embedded manifest**

Run the installer with `--help` to verify it no longer has `--release`:

```bash
./tools/installer/target/release/bakerst-install --help
```

Expected: no `--release` flag in output.

**Step 5: Commit (if any fixups needed)**

Only if previous steps revealed issues.

---

## Verification Summary

After all tasks, confirm:
- `cargo test` — all tests pass
- `grep -ri 'fetch_manifest\|default_manifest' tools/installer/src/` — zero results
- `grep -ri 'reqwest\|chrono' tools/installer/src/ tools/installer/Cargo.toml` — zero results
- `ls scripts/generate-manifest.mjs` — file not found
- `bakerst-install --help` — no `--release` flag
- Binary size decreased (reqwest+TLS removed)
