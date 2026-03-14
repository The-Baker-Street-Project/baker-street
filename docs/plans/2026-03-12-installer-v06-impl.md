# Installer v0.6 — Interview Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the installer's interactive interview to follow the v3 interview script — provider selection, model role assignment (Agent/Worker/Observer/Reflector), validation at collect time, Ollama model discovery, and localhost rewriting.

**Architecture:** Add a `validation` module for HTTP-based API key/endpoint checks. Restructure `run_interactive()` into section-based flow (Basics → Provider → Models → Security → Memory → Features → Confirm). Keep `from_config_file()` and `from_env()` working for non-interactive mode. Update config-schema.json and deploy-all.sh to propagate OBSERVER_MODEL and REFLECTOR_MODEL through K8s secrets.

**Tech Stack:** Rust, reqwest (HTTP validation), serde_json (Ollama API), tokio (async), clap (CLI)

**Design doc:** `docs/plans/2026-03-12-installer-interview-script.md`

<!-- Validated: 2026-03-12 | Design ✅ | Dev ✅ | Security ✅ | Backlog ✅ -->

---

### Task 1: Add OBSERVER_MODEL and REFLECTOR_MODEL to config schema

The TypeScript runtime already supports these env vars (`packages/shared/src/model-config.ts:222-286`). The installer schema and deploy script don't propagate them yet.

**Files:**
- Modify: `tools/install-template/config-schema.json`
- Modify: `scripts/deploy-all.sh`
- Test: `tools/installer/tests/config_schema_test.rs`

**Step 1: Add OBSERVER_MODEL to config-schema.json**

In the `secrets` array, after the WORKER_MODEL entry (line ~80), add:

```json
{
  "key": "OBSERVER_MODEL",
  "description": "Observer model — watches conversations for tone drift, errors, safety issues. Runs on every message, so speed matters.",
  "inputType": "text",
  "required": false,
  "group": "providers",
  "targetSecrets": [
    "bakerst-brain-secrets"
  ],
  "prompt": "What model for the Observer?",
  "dependsOn": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_ENDPOINTS"],
  "silent": true
}
```

**Step 2: Add REFLECTOR_MODEL to config-schema.json**

Immediately after OBSERVER_MODEL:

```json
{
  "key": "REFLECTOR_MODEL",
  "description": "Reflector model — deep post-conversation analysis. Runs infrequently, so it can afford a stronger model.",
  "inputType": "text",
  "required": false,
  "group": "providers",
  "targetSecrets": [
    "bakerst-brain-secrets"
  ],
  "prompt": "What model for the Reflector?",
  "dependsOn": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_ENDPOINTS"],
  "silent": true
}
```

Both are `silent: true` — the interview will handle prompting in the structured model role section rather than the generic secret loop.

**Step 3: Add to deploy-all.sh secret creation**

In `scripts/deploy-all.sh`, add to the BRAIN_ARGS array only (around line 200):
```bash
--from-literal="OBSERVER_MODEL=$OBSERVER_MODEL"
--from-literal="REFLECTOR_MODEL=$REFLECTOR_MODEL"
```

Do NOT add to WORKER_ARGS — the worker only uses 'worker' and 'agent' roles.
Observer and reflector are brain-only concerns (least-privilege scoping).

**Step 4: Verify schema version handling**

The schema version stays at `1` — these are additive, backward-compatible changes (new optional fields).
Tests in `config_schema_test.rs` and `integration.rs` assert `schema_version == 1`; they should still pass since the version hasn't changed.

Run: `cd tools/installer && cargo test config_schema`
Expected: All existing tests pass. The new fields are optional and `silent`, so existing tests should not break.

**Step 5: Commit**

```bash
git add tools/install-template/config-schema.json scripts/deploy-all.sh
git commit -m "feat(installer): add OBSERVER_MODEL and REFLECTOR_MODEL to config schema and deploy script"
```

---

### Task 2: Create validation module

New module for HTTP-based validation of API keys, endpoints, and tokens. Used by the interview to validate at collect time.

**Files:**
- Create: `tools/installer/src/validation.rs`
- Modify: `tools/installer/src/lib.rs` (add `pub mod validation;`)
- Test: `tools/installer/tests/validation_test.rs`

**Step 1: Write tests for the validation module**

Create `tools/installer/tests/validation_test.rs`:

```rust
//! Tests for the validation module.
//! Note: tests that hit real APIs are #[ignore] — run with `cargo test -- --ignored`

use bakerst_install::validation;

#[test]
fn rewrite_localhost_to_docker_internal() {
    assert_eq!(
        validation::rewrite_localhost("localhost:11434"),
        "host.docker.internal:11434"
    );
    assert_eq!(
        validation::rewrite_localhost("127.0.0.1:8085"),
        "host.docker.internal:8085"
    );
    assert_eq!(
        validation::rewrite_localhost("http://localhost:11434"),
        "http://host.docker.internal:11434"
    );
}

#[test]
fn rewrite_preserves_non_localhost() {
    assert_eq!(
        validation::rewrite_localhost("192.168.4.42:8085"),
        "192.168.4.42:8085"
    );
    assert_eq!(
        validation::rewrite_localhost("host.docker.internal:11434"),
        "host.docker.internal:11434"
    );
}

#[test]
fn rewrite_multiple_endpoints() {
    let result = validation::rewrite_endpoints("localhost:11434,192.168.4.42:8085");
    assert_eq!(result, "host.docker.internal:11434,192.168.4.42:8085");
}

#[test]
fn parse_ollama_models_response() {
    let json = r#"{
        "models": [
            {"name": "qwen2.5-coder:32b", "size": 19326139392},
            {"name": "llama3.1:8b", "size": 4661224448},
            {"name": "qwen3.5:9b", "size": 5764801536}
        ]
    }"#;
    let models = validation::parse_ollama_models(json).unwrap();
    assert_eq!(models.len(), 3);
    // Should be sorted by size descending
    assert_eq!(models[0].name, "qwen2.5-coder:32b");
    assert_eq!(models[2].name, "llama3.1:8b");
}

#[test]
fn recommend_models_for_roles() {
    let json = r#"{
        "models": [
            {"name": "qwen2.5-coder:32b", "size": 19326139392},
            {"name": "qwen3.5:9b", "size": 5764801536},
            {"name": "llama3.1:8b", "size": 4661224448},
            {"name": "granite3-dense:8b", "size": 4900000000}
        ]
    }"#;
    let models = validation::parse_ollama_models(json).unwrap();
    let recs = validation::recommend_ollama_models(&models);
    // Largest → agent/reflector, smallest viable → worker/observer
    assert_eq!(recs.agent, "qwen2.5-coder:32b");
    assert!(["qwen3.5:9b", "llama3.1:8b", "granite3-dense:8b"].contains(&recs.worker.as_str()));
}

#[test]
fn reject_invalid_endpoint_formats() {
    // SSRF prevention: only host:port allowed, no paths/schemes/queries
    assert!(validation::validate_endpoint_format("http://evil.com/api").is_err());
    assert!(validation::validate_endpoint_format("169.254.169.254/metadata").is_err());
    assert!(validation::validate_endpoint_format("localhost:11434/../../etc/passwd").is_err());
    assert!(validation::validate_endpoint_format("host:port:extra").is_err());
    // Valid formats
    assert!(validation::validate_endpoint_format("localhost:11434").is_ok());
    assert!(validation::validate_endpoint_format("host.docker.internal:8085").is_ok());
    assert!(validation::validate_endpoint_format("192.168.4.42:11434").is_ok());
}

#[tokio::test]
#[ignore] // Requires real Anthropic API key
async fn validate_anthropic_key_real() {
    let key = std::env::var("ANTHROPIC_API_KEY").unwrap();
    assert!(validation::validate_anthropic_key(&key).await.is_ok());
}

#[tokio::test]
async fn validate_anthropic_key_bad() {
    let result = validation::validate_anthropic_key("sk-bad-key-12345").await;
    assert!(result.is_err());
}

#[tokio::test]
#[ignore] // Requires Ollama running
async fn validate_ollama_endpoint_real() {
    let result = validation::validate_ollama_endpoint("localhost:11434").await;
    assert!(result.is_ok());
}
```

**Step 2: Run tests to verify they fail**

Run: `cd tools/installer && cargo test validation`
Expected: Compilation error — module doesn't exist yet.

**Step 3: Create validation.rs with localhost rewriting**

Create `tools/installer/src/validation.rs`:

```rust
//! Validation module — HTTP-based verification of API keys, endpoints, and tokens.
//! Used by the interview to validate inputs at collect time.

use anyhow::{bail, Result};
use serde::Deserialize;

// ── Localhost rewriting ──────────────────────────────────────────────

/// Rewrite localhost/127.0.0.1 to host.docker.internal in a single endpoint string.
/// K8s pods can't reach the host via localhost — Docker Desktop and OrbStack
/// use host.docker.internal instead.
pub fn rewrite_localhost(endpoint: &str) -> String {
    endpoint
        .replace("localhost", "host.docker.internal")
        .replace("127.0.0.1", "host.docker.internal")
}

/// Rewrite localhost in a comma-separated list of endpoints.
pub fn rewrite_endpoints(endpoints: &str) -> String {
    endpoints
        .split(',')
        .map(|ep| rewrite_localhost(ep.trim()))
        .collect::<Vec<_>>()
        .join(",")
}

/// Returns true if any endpoint contains localhost or 127.0.0.1.
pub fn has_localhost(endpoints: &str) -> bool {
    endpoints.contains("localhost") || endpoints.contains("127.0.0.1")
}

// ── API key validation ───────────────────────────────────────────────

/// Validate an Anthropic API key by hitting the models endpoint.
pub async fn validate_anthropic_key(key: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    if resp.status().is_success() {
        Ok(())
    } else if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        bail!("Invalid API key")
    } else {
        bail!("Anthropic API returned HTTP {}", resp.status())
    }
}

/// Validate an OpenAI API key by hitting the models endpoint.
pub async fn validate_openai_key(key: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.openai.com/v1/models")
        .header("Authorization", format!("Bearer {}", key))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    if resp.status().is_success() {
        Ok(())
    } else if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        bail!("Invalid API key")
    } else {
        bail!("OpenAI API returned HTTP {}", resp.status())
    }
}

// ── Ollama endpoint validation & model discovery ─────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

/// Model recommendations for the 4 roles.
#[derive(Debug, Clone)]
pub struct ModelRecommendations {
    pub agent: String,
    pub worker: String,
    pub observer: String,
    pub reflector: String,
}

/// Validate endpoint format: must be host:port only (no scheme, no path).
/// Matches the runtime pattern in model-config.ts: /^[\w.-]+:\d{1,5}$/
fn validate_endpoint_format(endpoint: &str) -> Result<()> {
    let re = regex::Regex::new(r"^[\w.\-]+:\d{1,5}$").unwrap();
    if !re.is_match(endpoint) {
        bail!(
            "Invalid endpoint format: '{}'. Expected host:port (e.g., localhost:11434)",
            endpoint
        );
    }
    Ok(())
}

/// Validate that an Ollama endpoint is reachable.
/// Endpoint format: "host:port" (no http:// prefix, no path — enforced).
pub async fn validate_ollama_endpoint(endpoint: &str) -> Result<()> {
    validate_endpoint_format(endpoint)?;

    let url = format!("http://{}/api/tags", endpoint);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    if resp.status().is_success() {
        Ok(())
    } else {
        bail!("Ollama endpoint returned HTTP {}", resp.status())
    }
}

/// Discover models from an Ollama endpoint. Returns models sorted by size (largest first).
pub async fn discover_ollama_models(endpoint: &str) -> Result<Vec<OllamaModel>> {
    validate_endpoint_format(endpoint)?;
    let url = format!("http://{}/api/tags", endpoint);

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    let body = resp.text().await?;
    let mut models = parse_ollama_models(&body)?;
    models.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(models)
}

/// Parse Ollama /api/tags JSON response.
pub fn parse_ollama_models(json: &str) -> Result<Vec<OllamaModel>> {
    let resp: OllamaTagsResponse = serde_json::from_str(json)?;
    let mut models = resp.models;
    models.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(models)
}

/// Recommend models for the 4 roles based on model size.
/// Largest → Agent/Reflector, smallest viable (>= ~4GB) → Worker/Observer.
pub fn recommend_ollama_models(models: &[OllamaModel]) -> ModelRecommendations {
    let agent = models.first().map(|m| m.name.clone()).unwrap_or_default();
    // For worker, prefer the second-largest or smallest viable model
    let worker = if models.len() >= 2 {
        models.last().map(|m| m.name.clone()).unwrap_or_default()
    } else {
        agent.clone()
    };

    ModelRecommendations {
        agent: agent.clone(),
        worker: worker.clone(),
        observer: worker,    // Observer defaults to Worker model (fast, runs every message)
        reflector: agent,    // Reflector defaults to Agent model (deep analysis, runs infrequently)
    }
}

// ── Feature-specific validation ──────────────────────────────────────

/// Validate a Telegram bot token by calling getMe.
pub async fn validate_telegram_token(token: &str) -> Result<String> {
    let url = format!("https://api.telegram.org/bot{}/getMe", token);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    if resp.status().is_success() {
        #[derive(Deserialize)]
        struct TgResponse {
            result: TgUser,
        }
        #[derive(Deserialize)]
        struct TgUser {
            username: Option<String>,
        }
        let body: TgResponse = resp.json().await?;
        Ok(body.result.username.unwrap_or_else(|| "unknown".into()))
    } else {
        bail!("Invalid bot token")
    }
}

/// Validate a GitHub personal access token by calling GET /user.
pub async fn validate_github_token(token: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "bakerst-install")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    if resp.status().is_success() {
        #[derive(Deserialize)]
        struct GhUser {
            login: String,
        }
        let user: GhUser = resp.json().await?;
        Ok(user.login)
    } else if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        bail!("Invalid GitHub token")
    } else {
        bail!("GitHub API returned HTTP {}", resp.status())
    }
}

/// Validate a Voyage AI API key.
pub async fn validate_voyage_key(key: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.voyageai.com/v1/embeddings")
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .body(r#"{"input": ["test"], "model": "voyage-3"}"#)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    if resp.status().is_success() {
        Ok(())
    } else if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        bail!("Invalid Voyage AI API key")
    } else {
        bail!("Voyage AI API returned HTTP {}", resp.status())
    }
}
```

**Step 4: Register the module**

In `tools/installer/src/lib.rs`, add:
```rust
pub mod validation;
```

**Step 5: Run tests**

Run: `cd tools/installer && cargo test validation`
Expected: All non-ignored tests pass (localhost rewriting, Ollama parsing, model recommendation).

**Step 6: Commit**

```bash
git add tools/installer/src/validation.rs tools/installer/src/lib.rs tools/installer/tests/validation_test.rs
git commit -m "feat(installer): add validation module for API keys, endpoints, and model discovery"
```

---

### Task 3: Rewrite run_interactive() — Section 1: Basics

Refactor the interview into clearly separated sections matching the v3 script.

**Files:**
- Modify: `tools/installer/src/interview.rs`

**Step 1: Extract the stdin reader into a shared helper**

The current `run_interactive()` creates a `BufReader<Stdin>`. Extract section functions that accept a `&mut BufReader<Stdin>` so they can share the reader.

At the top of interview.rs, add a type alias (after existing imports):

```rust
use std::io::{BufRead, BufReader, Write};

type StdinReader = BufReader<std::io::Stdin>;
```

**Step 2: Create section_basics()**

Add a new function that handles Section 1 (namespace + agent name):

```rust
/// Section 1: Basics — namespace and agent name.
fn section_basics(reader: &mut StdinReader, schema: &ConfigSchema) -> Result<(String, String)> {
    println!();
    println!("--- Basics ---");
    println!();

    let namespace = prompt_text(
        reader,
        &format!("What is the name of the Kubernetes namespace? [{}]", schema.defaults.namespace),
        Some(&schema.defaults.namespace),
        false,
    )?;

    let agent_name = prompt_text(
        reader,
        &format!("What name would you like to give your AI assistant? [{}]", schema.defaults.agent_name),
        Some(&schema.defaults.agent_name),
        false,
    )?;

    Ok((namespace, agent_name))
}
```

**Step 3: Verify compilation**

Run: `cd tools/installer && cargo check`
Expected: Compiles (function defined but not yet called).

**Step 4: Commit**

```bash
git add tools/installer/src/interview.rs
git commit -m "refactor(installer): extract section_basics() from run_interactive()"
```

---

### Task 4: Rewrite run_interactive() — Section 2: Provider Selection

The core change: instead of iterating secrets by group, present a numbered provider choice and branch into provider-specific flows.

**Files:**
- Modify: `tools/installer/src/interview.rs`
- Test: `tools/installer/tests/integration.rs` (update if needed)

**Step 1: Define Provider enum**

Add near the top of interview.rs:

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
enum Provider {
    Anthropic,
    OpenAI,
    Ollama,
}
```

**Step 2: Create section_provider()**

```rust
/// Section 2: AI Provider — choose provider, validate key, select models for all 4 roles.
async fn section_provider(
    reader: &mut StdinReader,
    schema: &ConfigSchema,
) -> Result<(Provider, HashMap<String, String>)> {
    use crate::validation;

    println!();
    println!("--- AI Provider ---");
    println!();
    println!("Which AI provider would you like to use?");
    println!();
    println!("  1) Anthropic (Claude — Sonnet, Opus, Haiku)");
    println!("  2) OpenAI (GPT-4o, o3-mini)");
    println!("  3) Ollama (local models — OpenAI-compatible API)");
    println!();

    let choice = prompt_text(reader, "Choice [1]", Some("1"), false)?;
    let provider = match choice.trim() {
        "1" | "" => Provider::Anthropic,
        "2" => Provider::OpenAI,
        "3" => Provider::Ollama,
        _ => {
            println!("  Invalid choice, defaulting to Anthropic.");
            Provider::Anthropic
        }
    };

    // Show model role explanation
    print_model_role_explanation();

    let mut secrets = HashMap::new();

    match provider {
        Provider::Anthropic => collect_anthropic(reader, &mut secrets).await?,
        Provider::OpenAI => collect_openai(reader, &mut secrets).await?,
        Provider::Ollama => collect_ollama(reader, &mut secrets).await?,
    }

    // Collect Observer/Reflector overrides
    collect_observer_reflector(reader, provider, &mut secrets)?;

    Ok((provider, secrets))
}
```

**Step 3: Create print_model_role_explanation()**

```rust
fn print_model_role_explanation() {
    println!();
    println!("Baker Street uses four model roles:");
    println!();
    println!("  Agent     — your main conversational AI. Handles chat, tool calling,");
    println!("              and complex reasoning. Needs the strongest model you have.");
    println!();
    println!("  Worker    — runs background tasks: summarization, extraction, research.");
    println!("              Optimized for throughput. A fast model shines here.");
    println!();
    println!("  Observer  — watches every conversation in real-time. Flags tone drift,");
    println!("              factual errors, and safety issues. Runs on every message,");
    println!("              so speed matters more than depth.");
    println!("              Default: same model as Worker.");
    println!();
    println!("  Reflector — deep post-conversation analysis. Reviews what went well,");
    println!("              what didn't, and extracts learnings. Runs infrequently,");
    println!("              so it can afford a stronger model.");
    println!("              Default: same model as Agent.");
    println!();
}
```

**Step 4: Create collect_anthropic()**

```rust
async fn collect_anthropic(
    reader: &mut StdinReader,
    secrets: &mut HashMap<String, String>,
) -> Result<()> {
    use crate::validation;

    // Collect and validate API key
    loop {
        let key = prompt_secret(reader, "Paste your Anthropic API key")?;
        print!("  Verifying... ");
        std::io::stdout().flush()?;
        match validation::validate_anthropic_key(&key).await {
            Ok(()) => {
                println!("✓ API key verified");
                secrets.insert("ANTHROPIC_API_KEY".into(), key);
                break;
            }
            Err(e) => {
                println!("✗ {}", e);
                println!("  Please check your key and try again.");
            }
        }
    }

    // Recommend and collect models
    println!();
    println!("Recommended models:");
    println!();
    println!("  Agent:     claude-sonnet-4-20250514 (best balance of speed and capability)");
    println!("  Worker:    claude-haiku-4-5-20251001 (fast and cheap for background tasks)");
    println!();

    let agent_model = prompt_text(
        reader,
        "What model for the Agent? [claude-sonnet-4-20250514]",
        Some("claude-sonnet-4-20250514"),
        false,
    )?;
    secrets.insert("DEFAULT_MODEL".into(), agent_model);

    let worker_model = prompt_text(
        reader,
        "What model for the Worker? [claude-haiku-4-5-20251001]",
        Some("claude-haiku-4-5-20251001"),
        false,
    )?;
    secrets.insert("WORKER_MODEL".into(), worker_model);

    Ok(())
}
```

**Step 5: Create collect_openai()**

```rust
async fn collect_openai(
    reader: &mut StdinReader,
    secrets: &mut HashMap<String, String>,
) -> Result<()> {
    use crate::validation;

    loop {
        let key = prompt_secret(reader, "Paste your OpenAI API key")?;
        print!("  Verifying... ");
        std::io::stdout().flush()?;
        match validation::validate_openai_key(&key).await {
            Ok(()) => {
                println!("✓ API key verified");
                secrets.insert("OPENAI_API_KEY".into(), key);
                break;
            }
            Err(e) => {
                println!("✗ {}", e);
                println!("  Please check your key and try again.");
            }
        }
    }

    println!();
    println!("Recommended models:");
    println!();
    println!("  Agent:     gpt-4o (strong tool calling and reasoning)");
    println!("  Worker:    gpt-4o-mini (fast and cost-effective)");
    println!();

    let agent_model = prompt_text(
        reader,
        "What model for the Agent? [gpt-4o]",
        Some("gpt-4o"),
        false,
    )?;
    secrets.insert("DEFAULT_MODEL".into(), agent_model);

    let worker_model = prompt_text(
        reader,
        "What model for the Worker? [gpt-4o-mini]",
        Some("gpt-4o-mini"),
        false,
    )?;
    secrets.insert("WORKER_MODEL".into(), worker_model);

    Ok(())
}
```

**Step 6: Create collect_ollama()**

```rust
async fn collect_ollama(
    reader: &mut StdinReader,
    secrets: &mut HashMap<String, String>,
) -> Result<()> {
    use crate::validation;

    // Collect endpoint(s)
    let raw_endpoints = prompt_text(
        reader,
        "Enter your Ollama endpoint(s), comma-separated [localhost:11434]",
        Some("localhost:11434"),
        false,
    )?;

    // Rewrite localhost → host.docker.internal
    let rewritten = validation::rewrite_endpoints(&raw_endpoints);
    if validation::has_localhost(&raw_endpoints) {
        println!("  (Rewriting localhost → host.docker.internal for Kubernetes)");
    }

    // Validate each endpoint and discover models
    let endpoints: Vec<&str> = rewritten.split(',').map(|e| e.trim()).collect();
    let mut all_models = Vec::new();
    let mut reachable_endpoints = Vec::new();

    for ep in &endpoints {
        print!("  Checking {}... ", ep);
        std::io::stdout().flush()?;
        match validation::validate_ollama_endpoint(ep).await {
            Ok(()) => {
                println!("✓ Connected");
                reachable_endpoints.push(*ep);
                if let Ok(models) = validation::discover_ollama_models(ep).await {
                    for m in models {
                        if !all_models.iter().any(|existing: &validation::OllamaModel| existing.name == m.name) {
                            all_models.push(m);
                        }
                    }
                }
            }
            Err(e) => {
                println!("✗ {}", e);
                println!("    Is your Ollama server running?");
            }
        }
    }

    secrets.insert("OLLAMA_ENDPOINTS".into(), rewritten);

    if all_models.is_empty() {
        println!();
        println!("  ✗ Could not discover models from endpoint(s).");
        println!("    You can still enter model names manually.");
        println!();

        let agent_model = prompt_text(reader, "What model for the Agent?", None, true)?;
        secrets.insert("DEFAULT_MODEL".into(), agent_model);

        let worker_model = prompt_text(reader, "What model for the Worker?", None, true)?;
        secrets.insert("WORKER_MODEL".into(), worker_model);
    } else {
        // Sort by size descending
        all_models.sort_by(|a, b| b.size.cmp(&a.size));

        println!();
        println!("Found {} model(s):", all_models.len());
        println!();
        for (i, m) in all_models.iter().enumerate() {
            let size_gb = m.size as f64 / 1_073_741_824.0;
            println!("  {}) {} ({:.1} GB)", i + 1, m.name, size_gb);
        }

        let recs = validation::recommend_ollama_models(&all_models);
        println!();
        println!("Recommended:");
        println!("  Agent:     {} (largest — best for reasoning and tool calling)", recs.agent);
        println!("  Worker:    {} (good throughput for background tasks)", recs.worker);
        println!();

        let agent_model = prompt_text(
            reader,
            &format!("What model for the Agent? [{}]", recs.agent),
            Some(&recs.agent),
            false,
        )?;
        secrets.insert("DEFAULT_MODEL".into(), agent_model);

        let worker_model = prompt_text(
            reader,
            &format!("What model for the Worker? [{}]", recs.worker),
            Some(&recs.worker),
            false,
        )?;
        secrets.insert("WORKER_MODEL".into(), worker_model);
    }

    Ok(())
}
```

**Step 7: Create collect_observer_reflector()**

```rust
fn collect_observer_reflector(
    reader: &mut StdinReader,
    _provider: Provider,
    secrets: &mut HashMap<String, String>,
) -> Result<()> {
    let agent_model = secrets.get("DEFAULT_MODEL").cloned().unwrap_or_default();
    let worker_model = secrets.get("WORKER_MODEL").cloned().unwrap_or_default();

    println!();
    let configure = prompt_text(
        reader,
        "Configure Observer and Reflector separately? [y/N]",
        Some("N"),
        false,
    )?;

    if configure.trim().eq_ignore_ascii_case("y") || configure.trim().eq_ignore_ascii_case("yes") {
        let observer_default = &worker_model;
        let observer = prompt_text(
            reader,
            &format!("What model for the Observer? [{}]", observer_default),
            Some(observer_default),
            false,
        )?;
        secrets.insert("OBSERVER_MODEL".into(), observer);

        let reflector_default = &agent_model;
        let reflector = prompt_text(
            reader,
            &format!("What model for the Reflector? [{}]", reflector_default),
            Some(reflector_default),
            false,
        )?;
        secrets.insert("REFLECTOR_MODEL".into(), reflector);
    } else {
        // Set explicit defaults: Observer = Worker, Reflector = Agent
        secrets.insert("OBSERVER_MODEL".into(), worker_model);
        secrets.insert("REFLECTOR_MODEL".into(), agent_model);
    }

    Ok(())
}
```

**Step 8: Add prompt_secret() helper**

```rust
/// Prompt for a secret value (same as prompt_text but semantically distinct).
fn prompt_secret(reader: &mut StdinReader, prompt: &str) -> Result<String> {
    prompt_text(reader, prompt, None, true)
}
```

**Step 9: Verify compilation**

Run: `cd tools/installer && cargo check`
Expected: Compiles (new functions defined but not yet wired into run_interactive).

**Step 10: Commit**

```bash
git add tools/installer/src/interview.rs
git commit -m "feat(installer): add provider selection and model role collection functions"
```

---

### Task 5: Rewrite run_interactive() — Sections 3-6 and Wiring

Wire all sections together into the new `run_interactive()` and add Security, Memory, Features, and Confirmation sections.

**Files:**
- Modify: `tools/installer/src/interview.rs`

**Step 1: Create section_security()**

```rust
/// Section 3: Security — auth token.
fn section_security(reader: &mut StdinReader) -> Result<String> {
    println!();
    println!("--- Security ---");
    println!();

    let token = prompt_text(
        reader,
        "Enter an auth token, or press Enter to generate one automatically. [auto]",
        Some("auto"),
        false,
    )?;

    if token == "auto" {
        let generated = generate_value("hex:32")?;
        println!("  ✓ Auth token generated");
        Ok(generated)
    } else {
        Ok(token)
    }
}
```

**Step 2: Create section_memory()**

```rust
/// Section 4: Memory & Embeddings — Voyage AI key.
async fn section_memory(reader: &mut StdinReader) -> Result<Option<String>> {
    use crate::validation;

    println!();
    println!("--- Memory & Embeddings ---");
    println!();
    println!("Baker Street stores conversation memories as vector embeddings.");
    println!("Better embeddings = better recall. Voyage AI provides high-quality");
    println!("embeddings, but memory still works without it (just less precise).");
    println!();

    // Check env var first
    if let Ok(env_key) = std::env::var("VOYAGE_API_KEY") {
        if !env_key.is_empty() {
            let masked = format!("{}...{}", &env_key[..4], &env_key[env_key.len()-4..]);
            let use_it = prompt_text(
                reader,
                &format!("I found a Voyage AI key in your environment [{}]. Use this? [Y/n]", masked),
                Some("Y"),
                false,
            )?;
            if !use_it.trim().eq_ignore_ascii_case("n") {
                print!("  Verifying... ");
                std::io::stdout().flush()?;
                match validation::validate_voyage_key(&env_key).await {
                    Ok(()) => {
                        println!("✓ Key verified");
                        return Ok(Some(env_key));
                    }
                    Err(e) => println!("✗ {}", e),
                }
            }
        }
    }

    let key = prompt_text(
        reader,
        "Paste your Voyage AI API key, or press Enter to skip [skip]",
        Some(""),
        false,
    )?;

    if key.is_empty() || key == "skip" {
        Ok(None)
    } else {
        print!("  Verifying... ");
        std::io::stdout().flush()?;
        match validation::validate_voyage_key(&key).await {
            Ok(()) => {
                println!("✓ Key verified");
                Ok(Some(key))
            }
            Err(e) => {
                println!("✗ {} — skipping Voyage AI", e);
                Ok(None)
            }
        }
    }
}
```

**Step 3: Create section_features()**

```rust
/// Section 5: Features — optional integrations.
async fn section_features(
    reader: &mut StdinReader,
    schema: &ConfigSchema,
    secrets: &mut HashMap<String, String>,
) -> Result<Vec<String>> {
    use crate::validation;

    println!();
    println!("--- Features ---");

    let mut enabled = Vec::new();

    for feature in &schema.features {
        // Skip voyage — handled in section_memory
        if feature.id == "voyage" {
            if secrets.contains_key("VOYAGE_API_KEY") {
                enabled.push(feature.id.clone());
            }
            continue;
        }

        println!();
        let enable = prompt_text(
            reader,
            &format!("{}? [y/N]", feature.description),
            Some("N"),
            false,
        )?;

        if !enable.trim().eq_ignore_ascii_case("y") && !enable.trim().eq_ignore_ascii_case("yes") {
            continue;
        }

        enabled.push(feature.id.clone());

        // Collect feature secrets
        for secret_def in &feature.secrets {
            if secret_def.silent {
                continue;
            }

            // Check env var
            let env_val = std::env::var(&secret_def.key).ok().filter(|v| !v.is_empty());
            let value = if let Some(env_val) = &env_val {
                let masked = mask_value(env_val);
                let use_it = prompt_text(
                    reader,
                    &format!(
                        "I found {} in your environment [{}]. Use this? [Y/n]",
                        secret_def.key, masked
                    ),
                    Some("Y"),
                    false,
                )?;
                if use_it.trim().eq_ignore_ascii_case("n") {
                    let prompt = secret_def.prompt.as_deref().unwrap_or(&secret_def.description);
                    prompt_text(reader, prompt, None, secret_def.required)?
                } else {
                    env_val.clone()
                }
            } else {
                let prompt = secret_def.prompt.as_deref().unwrap_or(&secret_def.description);
                if secret_def.required {
                    prompt_text(reader, prompt, None, true)?
                } else {
                    prompt_text(reader, &format!("{} (or press Enter to skip)", prompt), Some(""), false)?
                }
            };

            if !value.is_empty() {
                // Validate where possible
                match secret_def.key.as_str() {
                    "TELEGRAM_BOT_TOKEN" => {
                        print!("  Verifying... ");
                        std::io::stdout().flush()?;
                        match validation::validate_telegram_token(&value).await {
                            Ok(username) => println!("✓ Bot verified: @{}", username),
                            Err(e) => println!("✗ {} — continuing anyway", e),
                        }
                    }
                    "GITHUB_TOKEN" => {
                        print!("  Verifying... ");
                        std::io::stdout().flush()?;
                        match validation::validate_github_token(&value).await {
                            Ok(username) => println!("✓ Authenticated as @{}", username),
                            Err(e) => println!("✗ {} — continuing anyway", e),
                        }
                    }
                    _ => {}
                }

                secrets.insert(secret_def.key.clone(), value);
            }
        }
    }

    Ok(enabled)
}
```

**Step 4: Create section_confirm() and mask_value()**

```rust
/// Section 6: Confirmation summary.
fn section_confirm(
    reader: &mut StdinReader,
    namespace: &str,
    agent_name: &str,
    provider: Provider,
    secrets: &HashMap<String, String>,
    features: &[String],
) -> Result<bool> {
    println!();
    println!("--- Review ---");
    println!();
    println!("  Namespace:    {}", namespace);
    println!("  Agent name:   {}", agent_name);
    println!();

    let provider_label = match provider {
        Provider::Anthropic => "Anthropic",
        Provider::OpenAI => "OpenAI",
        Provider::Ollama => {
            let eps = secrets.get("OLLAMA_ENDPOINTS").map(|s| s.as_str()).unwrap_or("unknown");
            &format!("Ollama ({})", eps)
        }
    };
    // Provider::Ollama borrows from a temporary — use a String approach
    let provider_str = match provider {
        Provider::Anthropic => "Anthropic".to_string(),
        Provider::OpenAI => "OpenAI".to_string(),
        Provider::Ollama => format!(
            "Ollama ({})",
            secrets.get("OLLAMA_ENDPOINTS").map(|s| s.as_str()).unwrap_or("unknown")
        ),
    };
    println!("  Provider:     {}", provider_str);
    println!(
        "  Agent model:  {}",
        secrets.get("DEFAULT_MODEL").map(|s| s.as_str()).unwrap_or("(default)")
    );
    println!(
        "  Worker model: {}",
        secrets.get("WORKER_MODEL").map(|s| s.as_str()).unwrap_or("(default)")
    );

    let observer = secrets.get("OBSERVER_MODEL");
    let worker = secrets.get("WORKER_MODEL");
    let reflector = secrets.get("REFLECTOR_MODEL");
    let agent = secrets.get("DEFAULT_MODEL");

    if observer == worker {
        println!("  Observer:     {} (same as Worker)", observer.map(|s| s.as_str()).unwrap_or("(default)"));
    } else {
        println!("  Observer:     {}", observer.map(|s| s.as_str()).unwrap_or("(default)"));
    }

    if reflector == agent {
        println!("  Reflector:    {} (same as Agent)", reflector.map(|s| s.as_str()).unwrap_or("(default)"));
    } else {
        println!("  Reflector:    {}", reflector.map(|s| s.as_str()).unwrap_or("(default)"));
    }

    println!();
    if features.is_empty() {
        println!("  Features:     (none)");
    } else {
        println!("  Features:     {}", features.join(", "));
    }

    if secrets.contains_key("VOYAGE_API_KEY") {
        println!("  Memory:       Voyage AI embeddings");
    }

    println!();

    let proceed = prompt_text(reader, "Proceed with installation? [Y/n]", Some("Y"), false)?;
    Ok(!proceed.trim().eq_ignore_ascii_case("n"))
}

/// Mask a secret value for display: show first 4 and last 4 chars.
fn mask_value(value: &str) -> String {
    if value.len() <= 8 {
        "****".to_string()
    } else {
        format!("{}...{}", &value[..4], &value[value.len()-4..])
    }
}
```

**Step 5: Rewrite run_interactive()**

Replace the existing `run_interactive()` function body (lines ~111-264) with the new section-based flow:

```rust
/// Run the full interactive interview. Walks the user through provider selection,
/// model role assignment, security, memory, and features.
pub async fn run_interactive(schema: &ConfigSchema) -> Result<InterviewResult> {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin);

    println!();
    println!("Let's set up Baker Street!");
    println!("Press Enter to accept defaults shown in [brackets].");
    println!("Environment variables are used as defaults when available.");

    // Section 1: Basics
    let (namespace, agent_name) = section_basics(&mut reader, schema)?;

    // Section 2: AI Provider + Model Roles
    let (provider, mut secrets) = section_provider(&mut reader, schema).await?;

    // Section 3: Security
    let auth_token = section_security(&mut reader)?;
    secrets.insert("AUTH_TOKEN".into(), auth_token);
    secrets.insert("AGENT_NAME".into(), agent_name.clone());

    // Section 4: Memory & Embeddings
    if let Some(voyage_key) = section_memory(&mut reader).await? {
        secrets.insert("VOYAGE_API_KEY".into(), voyage_key);
    }

    // Section 5: Features
    let enabled_features = section_features(&mut reader, schema, &mut secrets).await?;

    // Section 6: Confirmation
    if !section_confirm(&mut reader, &namespace, &agent_name, provider, &secrets, &enabled_features)? {
        anyhow::bail!("Installation cancelled by user.");
    }

    Ok(InterviewResult {
        secrets,
        enabled_features,
        namespace,
        agent_name,
    })
}
```

**Step 6: Do NOT default OBSERVER_MODEL/REFLECTOR_MODEL in from_config_file() or from_env()**

The TypeScript runtime (`model-config.ts`) already defaults observer→haiku-4.5 and reflector→sonnet-4
when these env vars are absent. Only the interactive interview (`run_interactive()`) should set explicit
defaults (Observer=Worker, Reflector=Agent) because the user confirmed them.

In `from_config_file()` and `from_env()`: if OBSERVER_MODEL or REFLECTOR_MODEL are not provided,
leave them absent from the secrets HashMap. The application layer handles missing values correctly.

**Step 7: Run all installer tests**

Run: `cd tools/installer && cargo test`
Expected: All tests pass. The interview tests that test `generate_value()` and other helpers are unaffected.

**Step 8: Commit**

```bash
git add tools/installer/src/interview.rs
git commit -m "feat(installer): rewrite interactive interview with provider selection, model roles, and validation"
```

---

### Task 6: Update test scenarios for OBSERVER_MODEL/REFLECTOR_MODEL

**Files:**
- Modify: `test/installer-scenarios/scenario-anthropic-cloud.yaml`
- Modify: `test/installer-scenarios/scenario-ollama-single.yaml`
- Modify: `test/installer-scenarios/run-scenarios.sh` (add observer/reflector checks)
- Modify: `test/acceptance/test-config.yaml`

**Step 1: Add OBSERVER_MODEL and REFLECTOR_MODEL to scenario files**

In each scenario YAML, add after WORKER_MODEL:

For anthropic-cloud.yaml:
```yaml
  OBSERVER_MODEL: "claude-haiku-4-5-20251001"
  REFLECTOR_MODEL: "claude-sonnet-4-20250514"
```

For ollama-single.yaml:
```yaml
  OBSERVER_MODEL: "qwen3.5:9b"
  REFLECTOR_MODEL: "qwen2.5-coder:32b"
```

For all others, follow the pattern: Observer = Worker model, Reflector = Agent model.

A dedicated roles scenario (`scenario-anthropic-roles.yaml`) validates that all 4 model roles
(DEFAULT_MODEL, WORKER_MODEL, OBSERVER_MODEL, REFLECTOR_MODEL) are propagated to the brain pod.

**Step 2: Add observer/reflector checks to run-scenarios.sh**

In the `run_extra_checks()` function, add after the worker model check:

```bash
  # Check 3: Verify observer model
  local expected_observer
  expected_observer=$(grep -E '^\s+OBSERVER_MODEL:' "$config_file" | head -1 | sed 's/.*: *"\?\([^"]*\)"\?/\1/' | xargs)
  if [[ -n "$expected_observer" && "$expected_observer" != '${'* ]]; then
    local actual_observer
    actual_observer=$(kubectl exec -n "$ns" deploy/brain-blue -- printenv OBSERVER_MODEL 2>/dev/null || echo "")
    if [[ "$actual_observer" == "$expected_observer" ]]; then
      echo "    [PASS] Observer model: ${actual_observer}"
      ((checks_passed++))
    else
      echo "    [FAIL] Observer model: expected '${expected_observer}', got '${actual_observer}'"
      ((checks_failed++))
    fi
  fi

  # Check 4: Verify reflector model
  local expected_reflector
  expected_reflector=$(grep -E '^\s+REFLECTOR_MODEL:' "$config_file" | head -1 | sed 's/.*: *"\?\([^"]*\)"\?/\1/' | xargs)
  if [[ -n "$expected_reflector" && "$expected_reflector" != '${'* ]]; then
    local actual_reflector
    actual_reflector=$(kubectl exec -n "$ns" deploy/brain-blue -- printenv REFLECTOR_MODEL 2>/dev/null || echo "")
    if [[ "$actual_reflector" == "$expected_reflector" ]]; then
      echo "    [PASS] Reflector model: ${actual_reflector}"
      ((checks_passed++))
    else
      echo "    [FAIL] Reflector model: expected '${expected_reflector}', got '${actual_reflector}'"
      ((checks_failed++))
    fi
  fi
```

**Step 3: Update acceptance test config**

In `test/acceptance/test-config.yaml`, add:

```yaml
  OBSERVER_MODEL: "claude-haiku-4-5-20251001"
  REFLECTOR_MODEL: "claude-sonnet-4-20250514"
```

**Step 4: Commit**

```bash
git add test/installer-scenarios/ test/acceptance/test-config.yaml
git commit -m "test(installer): add OBSERVER_MODEL and REFLECTOR_MODEL to scenario files"
```

---

### Task 7: Integration testing

Run the full installer test suite, then run a scenario end-to-end on the local cluster.

**Files:**
- No new files

**Step 1: Run unit tests**

Run: `cd tools/installer && cargo test`
Expected: All tests pass.

**Step 2: Run with --dry-run against a scenario**

Run: `cd tools/installer && cargo build --release && ./target/release/bakerst-install install --config ../../test/installer-scenarios/scenario-anthropic-cloud.yaml --dry-run`
Expected: Interview is skipped (config file mode), dry run completes, shows what would be applied.

**Step 3: Run interactive interview manually**

Run: `cd tools/installer && cargo run -- install --dry-run`
Walk through the interview: choose Anthropic, enter a test key, select models, skip features.
Expected: New section-based flow with provider choice, model role explanation, and confirmation summary.

**Step 4: Run a full scenario against the local cluster**

Run: `cd test/installer-scenarios && ./run-scenarios.sh --binary ../../tools/installer/target/release/bakerst-install scenario-anthropic-cloud.yaml`
Expected: Install completes, all checks pass (pods, brain health, model config, UI, gateway), namespace cleaned up.

**Step 5: Commit any fixes**

If any issues are found, fix and commit.

---

### Task 8: Final cleanup and documentation

**Files:**
- Modify: `CLAUDE.md` (add OBSERVER_MODEL and REFLECTOR_MODEL to secrets docs)
- Modify: `docs/plans/2026-03-12-installer-interview-script.md` (mark as implemented)

**Step 1: Update CLAUDE.md secrets section**

In the `.env-secrets` documentation, add:

```
OBSERVER_MODEL            # Observer model override (optional, defaults to WORKER_MODEL)
REFLECTOR_MODEL           # Reflector model override (optional, defaults to DEFAULT_MODEL)
```

And update the Secret Scoping section to include them in bakerst-brain-secrets and bakerst-worker-secrets.

**Step 2: Mark design doc as implemented**

Add to the top of `docs/plans/2026-03-12-installer-interview-script.md`:

```markdown
<!-- Implemented: 2026-03-12 | See installer v0.6 -->
```

**Step 3: Run final test suite**

Run: `cd tools/installer && cargo test`
Expected: All pass.

**Step 4: Commit**

```bash
git add CLAUDE.md docs/plans/2026-03-12-installer-interview-script.md
git commit -m "docs: update CLAUDE.md with OBSERVER_MODEL/REFLECTOR_MODEL, mark interview script implemented"
```
