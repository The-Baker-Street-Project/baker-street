# Baker Street Rust Installer — Design Document

**Date:** 2026-02-28
**Status:** Approved
**Replaces:** AI-based sysadmin deploy mode, deploy-all.sh, secrets.sh, bootstrap.sh

## Motivation

The AI-based sysadmin installer proved unreliable for deployment:
- No real-time progress without user prompting
- Failed to detect/fix crashed pods (Qdrant crash went unnoticed)
- Non-deterministic behavior — prompt tweaks don't guarantee consistency
- Confusing status messages

Deployment is a deterministic pipeline. Same inputs should always produce the same outputs. A Rust binary provides guaranteed progress, automatic error recovery, and a polished TUI.

## Decision

**Approach A: Monolithic Binary** — single `bakerst-install` binary with all K8s manifests embedded, native K8s API via `kube` crate, parallel image pulls, full-screen ratatui TUI. No external dependencies beyond a reachable K8s cluster and Docker daemon.

The AI sysadmin pod keeps its runtime monitoring role but loses deploy mode entirely.

## Architecture

```
tools/installer/
├── Cargo.toml
├── src/
│   ├── main.rs              # Entry point, CLI args, launch TUI
│   ├── app.rs               # App state machine (phases + transitions)
│   ├── tui.rs               # ratatui rendering (layout, widgets, colors)
│   ├── manifest.rs          # Fetch + parse release manifest from GitHub
│   ├── secrets.rs           # Secret collection + validation
│   ├── images.rs            # Parallel image pulls via docker CLI
│   ├── k8s.rs               # K8s API client (kube crate)
│   ├── health.rs            # Poll pod health, retry crashed pods
│   ├── templates/           # Embedded K8s YAML templates
│   │   ├── namespace.yaml
│   │   ├── nats.yaml
│   │   ├── qdrant.yaml
│   │   ├── brain.yaml
│   │   ├── worker.yaml
│   │   ├── gateway.yaml
│   │   ├── ui.yaml
│   │   ├── sysadmin.yaml
│   │   ├── voice.yaml
│   │   ├── network-policies.yaml
│   │   └── pvcs.yaml
│   └── os_files/            # Embedded operating_system/ contents
│       ├── BRAIN.md
│       ├── WORKER.md
│       ├── SOUL.md
│       └── ...
```

### Key Dependencies

- `ratatui` + `crossterm` — full-screen TUI
- `kube` + `k8s-openapi` — native K8s API (no kubectl needed)
- `tokio` — async runtime for parallel image pulls + health polling
- `reqwest` — fetch release manifest from GitHub API
- `serde` + `serde_json` + `serde_yaml` — parse manifest + templates
- `clap` — CLI argument parsing

### Install Phases (State Machine)

```
Preflight → Secrets → Features → Confirm → Pull → Deploy → Health → Complete
```

Each phase owns its own TUI panel. Confirm can go back to Secrets on cancel. All other transitions are forward-only.

## TUI Design

### Layout

Three persistent zones:

```
┌─ Header (title + cluster name) ─────────────────────────────────┐
│  [Main Panel — changes per phase]                                │
├─ Status Bar (phase indicator + keybindings) ─────────────────────┤
```

### Color Palette

- Background: `#1a1a2e` (dark navy)
- Primary text: `#e0e0e0` (light gray)
- Accent/headers: `#e94560` (Baker Street red)
- Success: `#4ade80` (green)
- Warning: `#fbbf24` (amber)
- Info/links: `#7ec8e3` (cyan)
- Muted: `#666666` (gray)

### Phase Screens

**1. Preflight** — instant checks, no user input
- K8s cluster reachable (show context name)
- Docker daemon running (show version)
- Release manifest fetched (show version + image count)
- Namespace status (exists or will create)

**2. Secrets** — interactive prompts, one at a time
- ANTHROPIC_OAUTH_TOKEN (required, password masked)
- ANTHROPIC_API_KEY (optional, Enter to skip)
- AGENT_NAME (text, default: "Baker")
- AUTH_TOKEN (auto-generated, shown masked)
- Completed fields show masked values (****last4)

**3. Features** — multi-select checkboxes
- Telegram Gateway → TELEGRAM_BOT_TOKEN
- Discord Gateway → DISCORD_BOT_TOKEN
- Voyage Embeddings → VOYAGE_API_KEY
- GitHub Extension → GITHUB_TOKEN
- Obsidian Extension → OBSIDIAN_VAULT_PATH
- After selection, prompts for each selected feature's secrets

**4. Confirm** — summary card with masked keys
- Authentication section (OAuth, API Key)
- Configuration section (Agent Name, Auth Token)
- Features section (checkmarks/crosses)
- Components section (image count from manifest)
- Confirm / Cancel choice

**5. Pull** — parallel progress
- All images pulled concurrently (max 4 concurrent via tokio::JoinSet)
- Per-image status: queued → pulling → pulled (with time)
- Overall progress bar (N/total)
- Spinner animation on in-progress items

**6. Deploy** — sequential resource creation
- Progress bar with percentage
- Per-resource status: pending → creating → ready
- Real-time updates as each resource completes

**7. Health** — live pod monitoring
- Poll every 2 seconds
- Per-pod: name, replica count, image, status
- Auto-recovery for CrashLoopBackOff (up to 3 retries)
- Shows condensed error logs for failures

**8. Complete** — success screen
- Access URLs (UI, Brain API, SysAdmin)
- Auth token (masked)
- Agent name
- `o` to open browser, `Enter`/`q` to exit

## Error Handling & Retry Logic

### Image Pull Failures

- 3 retries per image, exponential backoff (2s, 4s, 8s)
- Max 4 concurrent pulls (tokio::JoinSet)
- Required image failure → stop and report
- Optional image failure → disable feature, warn

### K8s Resource Creation

- Create-or-update semantics (idempotent)
- 3 retries per API call with backoff
- AlreadyExists → patch instead
- Conflict → re-fetch, retry
- Rerunnable: crash mid-deploy, rerun picks up where it left off

### Pod Health Recovery

- Poll loop: every 2 seconds, 120s timeout per pod
- CrashLoopBackOff → delete pod (K8s recreates), retry 3x
- Fetch last 50 log lines on failure, display condensed (last 5)
- All green → proceed to Complete
- Failures → show summary, offer retry or abort

### Timeouts

| Operation | Timeout |
|-----------|---------|
| Manifest fetch | 15s |
| Image pull (each) | 120s |
| K8s API call | 10s |
| Pod rollout (each) | 180s |
| Overall install | 15 min |

### Ctrl+C

- Cancel in-progress operations
- Print summary of what was deployed
- Exit cleanly, resources already created remain

## K8s Resource Changes

### PVCs Replace hostPath

Three PVCs replace hardcoded macOS paths:

| PVC | Size | Replaces |
|-----|------|----------|
| `brain-data` | 1Gi | hostPath `/Users/gary/bakerst-data` |
| `qdrant-data` | 2Gi | hostPath `/Users/gary/bakerst-qdrant` |
| `gateway-data` | 512Mi | hostPath `/Users/gary/bakerst-data/gateway` |

Supported by Docker Desktop K8s (built-in hostpath provisioner), minikube, and all cloud K8s providers.

### Template Variables

| Variable | Source |
|----------|--------|
| `{{NAMESPACE}}` | Hardcoded `bakerst` |
| `{{IMAGE_*}}` | Release manifest (one per component) |
| `{{AGENT_NAME}}` | User input |
| `{{PVC_*}}` | Generated PVC names |

Secrets created via kube API directly (never templated into YAML).

### Deploy Sequence

1. Namespace
2. PVCs (wait for Bound)
3. RBAC (ServiceAccounts, Roles, RoleBindings)
4. Secrets (brain, worker, gateway, extensions)
5. ConfigMap bakerst-os
6. NATS config + deployment + service → wait ready
7. Qdrant deployment + service → wait ready
8. Brain deployment + service → wait ready
9. Worker deployment → wait ready
10. Gateway deployment (scale 0 if no adapters) → wait ready
11. UI deployment + service → wait ready
12. Voice deployment + service → wait ready
13. Sysadmin deployment + service + RBAC → wait ready
14. Extension deployments (if selected) → wait ready
15. Network policies (applied LAST)

### Sysadmin Pod Changes

- **Remove deploy mode** — delete prompts/deploy.md, remove deploy from state machine
- **New initial state: verify** — one-time health check, then transitions to runtime
- **Installer creates** state ConfigMap with `state: "verify"`
- **Deploy tools removed** — keeps only health/monitoring/integrity tools

New state machine:
```
verify → runtime → update → runtime
*      → shutdown
```

## CLI Interface

```
bakerst-install [OPTIONS]

Options:
  --version <TAG>         Install specific release (default: latest)
  --manifest <PATH>       Use local manifest file
  --non-interactive       Use defaults + env vars, no TUI
  --uninstall             Remove all Baker Street resources
  --status                Show deployment status and exit
  --data-dir <PATH>       Override PVC with hostPath
  --skip-telemetry        Skip telemetry stack
  --skip-extensions       Skip extension pods
  --namespace <NAME>      Override namespace (default: bakerst)
  -v, --verbose           Show debug log panel
  -h, --help              Print help
  -V, --version           Print installer version
```

### Non-Interactive Mode

All secrets via env vars. Plain log output (no TUI):
```
[1/8] Preflight checks... ok
[2/8] Secrets: 3 from env, 1 auto-generated
...
[8/8] Complete! UI: http://localhost:30080
```

### Uninstall

Deletes both namespaces (cascades to all resources) and PVCs. Requires confirmation.

### Status

Read-only health view of all pods with uptime. JSON output in non-interactive mode.

## Distribution

### Release Artifacts

Cross-compiled for 4 targets, attached to GitHub Releases:

| Target | Binary |
|--------|--------|
| `x86_64-unknown-linux-gnu` | `bakerst-install-linux-amd64` |
| `aarch64-unknown-linux-gnu` | `bakerst-install-linux-arm64` |
| `x86_64-apple-darwin` | `bakerst-install-darwin-amd64` |
| `aarch64-apple-darwin` | `bakerst-install-darwin-arm64` |

Windows users run via WSL2.

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/The-Baker-Street-Project/baker-street/main/scripts/install.sh | bash
```

Install script detects OS + arch, downloads the right binary, runs it.

### Version Pinning

Binary embeds its version. Checks `minInstallerVersion` from manifest — if too old, prints upgrade URL and exits.

### Checksums

SHA256 checksums file attached to each release for verification.

## Scripts Fate

| Script | Action |
|--------|--------|
| `scripts/deploy-all.sh` | Deprecate (keep with note) |
| `scripts/secrets.sh` | Deprecate |
| `scripts/deploy.sh` | Deprecate |
| `scripts/bootstrap.sh` | Deprecate |
| `scripts/build.sh` | **Keep** (local dev Docker builds) |
| `scripts/generate-manifest.mjs` | **Keep** (CI pipeline) |
