//! Interview engine — drives the secret/feature collection process.
//!
//! Three modes:
//! - `from_config_file`: non-interactive, reads a YAML config file
//! - `from_env`: non-interactive, reads secrets from environment variables
//! - `run_interactive`: stdin-based interactive interview

use anyhow::{bail, Result};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};

use crate::config_file::ConfigFile;
use crate::config_schema::ConfigSchema;

type StdinReader = BufReader<std::io::Stdin>;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Provider {
    Anthropic,
    OpenAI,
    Ollama,
}

#[derive(Debug)]
pub struct InterviewResult {
    pub secrets: HashMap<String, String>,
    pub enabled_features: Vec<String>,
    pub namespace: String,
    pub agent_name: String,
}

impl InterviewResult {
    pub fn save_non_secret(&self, path: &std::path::Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let non_secret = serde_json::json!({
            "namespace": self.namespace,
            "enabledFeatures": self.enabled_features,
            "agentName": self.agent_name,
        });
        std::fs::write(path, serde_json::to_string_pretty(&non_secret)?)?;
        Ok(())
    }
}

/// Build an InterviewResult from a config file (non-interactive mode).
pub fn from_config_file(schema: &ConfigSchema, config: &ConfigFile) -> Result<InterviewResult> {
    let mut secrets = config.secrets.clone();

    // Auto-generate any secrets marked with autoGenerate that aren't provided
    for secret_def in &schema.secrets {
        if !secrets.contains_key(&secret_def.key) {
            if let Some(ref auto_gen) = secret_def.auto_generate {
                secrets.insert(secret_def.key.clone(), generate_value(auto_gen)?);
            }
        }
        if secrets.get(&secret_def.key).map(|v| v.as_str()) == Some("auto") {
            if let Some(ref auto_gen) = secret_def.auto_generate {
                secrets.insert(secret_def.key.clone(), generate_value(auto_gen)?);
            }
        }
    }

    // Also process feature-level secrets
    for feature in &schema.features {
        if config
            .features
            .get(&feature.id)
            .copied()
            .unwrap_or(feature.default_enabled)
        {
            for secret_def in &feature.secrets {
                if !secrets.contains_key(&secret_def.key) {
                    if let Some(ref auto_gen) = secret_def.auto_generate {
                        secrets.insert(secret_def.key.clone(), generate_value(auto_gen)?);
                    }
                }
            }
        }
    }

    let enabled_features: Vec<String> = schema
        .features
        .iter()
        .filter(|f| {
            config
                .features
                .get(&f.id)
                .copied()
                .unwrap_or(f.default_enabled)
        })
        .map(|f| f.id.clone())
        .collect();

    let namespace = config
        .namespace
        .clone()
        .unwrap_or_else(|| schema.defaults.namespace.clone());

    // Validate provider requirement
    let has_provider = schema
        .provider_validation
        .require_at_least_one
        .iter()
        .any(|key| secrets.get(key).map_or(false, |v| !v.is_empty()));
    if !has_provider {
        bail!("{}", schema.provider_validation.message);
    }

    Ok(InterviewResult {
        secrets,
        enabled_features,
        namespace,
        agent_name: schema.defaults.agent_name.clone(),
    })
}

/// Run the full interactive interview. Walks the user through provider selection,
/// model role assignment, security, memory, and features.
pub async fn run_interactive(schema: &ConfigSchema) -> Result<InterviewResult> {
    let stdin = io::stdin();
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

/// Print a prompt and read a line from stdin.
/// If the user presses Enter (empty input) and a default is provided, the default is returned.
fn prompt_text(
    reader: &mut impl BufRead,
    prompt: &str,
    default: Option<&str>,
    _required: bool,
) -> Result<String> {
    match default {
        Some(d) if !d.is_empty() => print!("  {} [{}]: ", prompt, d),
        _ => print!("  {}: ", prompt),
    }
    io::stdout().flush()?;
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let trimmed = line.trim().to_string();
    if trimmed.is_empty() {
        Ok(default.unwrap_or("").to_string())
    } else {
        Ok(trimmed)
    }
}

/// Build an InterviewResult from environment variables (CI/headless mode).
pub fn from_env(schema: &ConfigSchema) -> Result<InterviewResult> {
    let mut secrets = HashMap::new();
    for secret_def in &schema.secrets {
        if let Ok(val) = std::env::var(&secret_def.key) {
            secrets.insert(secret_def.key.clone(), val);
        } else if let Some(ref auto_gen) = secret_def.auto_generate {
            secrets.insert(secret_def.key.clone(), generate_value(auto_gen)?);
        }
    }

    let enabled_features: Vec<String> = schema
        .features
        .iter()
        .filter(|f| f.default_enabled)
        .map(|f| f.id.clone())
        .collect();

    let has_provider = schema
        .provider_validation
        .require_at_least_one
        .iter()
        .any(|key| secrets.get(key).map_or(false, |v| !v.is_empty()));
    if !has_provider {
        bail!("{}", schema.provider_validation.message);
    }

    Ok(InterviewResult {
        secrets,
        enabled_features,
        namespace: schema.defaults.namespace.clone(),
        agent_name: schema.defaults.agent_name.clone(),
    })
}

/// Generate a value from a spec string (e.g., "hex:32" = 32 random hex bytes).
fn generate_value(spec: &str) -> Result<String> {
    if let Some(len_str) = spec.strip_prefix("hex:") {
        let len: usize = len_str.parse()?;
        let mut bytes = vec![0u8; len];
        getrandom::getrandom(&mut bytes)
            .map_err(|e| anyhow::anyhow!("Failed to generate random bytes: {}", e))?;
        Ok(hex::encode(bytes))
    } else {
        bail!("Unknown autoGenerate format: {}", spec);
    }
}

/// Section 1: Basics — namespace and agent name.
fn section_basics(reader: &mut StdinReader, schema: &ConfigSchema) -> Result<(String, String)> {
    println!();
    println!("--- Basics ---");
    println!();

    let namespace = prompt_text(
        reader,
        "What is the name of the Kubernetes namespace?",
        Some(&schema.defaults.namespace),
        false,
    )?;

    let agent_name = prompt_text(
        reader,
        "What name would you like to give your AI assistant?",
        Some(&schema.defaults.agent_name),
        false,
    )?;

    Ok((namespace, agent_name))
}

/// Section 2: AI Provider — choose provider, validate key, select models for all 4 roles.
async fn section_provider(
    reader: &mut StdinReader,
    _schema: &ConfigSchema,
) -> Result<(Provider, HashMap<String, String>)> {

    println!();
    println!("--- AI Provider ---");
    println!();
    println!("Which AI provider would you like to use?");
    println!();
    println!("  1) Anthropic (Claude — Sonnet, Opus, Haiku)");
    println!("  2) OpenAI (GPT-4o, o3-mini)");
    println!("  3) Ollama (local models — OpenAI-compatible API)");
    println!();

    let choice = prompt_text(reader, "Choice", Some("1"), false)?;
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
        "What model for the Agent?",
        Some("claude-sonnet-4-20250514"),
        false,
    )?;
    secrets.insert("DEFAULT_MODEL".into(), agent_model);

    let worker_model = prompt_text(
        reader,
        "What model for the Worker?",
        Some("claude-haiku-4-5-20251001"),
        false,
    )?;
    secrets.insert("WORKER_MODEL".into(), worker_model);

    Ok(())
}

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
        "What model for the Agent?",
        Some("gpt-4o"),
        false,
    )?;
    secrets.insert("DEFAULT_MODEL".into(), agent_model);

    let worker_model = prompt_text(
        reader,
        "What model for the Worker?",
        Some("gpt-4o-mini"),
        false,
    )?;
    secrets.insert("WORKER_MODEL".into(), worker_model);

    Ok(())
}

async fn collect_ollama(
    reader: &mut StdinReader,
    secrets: &mut HashMap<String, String>,
) -> Result<()> {
    use crate::validation;

    // Collect endpoint(s)
    let raw_endpoints = prompt_text(
        reader,
        "Enter your Ollama endpoint(s), comma-separated",
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
            "What model for the Agent?",
            Some(&recs.agent),
            false,
        )?;
        secrets.insert("DEFAULT_MODEL".into(), agent_model);

        let worker_model = prompt_text(
            reader,
            "What model for the Worker?",
            Some(&recs.worker),
            false,
        )?;
        secrets.insert("WORKER_MODEL".into(), worker_model);
    }

    Ok(())
}

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
        "Configure Observer and Reflector separately?",
        Some("N"),
        false,
    )?;

    if configure.trim().eq_ignore_ascii_case("y") || configure.trim().eq_ignore_ascii_case("yes") {
        let observer_default = &worker_model;
        let observer = prompt_text(
            reader,
            "What model for the Observer?",
            Some(observer_default),
            false,
        )?;
        secrets.insert("OBSERVER_MODEL".into(), observer);

        let reflector_default = &agent_model;
        let reflector = prompt_text(
            reader,
            "What model for the Reflector?",
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

/// Section 3: Security — auth token.
fn section_security(reader: &mut StdinReader) -> Result<String> {
    println!();
    println!("--- Security ---");
    println!();

    let token = prompt_text(
        reader,
        "Enter an auth token, or press Enter to generate one automatically",
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
            let masked = mask_value(&env_key);
            let use_it = prompt_text(
                reader,
                &format!("I found a Voyage AI key in your environment ({}). Use this?", masked),
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
        "Paste your Voyage AI API key, or press Enter to skip",
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
            &format!("{}?", feature.description),
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
                        "I found {} in your environment ({}). Use this?",
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

    let proceed = prompt_text(reader, "Proceed with installation?", Some("Y"), false)?;
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

/// Prompt for a secret value (same as prompt_text but semantically distinct).
fn prompt_secret(reader: &mut StdinReader, prompt: &str) -> Result<String> {
    prompt_text(reader, prompt, None, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_hex_value() {
        let val = generate_value("hex:32").unwrap();
        assert_eq!(val.len(), 64); // 32 bytes = 64 hex chars
        assert!(val.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_generate_unknown_format() {
        assert!(generate_value("base64:32").is_err());
    }

    #[test]
    fn test_generate_produces_different_values() {
        let v1 = generate_value("hex:32").unwrap();
        let v2 = generate_value("hex:32").unwrap();
        assert_ne!(v1, v2);
    }
}
