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
pub fn validate_endpoint_format(endpoint: &str) -> Result<()> {
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
