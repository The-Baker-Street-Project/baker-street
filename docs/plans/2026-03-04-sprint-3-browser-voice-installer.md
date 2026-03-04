# Sprint 3: Browser, Voice & Installer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix broken extension pods (browser, voice), add wake word support to voice, make the build pipeline and installer change-aware, and improve installer secret UX.

**Architecture:** Eight tickets across three workstreams — Extensions (BAK-33/15, BAK-35/11), Build/Deploy (BAK-39, BAK-37), and Installer UX (BAK-38, BAK-22). Extensions are bug-fix-first (unblock broken pods), then feature work. Build/deploy are independent. Installer UX tickets are closely coupled.

**Tech Stack:** Rust (installer), TypeScript/Node 22 (services), Docker, Kubernetes, GitHub Actions, Ratatui TUI

**Linear Cycle:** Sprint 3: Browser, Voice & Installer (Mar 4–18)

<!-- Validated: 2026-03-04 | Design ✅ | Dev ✅ | Security ✅ | Backlog ✅ -->

---

## Dependency Graph

```
BAK-33 (browser pod fix) → BAK-15 (browser first-class)
BAK-35 (voice pod fix)   → BAK-11 (wake word)
BAK-39 (build caching)   — independent
BAK-37 (update mechanism) — independent (benefits from BAK-39)
BAK-38 (env var prompt)  ↔ BAK-22 (auto-enable features)
```

**Recommended execution order:** BAK-33 → BAK-35 → BAK-38+22 → BAK-15 → BAK-39 → BAK-37 → BAK-11

---

## Task 1: BAK-33 — Fix ext-browser pod ErrImageNeverPull

**Problem:** `bakerst-ext-browser:latest` is never built by `scripts/build.sh`, so the pod can't start.

**Files:**
- Modify: `scripts/build.sh` (add browser build step)
- Modify: `examples/extension-browser/Dockerfile` (upgrade Node 20 → 22 to match project standard)
- Modify: `tools/installer/src/templates/browser.yaml` (add missing `readOnlyRootFilesystem` and `seccompProfile`)

**Step 1: Update browser Dockerfile to Node 22**

In `examples/extension-browser/Dockerfile`, change the base image from `node:20-bookworm` to `node:22-bookworm`. Verify `agent-browser@0.10.0` and playwright are compatible with Node 22.

**Step 2: Harden browser.yaml security context**

In `tools/installer/src/templates/browser.yaml`, add to the container's `securityContext`:

```yaml
          securityContext:
            runAsNonRoot: true
            runAsUser: 999
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            seccompProfile:
              type: RuntimeDefault
```

**Step 3: Add browser image build to build.sh**

In `scripts/build.sh`, add before the installer build step:

```bash
echo "==> Building bakerst-ext-browser..."
docker build --network host -t bakerst-ext-browser:latest -f "$REPO_ROOT/examples/extension-browser/Dockerfile" "$REPO_ROOT"
```

**Step 4: Build the browser image locally**

Run: `cd /home/gary/repos/baker-street-project/baker-street && docker build --network host -t bakerst-ext-browser:latest -f examples/extension-browser/Dockerfile .`

Expected: Image builds successfully (may take a few minutes — Playwright + Chromium install)

**Step 5: Verify the image exists**

Run: `docker images | grep bakerst-ext-browser`

Expected: `bakerst-ext-browser   latest   <hash>   <date>   <size>`

**Step 6: Commit**

```bash
git add scripts/build.sh examples/extension-browser/Dockerfile tools/installer/src/templates/browser.yaml
git commit -m "fix(build): add ext-browser to docker build pipeline (BAK-33)"
```

---

## Task 2: BAK-35 — Fix voice pod CreateContainerConfigError

**Problem:** The voice manifest references `bakerst-voice-secrets` (for AUTH_TOKEN, STT_API_KEY, TTS_API_KEY) but the installer never creates this secret. The pod fails at container creation because the required secretKeyRef can't be found.

**Files:**
- Modify: `tools/installer/src/cmd_install.rs` (add voice secret creation in both TUI `create_all_secrets` and non-interactive paths)
- Modify: `tools/installer/src/templates/voice.yaml` (add `readOnlyRootFilesystem: true` to match CLAUDE.md standard)
- Modify: `tools/installer/release-manifest.json` (add `voice` feature to `optionalFeatures`)

**Step 1: Add voice feature to release-manifest.json**

In `tools/installer/release-manifest.json`, add to `optionalFeatures` array:

```json
    {
      "id": "voice",
      "name": "Voice Talk Mode",
      "description": "Enable voice interaction with wake word detection",
      "defaultEnabled": false,
      "secrets": ["STT_API_KEY", "TTS_API_KEY", "PICOVOICE_ACCESS_KEY"]
    }
```

**Step 2: Add voice secret creation to the TUI install path**

In `tools/installer/src/cmd_install.rs`, find the function `create_all_secrets` (around line 1086). After the gateway secrets block (after `k8s::create_secret(client, namespace, "bakerst-gateway-secrets", &gateway_data).await?;` at ~line 1160), add:

```rust
    // Voice secrets
    let mut voice_data = BTreeMap::new();
    voice_data.insert("AUTH_TOKEN".into(), config.auth_token.clone());
    // STT_API_KEY, TTS_API_KEY, PICOVOICE_ACCESS_KEY are optional — populated from features
    for f in &config.features {
        for (k, v) in &f.secrets {
            if let Some(val) = v {
                match k.as_str() {
                    "STT_API_KEY" | "TTS_API_KEY" | "PICOVOICE_ACCESS_KEY" => {
                        voice_data.insert(k.clone(), val.clone());
                    }
                    _ => {}
                }
            }
        }
    }
    k8s::create_secret(client, namespace, "bakerst-voice-secrets", &voice_data).await?;
```

Note: `config.features` is `Vec<FeatureSelection>` (not `Option`), so iterate directly.

**Step 3: Add voice secret creation to the non-interactive path**

Find the non-interactive secret creation (around line 1450). After the gateway secrets block, add:

```rust
    // Voice secrets
    let mut voice_secrets = BTreeMap::new();
    voice_secrets.insert("AUTH_TOKEN".into(), auth_token.clone());
    // Check env for optional voice keys
    for key in ["STT_API_KEY", "TTS_API_KEY", "PICOVOICE_ACCESS_KEY"] {
        if let Ok(val) = std::env::var(key) {
            if !val.is_empty() {
                voice_secrets.insert(key.into(), val);
            }
        }
    }
    k8s::create_secret(&client, ns, "bakerst-voice-secrets", &voice_secrets).await?;
```

**Step 4: Harden voice.yaml security context**

In `tools/installer/src/templates/voice.yaml`, add `readOnlyRootFilesystem: true` to the securityContext (currently missing, deviates from CLAUDE.md standard):

```yaml
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            seccompProfile:
              type: RuntimeDefault
```

**Step 5: Build and test**

Run: `cd tools/installer && cargo build --release 2>&1 | tail -5`

Expected: Compiles with no errors (warnings are OK)

**Step 6: Commit**

```bash
git add tools/installer/src/cmd_install.rs tools/installer/src/templates/voice.yaml tools/installer/release-manifest.json
git commit -m "fix(installer): create bakerst-voice-secrets during install (BAK-35)"
```

---

## Task 3: BAK-38 — Installer prompts for env var vs manual secret entry

**Problem:** Users don't know if their environment variables are being picked up. The installer should explicitly ask.

**Files:**
- Modify: `tools/installer/src/app.rs` (add EnvVarChoice phase/state)
- Modify: `tools/installer/src/cmd_install.rs` (add env var detection + choice logic)
- Modify: `tools/installer/src/tui.rs` (render the choice screen)

**Step 1: Add EnvVarChoice to the Phase enum and all impl methods**

In `tools/installer/src/app.rs`:

1. Add `EnvVarChoice` variant between `Preflight` and `Secrets`:
```rust
pub enum Phase {
    Preflight,
    EnvVarChoice,
    Secrets,
    Providers,
    Features,
    Confirm,
    Pull,
    Deploy,
    Health,
    Complete,
}
```

2. Update `Phase::index()` — shift all indices after Preflight by 1:
```rust
    pub fn index(&self) -> usize {
        match self {
            Phase::Preflight => 0,
            Phase::EnvVarChoice => 1,
            Phase::Secrets => 2,
            Phase::Providers => 3,
            Phase::Features => 4,
            Phase::Confirm => 5,
            Phase::Pull => 6,
            Phase::Deploy => 7,
            Phase::Health => 8,
            Phase::Complete => 9,
        }
    }
```

3. Update `Phase::total()` to `10`.

4. Add `Phase::label()` arm:
```rust
Phase::EnvVarChoice => "Secret Source",
```

5. Update `Phase::next()`:
```rust
Phase::Preflight => Some(Phase::EnvVarChoice),
Phase::EnvVarChoice => Some(Phase::Secrets),
```

6. Add fields to `App` struct:
```rust
    // Env var choice phase
    pub use_env_vars: Option<bool>,
    pub detected_env_vars: Vec<(String, String)>,  // (key, masked_value)
```

7. Initialize in `App::new()`:
```rust
    use_env_vars: None,
    detected_env_vars: Vec::new(),
```

8. Update tests:
   - `phase_advances_through_all_stages`: assert `count == 9` (was 8)
   - `phase_index_is_sequential`: assert `Phase::Complete.index() == 9` (was 8)
   - `app_advance_works`: now advances to `Phase::EnvVarChoice` (was `Phase::Secrets`)

**Step 2: Detect env vars after preflight**

In `cmd_install.rs`, in the auto-advance logic for transitioning from Preflight, scan the environment. Only scan keys that are actually consumed by the installer's secret creation:

```rust
// After preflight passes, detect env vars
let known_keys = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_ENDPOINTS",
    "VOYAGE_API_KEY", "TELEGRAM_BOT_TOKEN",
    "GITHUB_TOKEN", "OBSIDIAN_VAULT_PATH",
    "STT_API_KEY", "TTS_API_KEY", "PICOVOICE_ACCESS_KEY",
];
app.detected_env_vars.clear();
for key in &known_keys {
    if let Ok(val) = std::env::var(key) {
        if !val.is_empty() {
            let masked = if val.len() > 12 {
                format!("{}...{}", &val[..3], &val[val.len()-3..])
            } else {
                "****".to_string()
            };
            app.detected_env_vars.push((key.to_string(), masked));
        }
    }
}

if app.detected_env_vars.is_empty() {
    // No env vars found — skip choice, go straight to manual entry
    app.phase = Phase::Secrets;
} else {
    app.phase = Phase::EnvVarChoice;
}
```

Note: masking threshold raised to 12 chars (shows 3+3, hides 6+), and only keys with actual K8s secret destinations are scanned. `DISCORD_BOT_TOKEN` is excluded until its secret destination is implemented.

**Step 3: Handle EnvVarChoice key input**

Add a `handle_env_var_choice_key` function in `cmd_install.rs`:

```rust
fn handle_env_var_choice_key(app: &mut App, key: event::KeyEvent) {
    match key.code {
        KeyCode::Char('1') | KeyCode::Char('e') => {
            app.use_env_vars = Some(true);
            // Pre-populate secret prompts from env
            for prompt in &mut app.secret_prompts {
                if let Ok(val) = std::env::var(&prompt.key) {
                    if !val.is_empty() {
                        prompt.value = Some(val);
                    }
                }
            }
            // Pre-populate feature secrets from env
            for feature in &mut app.config.features {
                for (k, v) in &mut feature.secrets {
                    if let Ok(val) = std::env::var(k) {
                        if !val.is_empty() {
                            *v = Some(val);
                        }
                    }
                }
            }
            // Pre-populate provider credentials from env
            if let Ok(val) = std::env::var("ANTHROPIC_API_KEY") {
                if !val.is_empty() { app.config.anthropic_api_key = Some(val); }
            }
            if let Ok(val) = std::env::var("OPENAI_API_KEY") {
                if !val.is_empty() { app.config.openai_api_key = Some(val); }
            }
            if let Ok(val) = std::env::var("OLLAMA_ENDPOINTS") {
                if !val.is_empty() { app.config.ollama_endpoints = Some(val); }
            }
            app.phase = Phase::Secrets;
        }
        KeyCode::Char('2') | KeyCode::Char('m') => {
            app.use_env_vars = Some(false);
            app.phase = Phase::Secrets;
        }
        _ => {}
    }
}
```

Wire it into the main `handle_key` match:
```rust
Phase::EnvVarChoice => handle_env_var_choice_key(app, key),
```

Note: provider keys (ANTHROPIC_API_KEY etc.) are excluded from `secret_prompts` by the `PROVIDER_KEYS` filter in `build_secret_prompts`, so they must be pre-populated directly into `app.config` fields. The Providers phase will still show but with pre-filled values the user can confirm or change.

**Step 4: Render the choice screen in TUI**

In `tui.rs`, add a `render_env_var_choice` function and wire it into the `render_phase` match:

```rust
Phase::EnvVarChoice => render_env_var_choice(frame, area, app),
```

Also add `EnvVarChoice` to `render_status_bar` key hints:
```rust
Phase::EnvVarChoice => "[1/E] Env vars  [2/M] Manual",
```

Implementation:
```rust
fn render_env_var_choice(frame: &mut Frame, area: Rect, app: &App) {
    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(
            "Environment variables detected:",
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];
    for (key, masked) in &app.detected_env_vars {
        lines.push(Line::from(vec![
            Span::styled(format!("  {}: ", key), Style::default().fg(Color::Cyan)),
            Span::styled(masked.as_str(), Style::default().fg(Color::DarkGray)),
        ]));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "[1/E] Use environment variables",
        Style::default().fg(Color::Green),
    )));
    lines.push(Line::from(Span::styled(
        "[2/M] Enter manually",
        Style::default().fg(Color::White),
    )));

    let paragraph = Paragraph::new(lines).block(Block::default().borders(Borders::ALL));
    frame.render_widget(paragraph, area);
}
```

**Step 5: Build and test**

Run: `cd tools/installer && cargo build --release 2>&1 | tail -5`

Expected: Compiles successfully

Run: `cd tools/installer && cargo test`

Expected: All tests pass (including updated phase tests)

**Step 6: Manual test**

Run: `ANTHROPIC_API_KEY=test-key-12345678 ./target/release/bakerst-install install`

Expected: After preflight, shows "Environment variables detected:" with ANTHROPIC_API_KEY masked as `****`, and choice prompt

**Step 7: Commit**

```bash
git add tools/installer/src/app.rs tools/installer/src/cmd_install.rs tools/installer/src/tui.rs
git commit -m "feat(installer): prompt for env var vs manual secret entry (BAK-38)"
```

---

## Task 4: BAK-22 — Auto-enable features when secrets are provided

**Problem:** Providing a secret (e.g., TELEGRAM_BOT_TOKEN) should auto-enable the corresponding feature flag.

**Files:**
- Modify: `tools/installer/src/cmd_install.rs` (auto-toggle features based on collected secrets)

**Step 1: Add auto-enable logic when transitioning to Features phase**

In `cmd_install.rs`, in the auto-advance or phase transition logic when moving from Providers to Features, add:

```rust
// Auto-enable features whose required secrets are all provided
for feature in &mut app.config.features {
    if !feature.secrets.is_empty() {
        let all_present = feature.secrets.iter().all(|(_, v)| v.is_some());
        if all_present {
            feature.enabled = true;
        }
    }
}
```

Important: This sets the **default state** for the Features phase checkboxes. The user can still de-select auto-enabled features on the Features screen before confirming. The auto-enable runs before Features is displayed, not after.

**Step 2: Also apply in non-interactive path**

In the non-interactive `run_non_interactive` function, after collecting secrets from env/prompts and before deployment, apply the same logic.

**Step 3: Build and test**

Run: `cd tools/installer && cargo build --release 2>&1 | tail -5`

Run: `cd tools/installer && cargo test`

**Step 4: Commit**

```bash
git add tools/installer/src/cmd_install.rs
git commit -m "feat(installer): auto-enable features when secrets provided (BAK-22)"
```

---

## Task 5: BAK-15 — Promote Browser-Agent MCP to first-class extension

**Problem:** Browser extension exists in `examples/extension-browser/` with working code, Dockerfile, and K8s manifest, but isn't fully integrated into the release pipeline.

**Files:**
- Verify: `.github/workflows/release.yml` (already has ext-browser in matrix at lines 60-63)
- Verify: `tools/installer/release-manifest.json` (has browser entry at line 12)
- Verify: `pnpm-workspace.yaml` (includes `examples/*`)
- Modify: `tools/installer/src/cmd_install.rs` (add ext-browser + ext-toolbox to TUI progress display in `run_deploy_sequence`)

**Step 1: Verify release pipeline includes ext-browser**

Check `.github/workflows/release.yml` — ext-browser is already in the build matrix (lines 60-63). No change needed.

**Step 2: Verify release-manifest.json**

Check `tools/installer/release-manifest.json` — browser entry exists at line 12. No change needed.

**Step 3: Verify pnpm workspace includes browser**

Check `pnpm-workspace.yaml` — should include `examples/*` glob. Verify the browser TypeScript compiles: `pnpm -r --filter extension-browser build`

**Step 4: Fix TUI progress display for extensions**

In `cmd_install.rs`, the `run_deploy_sequence` function (lines ~908-918) builds the `steps` list for the TUI progress display. Currently only `"voice"` and `"sysadmin"` are added to `steps` — `"ext-toolbox"` and `"ext-browser"` are deployed but show no progress in the TUI. Add them:

```rust
"ext-toolbox" => {
    steps.push(("Extension: Toolbox".into(), ItemStatus::Pending));
}
"ext-browser" => {
    steps.push(("Extension: Browser".into(), ItemStatus::Pending));
}
```

**Step 5: Build and test**

Run: `scripts/build.sh` (builds all images including browser)

Verify: `docker images | grep bakerst-ext-browser` shows the image

**Step 6: Commit**

```bash
git add tools/installer/src/cmd_install.rs
git commit -m "feat(extensions): promote ext-browser to first-class extension (BAK-15)"
```

---

## Task 6: BAK-39 — Build pipeline: skip unchanged images

**Problem:** `scripts/build.sh` rebuilds all Docker images every time, even if source hasn't changed.

**Files:**
- Modify: `scripts/build.sh` (add change detection)
- Modify: `.gitignore` (add `.build-hashes/`)

**Step 1: Add change detection to build.sh**

Add a `compute_hash` function and a `should_build` function. The hash is written **after** a successful build, not inside `should_build`:

```bash
# At the top of build.sh, after VERSION is set:
HASH_DIR="$REPO_ROOT/.build-hashes"
mkdir -p "$HASH_DIR"

# Parse --force flag
FORCE_BUILD="${FORCE_BUILD:-false}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|--no-cache)
      FORCE_BUILD=true
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

compute_hash() {
  local context_path="$1"
  local dockerfile="$2"
  find "$context_path" "$dockerfile" -type f \
    -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.build-hashes/*' \
    | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1
}

should_build() {
  local name="$1"
  local context_path="$2"
  local dockerfile="$3"

  if [[ "$FORCE_BUILD" == "true" ]]; then return 0; fi

  CURRENT_HASH=$(compute_hash "$context_path" "$dockerfile")

  local stored_hash=""
  if [[ -f "$HASH_DIR/$name.hash" ]]; then
    stored_hash=$(cat "$HASH_DIR/$name.hash")
  fi

  if [[ "$CURRENT_HASH" == "$stored_hash" ]]; then
    echo "==> Skipping $name (no changes)"
    return 1
  fi

  return 0
}

# Usage pattern: write hash AFTER successful build
save_hash() {
  local name="$1"
  echo "$CURRENT_HASH" > "$HASH_DIR/$name.hash"
}
```

Then wrap each build step:

```bash
if should_build "brain" "$REPO_ROOT/services/brain" "$REPO_ROOT/services/brain/Dockerfile"; then
  echo "==> Building bakerst-brain..."
  docker build --network host -t bakerst-brain:latest --build-arg BRAIN_VERSION="$VERSION" \
    -f "$REPO_ROOT/services/brain/Dockerfile" "$REPO_ROOT" && save_hash "brain"
fi
```

Repeat for all images (worker, ui, gateway, sysadmin, voice, ext-toolbox, ext-browser).

**Step 2: Add .build-hashes to .gitignore (idempotent)**

Edit `.gitignore` directly (do not use `echo >>` to avoid duplicates):
```
.build-hashes/
```

**Step 3: Test**

Run: `scripts/build.sh` (first run — builds all, stores hashes)
Run: `scripts/build.sh` (second run — skips all, prints "Skipping")
Run: `touch services/brain/src/index.ts && scripts/build.sh` (only rebuilds brain)
Run: `scripts/build.sh --force` (rebuilds all despite hashes)

**Step 4: Commit**

```bash
git add scripts/build.sh .gitignore
git commit -m "feat(build): skip unchanged images with content hashing (BAK-39)"
```

---

## Task 7: BAK-37 — Update mechanism: only deploy changed pods

**Problem:** `bakerst-install update` currently redeploys everything. It should compare running vs target images and only redeploy changed components.

**Files:**
- Modify: `tools/installer/src/cmd_update.rs` (add image comparison logic)
- Modify: `tools/installer/src/k8s.rs` (add function to read current deployment image)

**Step 1: Add current image reading to k8s.rs**

```rust
/// Get the current image tag for a deployment
pub async fn get_deployment_image(
    client: &Client,
    namespace: &str,
    deployment: &str,
) -> Result<Option<String>> {
    let deployments: Api<k8s_openapi::api::apps::v1::Deployment> =
        Api::namespaced(client.clone(), namespace);
    match deployments.get_opt(deployment).await? {
        Some(dep) => {
            let image = dep.spec
                .and_then(|s| s.template.spec)
                .and_then(|s| s.containers.first().cloned())
                .and_then(|c| c.image);
            Ok(image)
        }
        None => Ok(None),
    }
}
```

Note: uses `get_opt` (not `get`) to return `None` instead of erroring when deployment doesn't exist.

**Step 2: Modify cmd_update.rs to compare images before restarting**

In the update flow, after loading the manifest and current metadata, compare the image in each running deployment against the manifest's target image:

```rust
let mut components_to_update: Vec<&ManifestImage> = Vec::new();

for image in &manifest.images {
    // Brain uses blue/green deployments — map to active slot
    let deployment_name = if image.component == "brain" {
        let slot = current_meta.as_ref()
            .map(|m| m.active_slot.as_str())
            .unwrap_or("blue");
        format!("brain-{}", slot)
    } else {
        image.component.clone()
    };

    let current = k8s::get_deployment_image(&client, namespace, &deployment_name).await?;
    let target = &image.image; // e.g. "bakerst-brain:latest"

    if args.force || current.as_deref() != Some(target.as_str()) {
        components_to_update.push(image);
        println!("  ↑ {} ({} → {})",
            image.component,
            current.as_deref().unwrap_or("none"),
            target);
    } else {
        println!("  ✓ {} (up to date)", image.component);
    }
}

if components_to_update.is_empty() && !args.force {
    println!("\nAll components are up to date. Use --force to redeploy anyway.");
    return Ok(());
}
```

Note: Brain component maps to `brain-blue` or `brain-green` based on active slot from metadata. Other components use their component name directly as the deployment name.

Then only restart deployments for `components_to_update` in the rolling restart loop.

**Step 3: Build and test**

Run: `cd tools/installer && cargo build --release 2>&1 | tail -5`

Run: `cd tools/installer && cargo test`

**Step 4: Commit**

```bash
git add tools/installer/src/cmd_update.rs tools/installer/src/k8s.rs
git commit -m "feat(installer): selective update — only redeploy changed components (BAK-37)"
```

---

## Task 8: BAK-11 — Voice Talk Mode with Wake Word

**Problem:** Add wake word detection to the voice service so users can say a trigger word to activate voice input.

This is the largest ticket. The voice service already has STT/TTS working — this adds browser-side wake word detection, the "Sitting Room" UI overlay, and makes voice URLs configurable.

**Transport decision:** REST-only for v1. Use existing `/voice/chat` POST endpoint with `MediaRecorder` API. WebSocket streaming deferred to follow-up ticket.

**Wake word:** Porcupine (Picovoice) with user's non-commercial key. Follow-up: BAK-40 researches open-source alternatives.

**STT/TTS:** Local only — Whisper on Sherlock (localhost:8083) for STT, Coqui/Kokoro for TTS. $0 cost.

**Files:**
- Create: `services/ui/src/components/SittingRoom.tsx` (floating voice overlay)
- Create: `services/ui/src/hooks/useWakeWord.ts` (wake word detection hook)
- Create: `services/ui/src/hooks/useVoiceChat.ts` (voice chat pipeline hook)
- Modify: `services/ui/src/App.tsx` (add SittingRoom overlay)
- Modify: `tools/installer/src/templates/voice.yaml` (make STT/TTS URLs configurable, remove hardcoded IPs)
- Modify: `tools/installer/src/cmd_install.rs` (add voice URL prompts + PICOVOICE_ACCESS_KEY to voice secrets)

**Step 1: Make voice.yaml URLs configurable (fix hardcoded private IP)**

Replace hardcoded URLs in `tools/installer/src/templates/voice.yaml`:

```yaml
            - name: WHISPER_URL
              value: "{{WHISPER_URL}}"
            - name: TTS_PROVIDER
              value: "{{TTS_PROVIDER}}"
            - name: TTS_BASE_URL
              value: "{{TTS_BASE_URL}}"
            - name: TTS_MODEL
              value: "{{TTS_MODEL}}"
            - name: TTS_VOICE
              value: "{{TTS_VOICE}}"
```

Add template variable defaults in the installer's `build_template_vars` function. Default WHISPER_URL to empty string (disabled) and TTS_BASE_URL to empty string (disabled) — no private IPs shipped in the binary.

**Step 2: Add Porcupine to UI dependencies**

```bash
cd services/ui && pnpm add @picovoice/porcupine-web @picovoice/web-voice-processor
```

Note: Do NOT install `@picovoice/porcupine-react` — write the hook manually using `@picovoice/porcupine-web` directly. The React wrapper is a separate package with uncertain availability.

**Step 3: Create useWakeWord hook**

```typescript
// services/ui/src/hooks/useWakeWord.ts
import { PorcupineWorker } from '@picovoice/porcupine-web';
import { WebVoiceProcessor } from '@picovoice/web-voice-processor';
import { useState, useCallback, useRef, useEffect } from 'react';

export function useWakeWord(
  accessKey: string | undefined,
  keyword: string,
  onDetected: () => void,
) {
  // If no accessKey, return disabled state (push-to-talk fallback)
  // Initialize PorcupineWorker with built-in keyword
  // Subscribe to WebVoiceProcessor for audio frames
  // Call onDetected() when wake word confidence exceeds threshold
  // Return: { isListening, isSupported, start, stop, error }
}
```

Must handle the no-key case gracefully: `isSupported` returns false, UI falls back to push-to-talk button.

**Step 4: Create useVoiceChat hook**

```typescript
// services/ui/src/hooks/useVoiceChat.ts
// REST-only: POST audio blob to /voice/chat, receive audio blob back
export function useVoiceChat(voiceUrl: string, authToken: string) {
  // Records audio via MediaRecorder API (webm/opus)
  // POST to voiceUrl/voice/chat as multipart/form-data
  // Plays back TTS response audio
  // Return: { isRecording, isPlaying, transcript, response, start, stop, error }
}
```

**Step 5: Create SittingRoom component**

```typescript
// services/ui/src/components/SittingRoom.tsx
// Floating overlay button (bottom-right corner)
// States: idle (mic icon) → listening (waveform) → processing (spinner) → playing (speaker icon)
// Expands to show: transcript, response text, stop button
// Integrates useWakeWord + useVoiceChat
// Falls back to push-to-talk button if no PICOVOICE_ACCESS_KEY
```

**Step 6: Wire into App.tsx**

Add `<SittingRoom />` as a portal/overlay at the app root level. Only render if voice feature is enabled (check via brain `/ping` features endpoint).

**Step 7: Add PICOVOICE_ACCESS_KEY to installer voice secrets**

Already added to `release-manifest.json` in Task 2 (Step 1). The `create_all_secrets` voice block already handles it. Verify the key flows through correctly.

**Step 8: Add voice URL prompts to installer**

When voice feature is enabled during install, prompt for:
- `WHISPER_URL` (default: `http://host.docker.internal:8083`)
- `TTS_PROVIDER` (default: `openai`)
- `TTS_BASE_URL` (default: empty)
- `TTS_MODEL` (default: empty)
- `TTS_VOICE` (default: `bf_emma`)

Pass these as template variables when rendering `voice.yaml`.

**Step 9: Build and test**

Run: `cd services/ui && pnpm build`
Run: `cd tools/installer && cargo build --release`

**Step 10: Commit**

```bash
git add services/ui/src/components/SittingRoom.tsx \
  services/ui/src/hooks/useWakeWord.ts \
  services/ui/src/hooks/useVoiceChat.ts \
  services/ui/src/App.tsx \
  tools/installer/src/templates/voice.yaml \
  tools/installer/src/cmd_install.rs
git commit -m "feat(voice): add wake word detection and Sitting Room UI (BAK-11)"
```

---

## Execution Order Summary

| Order | Ticket | Scope | Est. |
|-------|--------|-------|------|
| 1 | BAK-33 | 3 files: build step + Dockerfile Node upgrade + browser.yaml security | small |
| 2 | BAK-35 | 3 files: voice secret creation + voice.yaml security + manifest voice feature | small |
| 3 | BAK-38 | 3 files: Phase enum + env var detection + TUI rendering (8 match arms to update) | medium |
| 4 | BAK-22 | 1 file: auto-toggle logic (sets defaults for Features phase) | small |
| 5 | BAK-15 | 1 file: verify pipeline + fix TUI progress display for extensions | small |
| 6 | BAK-39 | 2 files: content hashing (hash written after build, not before) | medium |
| 7 | BAK-37 | 2 files: selective update with blue/green brain awareness | medium |
| 8 | BAK-11 | 6+ files: wake word + Sitting Room UI (REST-only, Porcupine) | large |

Tasks 1-2 are quick bug fixes that unblock everything else. Tasks 3-4 are tightly coupled installer UX. Task 5 verifies the browser extension pipeline. Tasks 6-7 are build/deploy optimization. Task 8 is the big feature.
