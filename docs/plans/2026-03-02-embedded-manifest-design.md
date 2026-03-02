# Design: Embedded Manifest Installer

**Date:** 2026-03-02
**Status:** Approved

## Problem

The installer fetches `release-manifest.json` from GitHub Releases at runtime. When code changes are merged (e.g., removing OAuth, adding model selection), the manifest on GitHub remains stale until a new release is cut. This means `cargo build --release && ./bakerst-install` shows old prompts, old secret descriptions, and old features — even though the code was just updated.

This has caused repeated failures where the installer doesn't reflect merged changes, requiring multiple sessions to debug.

## Solution

Embed the manifest directly in the binary at compile time. One source of truth: a `release-manifest.json` file checked into the repo at `tools/installer/release-manifest.json`.

## Architecture

### Manifest Resolution (new)

```
1. --manifest <path>  →  load from file (override)
2. (default)          →  use embedded manifest (compiled into binary)
```

That's it. No runtime GitHub fetch. No fallback chain.

### Build Flow

```
edit release-manifest.json  →  cargo build  →  binary contains manifest  →  run installer  →  correct prompts
```

A Rust `build.rs` script validates the JSON at compile time. The binary embeds the manifest via `include_str!`.

### What the Embedded Manifest Contains

- `schemaVersion` — manifest format version
- `version` — release version string
- `images[]` — component name, GHCR image ref, version, required flag
- `requiredSecrets[]` — key, description, required flag, input type, target K8s secrets
- `optionalFeatures[]` — id, name, description, default enabled, required secrets
- `defaults` — agent name, namespace, resource profile

**Removed fields** (were only useful for sysadmin pod or verification):
- `date`, `releaseNotes`, `minSysadminVersion`
- `prompts` (content hashes of system prompt files)
- `checksums`, `digest` (image digest verification)

### Files Changed

| Action | File | What |
|--------|------|------|
| Create | `tools/installer/release-manifest.json` | Canonical manifest, checked into repo |
| Create | `tools/installer/build.rs` | Validates JSON at compile time, embeds via include_str |
| Modify | `tools/installer/src/manifest.rs` | Remove `fetch_manifest()`, `default_manifest()`. Add `embedded_manifest()` |
| Modify | `tools/installer/src/main.rs` | Remove GitHub fetch logic, simplify preflight |
| Modify | `tools/installer/src/cli.rs` | Remove `--release-version` flag |
| Modify | `tools/installer/Cargo.toml` | Remove `reqwest` dependency, add build.rs |
| Delete | `scripts/generate-manifest.mjs` | No longer needed |
| Modify | `.github/workflows/release.yml` | Remove manifest generation step |

### Dependency Reduction

Removing `reqwest` eliminates the HTTP client, TLS stack, and related dependencies. This reduces compile time and binary size significantly.

### Release Workflow Changes

1. **build-and-push** — unchanged (builds Docker images)
2. **build-installer** — unchanged (compiles binary, now with manifest baked in)
3. **create-release** — remove `generate-manifest.mjs` step. Optionally attach `release-manifest.json` as a release asset for reference.

Version bumps: update `tools/installer/release-manifest.json` image versions as part of release prep commit.

### ReleaseManifest Struct Simplification

Remove fields the installer doesn't use:

```rust
pub struct ReleaseManifest {
    pub schema_version: u32,
    pub version: String,
    pub images: Vec<ManifestImage>,
    pub required_secrets: Vec<ManifestSecret>,
    pub optional_features: Vec<ManifestFeature>,
    pub defaults: ManifestDefaults,
}
```

`ManifestImage` drops `digest`. `ReleaseManifest` drops `date`, `min_sysadmin_version`, `release_notes`, `checksums`, `prompts`.
