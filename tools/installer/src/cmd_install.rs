use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::app::{App, FeatureSelection, InstallConfig, ItemStatus, Phase, ProviderStep, ProviderType, SecretPrompt};
use crate::cli::{Cli, InstallArgs};
use crate::config_file;
use crate::health::{self, HealthEvent};
use crate::images::{self, PullEvent};
use crate::k8s;
use crate::manifest::ReleaseManifest;
use crate::meta;
use crate::templates::{self, generate_auth_token, render as render_template};
use crate::tui::Tui;

/// Internal message type for async phase operations communicating back to the main loop
enum AsyncMsg {
    Pull(PullEvent),
    Health(HealthEvent),
    DeployStep { index: usize, result: Result<(), String> },
    DeployDone,
}

/// Entry point for the `install` subcommand.
pub async fn run(cli: &Cli, args: &InstallArgs) -> Result<()> {
    if let Some(ref config_path) = args.config {
        return run_config_install(cli, args, config_path).await;
    }

    if args.non_interactive {
        return run_non_interactive(cli, args).await;
    }

    // Interactive TUI mode
    run_tui(cli, args).await
}

// ============================================================
//  Interactive TUI mode
// ============================================================

async fn run_tui(cli: &Cli, args: &InstallArgs) -> Result<()> {
    let mut app = App::new(cli.namespace.clone());

    let (async_tx, mut async_rx) = mpsc::unbounded_channel::<AsyncMsg>();

    let mut tui = Tui::new()?;

    // Run preflight immediately
    run_preflight(&mut app, cli).await;

    loop {
        tui.draw(&app)?;

        if event::poll(Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c')
                {
                    app.should_quit = true;
                }

                if !app.should_quit {
                    handle_key(&mut app, key, cli, args, &async_tx).await?;
                }
            }
        }

        while let Ok(msg) = async_rx.try_recv() {
            handle_async_msg(&mut app, msg);
        }

        handle_auto_advance(&mut app, cli, args, &async_tx).await?;

        if app.should_quit {
            break;
        }
    }

    tui.restore()?;
    Ok(())
}

// ============================================================
//  Phase 1: Preflight
// ============================================================

async fn run_preflight(app: &mut App, cli: &Cli) {
    app.preflight_checks.clear();

    // Check 1: Docker available
    app.preflight_checks
        .push(("Docker CLI".into(), ItemStatus::InProgress));
    match tokio::process::Command::new("docker")
        .args(["version", "--format", "{{.Client.Version}}"])
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
            app.preflight_checks[0] = (format!("Docker CLI (v{})", ver), ItemStatus::Done);
        }
        _ => {
            app.preflight_checks[0] = (
                "Docker CLI".into(),
                ItemStatus::Failed("docker not found in PATH".into()),
            );
        }
    }

    // Check 2: Kubernetes cluster
    app.preflight_checks
        .push(("Kubernetes cluster".into(), ItemStatus::InProgress));
    match k8s::check_cluster().await {
        Ok(version) => {
            app.cluster_name = format!("k8s {}", version);
            app.preflight_checks[1] = (
                format!("Kubernetes cluster (v{})", version),
                ItemStatus::Done,
            );
        }
        Err(e) => {
            app.cluster_name = "disconnected".into();
            app.preflight_checks[1] = (
                "Kubernetes cluster".into(),
                ItemStatus::Failed(format!("{}", e)),
            );
        }
    }

    // Check 3: Fetch/load manifest
    app.preflight_checks
        .push(("Release manifest".into(), ItemStatus::InProgress));
    let manifest_result: Result<ReleaseManifest, String> = if let Some(ref path) = cli.manifest {
        crate::manifest::load_manifest_from_file(path).map_err(|e| e.to_string())
    } else {
        crate::manifest::embedded_manifest().map_err(|e| e.to_string())
    };

    match manifest_result {
        Ok(m) => {
            app.manifest_version = m.version.clone();
            app.preflight_checks[2] = (
                format!("Release manifest (v{})", m.version),
                ItemStatus::Done,
            );
            build_secret_prompts(app, &m);
            build_feature_selections(app, &m);
            app.manifest = Some(m);
        }
        Err(e) => {
            app.preflight_checks[2] = (
                "Release manifest".into(),
                ItemStatus::Failed(e),
            );
        }
    }

    // Check 4: kubectl available
    app.preflight_checks
        .push(("kubectl CLI".into(), ItemStatus::InProgress));
    match tokio::process::Command::new("kubectl")
        .args(["version", "--client", "--short"])
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            app.preflight_checks[3] = ("kubectl CLI".into(), ItemStatus::Done);
        }
        _ => {
            app.preflight_checks[3] = (
                "kubectl CLI".into(),
                ItemStatus::Failed("kubectl not found".into()),
            );
        }
    }

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
                let masked = if val.chars().count() > 12 {
                    let prefix: String = val.chars().take(3).collect();
                    let suffix: String = val.chars().rev().take(3).collect::<String>().chars().rev().collect();
                    format!("{}...{}", prefix, suffix)
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
}

/// Keys handled in the Providers phase, not Secrets
const PROVIDER_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "DEFAULT_MODEL",
    "OPENAI_API_KEY",
    "OLLAMA_ENDPOINTS",
    "VOYAGE_API_KEY",
];

/// Model presets: (api_id, display_name, description)
const ANTHROPIC_MODELS: &[(&str, &str, &str)] = &[
    ("claude-sonnet-4-20250514", "Sonnet 4", "balanced"),
    ("claude-opus-4-20250514", "Opus 4", "most capable"),
    ("claude-haiku-4-5-20251001", "Haiku 4.5", "fastest"),
];
const OPENAI_MODELS: &[(&str, &str, &str)] = &[
    ("gpt-4o", "GPT-4o", "flagship"),
    ("gpt-4o-mini", "GPT-4o Mini", "fast/cheap"),
    ("o3-mini", "o3-mini", "reasoning"),
];

/// Get model list for a provider (used by tui.rs)
pub fn models_for_provider(provider: ProviderType) -> &'static [(&'static str, &'static str, &'static str)] {
    match provider {
        ProviderType::Anthropic => ANTHROPIC_MODELS,
        ProviderType::OpenAI => OPENAI_MODELS,
        ProviderType::Ollama => &[],
    }
}

fn build_secret_prompts(app: &mut App, manifest: &ReleaseManifest) {
    app.secret_prompts.clear();

    for secret in &manifest.required_secrets {
        if PROVIDER_KEYS.contains(&secret.key.as_str()) {
            continue;
        }
        app.secret_prompts.push(SecretPrompt {
            key: secret.key.clone(),
            description: secret.description.clone(),
            required: secret.required,
            is_secret: secret.input_type == "secret",
            is_feature: false,
            value: None,
        });
    }
}

fn build_feature_selections(app: &mut App, manifest: &ReleaseManifest) {
    app.config.features.clear();

    for feature in &manifest.optional_features {
        app.config.features.push(FeatureSelection {
            id: feature.id.clone(),
            name: feature.name.clone(),
            enabled: feature.default_enabled,
            secrets: feature
                .secrets
                .iter()
                .map(|k| (k.clone(), None))
                .collect(),
        });
    }
}

// ============================================================
//  Key handling
// ============================================================

async fn handle_key(
    app: &mut App,
    key: event::KeyEvent,
    _cli: &Cli,
    _args: &InstallArgs,
    _async_tx: &mpsc::UnboundedSender<AsyncMsg>,
) -> Result<()> {
    match app.phase {
        Phase::Preflight => {
            if key.code == KeyCode::Char('q') {
                app.should_quit = true;
            }
        }

        Phase::EnvVarChoice => handle_env_var_choice_key(app, key),
        Phase::Secrets => handle_secrets_key(app, key),
        Phase::Providers => handle_providers_key(app, key),
        Phase::Features => handle_features_key(app, key),
        Phase::Confirm => handle_confirm_key(app, key),

        Phase::Pull => {
            if key.code == KeyCode::Char('q') {
                app.should_quit = true;
            }
        }

        Phase::Deploy => {
            if key.code == KeyCode::Char('q') {
                app.should_quit = true;
            }
        }

        Phase::Health => {
            if key.code == KeyCode::Char('q') {
                app.should_quit = true;
            }
        }

        Phase::Complete => {
            match key.code {
                KeyCode::Char('q') => app.should_quit = true,
                KeyCode::Char('o') => {
                    let _ = open::that("http://localhost:30080");
                }
                _ => {}
            }
        }
    }

    Ok(())
}

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
            if let Ok(val) = std::env::var("VOYAGE_API_KEY") {
                if !val.is_empty() { app.config.voyage_api_key = Some(val); }
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

fn handle_secrets_key(app: &mut App, key: event::KeyEvent) {
    if app.current_secret_index >= app.secret_prompts.len() {
        return;
    }

    match key.code {
        KeyCode::Char(c) => {
            app.secret_input.push(c);
        }
        KeyCode::Backspace => {
            app.secret_input.pop();
        }
        KeyCode::Enter => {
            submit_current_secret(app);
        }
        KeyCode::Esc => {
            let prompt = &app.secret_prompts[app.current_secret_index];
            if !prompt.required {
                app.secret_prompts[app.current_secret_index].value = None;
                app.current_secret_index += 1;
                app.secret_input.clear();
            }
        }
        _ => {}
    }
}

fn submit_current_secret(app: &mut App) {
    let idx = app.current_secret_index;
    if idx >= app.secret_prompts.len() {
        return;
    }

    let input = app.secret_input.clone();
    let prompt = &app.secret_prompts[idx];

    if prompt.required && input.is_empty() {
        return;
    }

    let value = if input.is_empty() { None } else { Some(input) };
    app.secret_prompts[idx].value = value.clone();

    match app.secret_prompts[idx].key.as_str() {
        "AGENT_NAME" => {
            if let Some(ref v) = value {
                if !v.is_empty() {
                    app.config.agent_name = v.clone();
                }
            }
        }
        other => {
            for feature in &mut app.config.features {
                if let Some(entry) = feature.secrets.iter_mut().find(|(k, _)| k == other) {
                    entry.1 = value;
                    break;
                }
            }
        }
    }

    app.current_secret_index += 1;
    app.secret_input.clear();
}

fn handle_providers_key(app: &mut App, key: event::KeyEvent) {
    match app.provider_step {
        ProviderStep::BrainProvider => handle_provider_select(app, key, true),
        ProviderStep::BrainModel => handle_model_select(app, key, true),
        ProviderStep::BrainCredential => handle_credential_input(app, key, true),
        ProviderStep::WorkerChoice => handle_worker_choice(app, key),
        ProviderStep::WorkerProvider => handle_provider_select(app, key, false),
        ProviderStep::WorkerModel => handle_model_select(app, key, false),
        ProviderStep::WorkerCredential => handle_credential_input(app, key, false),
        ProviderStep::Done => {
            if key.code == KeyCode::Enter {
                // Auto-enable features whose required secrets are all provided
                for feature in &mut app.config.features {
                    if !feature.secrets.is_empty() {
                        let all_present = feature.secrets.iter().all(|(_, v)| v.is_some());
                        if all_present {
                            feature.enabled = true;
                        }
                    }
                }
                app.advance();
            }
        }
    }
}

fn handle_provider_select(app: &mut App, key: event::KeyEvent, is_brain: bool) {
    match key.code {
        KeyCode::Up => {
            if app.provider_cursor > 0 {
                app.provider_cursor -= 1;
            }
        }
        KeyCode::Down => {
            if app.provider_cursor < 2 {
                app.provider_cursor += 1;
            }
        }
        KeyCode::Enter => {
            let provider = match app.provider_cursor {
                0 => ProviderType::Anthropic,
                1 => ProviderType::OpenAI,
                _ => ProviderType::Ollama,
            };
            if is_brain {
                app.brain_provider = Some(provider);
            } else {
                app.worker_provider = Some(provider);
            }
            app.provider_cursor = 0;
            app.provider_input.clear();
            app.provider_step = if is_brain {
                ProviderStep::BrainModel
            } else {
                ProviderStep::WorkerModel
            };
        }
        _ => {}
    }
}

fn handle_model_select(app: &mut App, key: event::KeyEvent, is_brain: bool) {
    let provider = if is_brain {
        app.brain_provider.unwrap_or(ProviderType::Anthropic)
    } else {
        app.worker_provider.unwrap_or(ProviderType::Anthropic)
    };

    let models = models_for_provider(provider);

    if models.is_empty() {
        match key.code {
            KeyCode::Char(c) => app.provider_input.push(c),
            KeyCode::Backspace => { app.provider_input.pop(); }
            KeyCode::Enter => {
                if app.provider_input.is_empty() {
                    return;
                }
                let model_id = app.provider_input.clone();
                if is_brain {
                    app.brain_model_display = Some(model_id.clone());
                    app.brain_model_id = Some(model_id);
                } else {
                    app.worker_model_display = Some(model_id.clone());
                    app.worker_model_id = Some(model_id);
                }
                app.provider_input.clear();
                app.provider_cursor = 0;
                app.provider_step = if is_brain {
                    ProviderStep::BrainCredential
                } else {
                    ProviderStep::WorkerCredential
                };
            }
            KeyCode::Esc => {
                app.provider_input.clear();
                app.provider_cursor = 0;
                app.provider_step = if is_brain {
                    ProviderStep::BrainProvider
                } else {
                    ProviderStep::WorkerProvider
                };
            }
            _ => {}
        }
    } else {
        match key.code {
            KeyCode::Up => {
                if app.provider_cursor > 0 {
                    app.provider_cursor -= 1;
                }
            }
            KeyCode::Down => {
                if app.provider_cursor < models.len().saturating_sub(1) {
                    app.provider_cursor += 1;
                }
            }
            KeyCode::Enter => {
                let (model_id, display, _desc) = models[app.provider_cursor];
                if is_brain {
                    app.brain_model_id = Some(model_id.to_string());
                    app.brain_model_display = Some(display.to_string());
                } else {
                    app.worker_model_id = Some(model_id.to_string());
                    app.worker_model_display = Some(display.to_string());
                }
                app.provider_cursor = 0;
                app.provider_input.clear();
                app.provider_step = if is_brain {
                    ProviderStep::BrainCredential
                } else {
                    ProviderStep::WorkerCredential
                };
            }
            KeyCode::Esc => {
                app.provider_cursor = 0;
                app.provider_step = if is_brain {
                    ProviderStep::BrainProvider
                } else {
                    ProviderStep::WorkerProvider
                };
            }
            _ => {}
        }
    }
}

fn handle_credential_input(app: &mut App, key: event::KeyEvent, is_brain: bool) {
    let provider = if is_brain {
        app.brain_provider.unwrap_or(ProviderType::Anthropic)
    } else {
        app.worker_provider.unwrap_or(ProviderType::Anthropic)
    };

    let already_has_credential = match provider {
        ProviderType::Anthropic => app.config.anthropic_api_key.is_some(),
        ProviderType::OpenAI => app.config.openai_api_key.is_some(),
        ProviderType::Ollama => app.config.ollama_endpoints.is_some(),
    };

    if !is_brain && already_has_credential {
        store_model_config(app, is_brain);
        app.provider_step = ProviderStep::Done;
        app.provider_input.clear();
        return;
    }

    match key.code {
        KeyCode::Char(c) => app.provider_input.push(c),
        KeyCode::Backspace => { app.provider_input.pop(); }
        KeyCode::Enter => {
            if app.provider_input.is_empty() {
                return;
            }
            match provider {
                ProviderType::Anthropic => {
                    app.config.anthropic_api_key = Some(app.provider_input.clone());
                }
                ProviderType::OpenAI => {
                    app.config.openai_api_key = Some(app.provider_input.clone());
                }
                ProviderType::Ollama => {
                    app.config.ollama_endpoints = Some(app.provider_input.clone());
                }
            }
            app.provider_input.clear();
            store_model_config(app, is_brain);
            app.provider_cursor = 0;
            app.provider_step = if is_brain {
                ProviderStep::WorkerChoice
            } else {
                ProviderStep::Done
            };
        }
        KeyCode::Esc => {
            app.provider_input.clear();
            app.provider_cursor = 0;
            app.provider_step = if is_brain {
                ProviderStep::BrainModel
            } else {
                ProviderStep::WorkerModel
            };
        }
        _ => {}
    }
}

fn store_model_config(app: &mut App, is_brain: bool) {
    if is_brain {
        app.config.default_model = app.brain_model_id.clone();
    }
}

fn handle_worker_choice(app: &mut App, key: event::KeyEvent) {
    match key.code {
        KeyCode::Up => {
            if app.provider_cursor > 0 {
                app.provider_cursor -= 1;
            }
        }
        KeyCode::Down => {
            if app.provider_cursor < 1 {
                app.provider_cursor += 1;
            }
        }
        KeyCode::Enter => {
            if app.provider_cursor == 0 {
                app.worker_same_as_brain = true;
                app.worker_provider = app.brain_provider;
                app.worker_model_id = app.brain_model_id.clone();
                app.worker_model_display = app.brain_model_display.clone();
                app.provider_cursor = 0;
                app.provider_step = ProviderStep::Done;
            } else {
                app.worker_same_as_brain = false;
                app.provider_cursor = 0;
                app.provider_step = ProviderStep::WorkerProvider;
            }
        }
        _ => {}
    }
}

fn handle_features_key(app: &mut App, key: event::KeyEvent) {
    match key.code {
        KeyCode::Up => {
            if app.feature_cursor > 0 {
                app.feature_cursor -= 1;
            }
        }
        KeyCode::Down => {
            if !app.config.features.is_empty()
                && app.feature_cursor < app.config.features.len() - 1
            {
                app.feature_cursor += 1;
            }
        }
        KeyCode::Char(' ') => {
            if let Some(f) = app.config.features.get_mut(app.feature_cursor) {
                f.enabled = !f.enabled;
            }
        }
        KeyCode::Enter => {
            app.config.auth_token = generate_auth_token();

            app.secret_prompts.retain(|p| !p.is_feature);
            let base_count = app.secret_prompts.len();

            let mut feature_prompts = Vec::new();
            for feature in &app.config.features {
                if feature.enabled {
                    for (key, existing_val) in &feature.secrets {
                        feature_prompts.push(SecretPrompt {
                            key: key.clone(),
                            description: format!("{} — {}", feature.name, key),
                            required: false,
                            is_secret: key.contains("TOKEN") || key.contains("KEY"),
                            is_feature: true,
                            value: existing_val.clone(),
                        });
                    }
                }
            }

            if feature_prompts.is_empty() {
                app.advance();
            } else {
                app.secret_prompts.extend(feature_prompts);
                app.current_secret_index = base_count;
                app.collecting_feature_secrets = true;
                app.phase = Phase::Secrets;
            }
        }
        KeyCode::Char('q') => {
            app.should_quit = true;
        }
        _ => {}
    }
}

fn handle_confirm_key(app: &mut App, key: event::KeyEvent) {
    match key.code {
        KeyCode::Left => {
            app.confirm_selected = 0;
        }
        KeyCode::Right => {
            app.confirm_selected = 1;
        }
        KeyCode::Enter => {
            if app.confirm_selected == 0 {
                app.advance();
            } else {
                app.back_to_providers();
            }
        }
        KeyCode::Char('q') => {
            app.should_quit = true;
        }
        _ => {}
    }
}

// ============================================================
//  Async message handling
// ============================================================

fn handle_async_msg(app: &mut App, msg: AsyncMsg) {
    match msg {
        AsyncMsg::Pull(event) => handle_pull_event(app, event),
        AsyncMsg::Health(event) => handle_health_event(app, event),
        AsyncMsg::DeployStep {
            index,
            result,
        } => {
            if let Some(entry) = app.deploy_statuses.get_mut(index) {
                match result {
                    Ok(()) => {
                        entry.1 = ItemStatus::Done;
                        app.deploy_progress.0 += 1;
                    }
                    Err(e) => {
                        entry.1 = ItemStatus::Failed(e);
                        app.deploy_progress.0 += 1;
                    }
                }
            }
        }
        AsyncMsg::DeployDone => {
            app.advance();
        }
    }
}

fn handle_pull_event(app: &mut App, event: PullEvent) {
    match event {
        PullEvent::Started { index, image: _ } => {
            if let Some(entry) = app.pull_statuses.get_mut(index) {
                entry.1 = ItemStatus::InProgress;
            }
        }
        PullEvent::Completed {
            index,
            image: _,
            elapsed: _,
        } => {
            if let Some(entry) = app.pull_statuses.get_mut(index) {
                entry.1 = ItemStatus::Done;
            }
            app.pull_progress.0 += 1;
        }
        PullEvent::Failed {
            index,
            image: _,
            error,
            attempt: _,
        } => {
            if let Some(entry) = app.pull_statuses.get_mut(index) {
                entry.1 = ItemStatus::Failed(error);
            }
            app.pull_progress.0 += 1;
        }
        PullEvent::Retrying {
            index,
            image: _,
            attempt,
        } => {
            if let Some(entry) = app.pull_statuses.get_mut(index) {
                entry.1 = ItemStatus::InProgress;
                entry.0 = format!("{} (retry {})", entry.0.split(" (retry").next().unwrap_or(&entry.0), attempt);
            }
        }
    }
}

fn handle_health_event(app: &mut App, event: HealthEvent) {
    match event {
        HealthEvent::PodUpdate(pod) => {
            if let Some(existing) = app.pod_statuses.iter_mut().find(|p| p.name == pod.name) {
                *existing = pod;
            } else {
                app.pod_statuses.push(pod);
            }
        }
        HealthEvent::RecoveryAttempt {
            deployment: _,
            attempt: _,
        } => {}
        HealthEvent::AllHealthy => {
            app.health_done = true;
            app.health_failed = false;
        }
        HealthEvent::Failed { unhealthy } => {
            for pod in unhealthy {
                if let Some(existing) = app.pod_statuses.iter_mut().find(|p| p.name == pod.name) {
                    *existing = pod;
                } else {
                    app.pod_statuses.push(pod);
                }
            }
            app.health_done = true;
            app.health_failed = true;
        }
    }
}

// ============================================================
//  Auto-advance and async phase work
// ============================================================

async fn handle_auto_advance(
    app: &mut App,
    cli: &Cli,
    args: &InstallArgs,
    async_tx: &mpsc::UnboundedSender<AsyncMsg>,
) -> Result<()> {
    match app.phase {
        Phase::Providers => {
            // When using env vars, auto-configure providers from pre-populated credentials
            if app.use_env_vars == Some(true) && app.provider_step == ProviderStep::BrainProvider {
                if app.config.anthropic_api_key.is_some() {
                    app.brain_provider = Some(ProviderType::Anthropic);
                    app.brain_model_id = Some("claude-sonnet-4-20250514".to_string());
                    app.brain_model_display = Some("Sonnet 4".to_string());
                } else if app.config.openai_api_key.is_some() {
                    app.brain_provider = Some(ProviderType::OpenAI);
                    app.brain_model_id = Some("gpt-4o".to_string());
                    app.brain_model_display = Some("GPT-4o".to_string());
                } else if app.config.ollama_endpoints.is_some() {
                    app.brain_provider = Some(ProviderType::Ollama);
                    app.brain_model_id = Some("llama3".to_string());
                    app.brain_model_display = Some("llama3".to_string());
                }

                if app.brain_provider.is_some() {
                    app.worker_same_as_brain = true;
                    app.worker_provider = app.brain_provider;
                    app.worker_model_id = app.brain_model_id.clone();
                    app.worker_model_display = app.brain_model_display.clone();
                    app.config.default_model = app.brain_model_id.clone();
                    app.provider_step = ProviderStep::Done;
                    // Auto-enable features that have ANY secret pre-populated
                    for feature in &mut app.config.features {
                        if !feature.secrets.is_empty() {
                            let any_present = feature.secrets.iter().any(|(_, v)| v.is_some());
                            if any_present {
                                feature.enabled = true;
                            }
                        }
                    }
                    // Advance to Features — user reviews which are enabled
                    app.advance();
                }
            }
        }

        Phase::Secrets => {
            // Skip secrets that were pre-populated from env vars
            if app.use_env_vars == Some(true) {
                while app.current_secret_index < app.secret_prompts.len()
                    && app.secret_prompts[app.current_secret_index].value.is_some()
                {
                    app.current_secret_index += 1;
                }
            }
            if app.current_secret_index >= app.secret_prompts.len() {
                if app.collecting_feature_secrets {
                    app.collecting_feature_secrets = false;
                    app.phase = Phase::Confirm;
                } else {
                    app.advance();
                }
            }
        }

        Phase::Pull => {
            if app.pull_statuses.is_empty() {
                start_pull_phase(app, cli, args, async_tx);
            }
            let (done, total) = app.pull_progress;
            if total > 0 && done >= total {
                app.advance();
            }
        }

        Phase::Deploy => {
            if app.deploy_statuses.is_empty() {
                start_deploy_phase(app, cli, args, async_tx).await;
            }
        }

        Phase::Health => {
            if app.pod_statuses.is_empty() && !app.health_done {
                start_health_phase(app, async_tx);
            }
            if app.health_done && !app.health_failed {
                app.advance();
            }
        }

        _ => {}
    }

    Ok(())
}

fn start_pull_phase(
    app: &mut App,
    _cli: &Cli,
    args: &InstallArgs,
    async_tx: &mpsc::UnboundedSender<AsyncMsg>,
) {
    let manifest = match &app.manifest {
        Some(m) => m.clone(),
        None => return,
    };

    let mut image_list: Vec<String> = Vec::new();
    for img in &manifest.images {
        if !img.required && args.skip_extensions {
            continue;
        }
        image_list.push(img.image.clone());
    }

    app.pull_statuses = image_list
        .iter()
        .map(|img| (img.clone(), ItemStatus::Pending))
        .collect();
    app.pull_progress = (0, image_list.len());

    if image_list.is_empty() {
        app.pull_progress = (0, 0);
        return;
    }

    let tx = async_tx.clone();
    let (pull_tx, mut pull_rx) = mpsc::unbounded_channel();

    tokio::spawn(async move {
        let _results = images::pull_all(image_list, pull_tx).await;
    });

    tokio::spawn(async move {
        while let Some(event) = pull_rx.recv().await {
            if tx.send(AsyncMsg::Pull(event)).is_err() {
                break;
            }
        }
    });
}

async fn start_deploy_phase(
    app: &mut App,
    _cli: &Cli,
    args: &InstallArgs,
    async_tx: &mpsc::UnboundedSender<AsyncMsg>,
) {
    let manifest = match &app.manifest {
        Some(m) => m.clone(),
        None => return,
    };

    let mut steps: Vec<(&str, String)> = Vec::new();

    steps.push(("Namespace", "Create namespace".into()));
    steps.push(("Secrets", "Create Kubernetes secrets".into()));
    steps.push(("ConfigMap", "Create OS ConfigMap".into()));
    steps.push(("PVCs", "Persistent volume claims".into()));
    steps.push(("RBAC", "RBAC roles and bindings".into()));
    steps.push(("NATS", "NATS messaging".into()));
    steps.push(("Qdrant", "Qdrant vector DB".into()));
    steps.push(("Brain", "Brain service".into()));
    steps.push(("Worker", "Worker service".into()));
    steps.push(("Gateway", "Gateway service".into()));
    steps.push(("UI", "UI service".into()));
    steps.push(("Network Policies", "Network policies".into()));

    if !args.skip_extensions {
        for img in &manifest.images {
            if !img.required {
                match img.component.as_str() {
                    "voice" => steps.push(("Voice", "Voice service".into())),
                    "sysadmin" => steps.push(("SysAdmin", "SysAdmin service".into())),
                    "ext-toolbox" => steps.push(("Toolbox", "Extension: Toolbox".into())),
                    "ext-browser" => steps.push(("Browser", "Extension: Browser".into())),
                    _ => {}
                }
            }
        }
    }

    app.deploy_statuses = steps
        .iter()
        .map(|(label, _)| (label.to_string(), ItemStatus::Pending))
        .collect();
    app.deploy_progress = (0, steps.len());

    let tx = async_tx.clone();
    let namespace = app.config.namespace.clone();
    let config = app.config.clone();
    let skip_extensions = args.skip_extensions;
    let manifest_clone = manifest;

    tokio::spawn(async move {
        run_deploy_sequence(tx, namespace, config, skip_extensions, manifest_clone).await;
    });
}

async fn run_deploy_sequence(
    tx: mpsc::UnboundedSender<AsyncMsg>,
    namespace: String,
    config: InstallConfig,
    skip_extensions: bool,
    manifest: ReleaseManifest,
) {
    let mut step_index: usize = 0;

    macro_rules! report_step {
        ($label:expr, $result:expr) => {
            let _label = $label;
            let result = match $result {
                Ok(()) => Ok(()),
                Err(e) => Err(format!("{}", e)),
            };
            tx.send(AsyncMsg::DeployStep {
                index: step_index,
                result,
            })
            .ok();
            step_index += 1;
        };
    }

    let client = match kube::Client::try_default().await {
        Ok(c) => c,
        Err(e) => {
            report_step!("Namespace", Err::<(), _>(anyhow::anyhow!("{}", e)));
            tx.send(AsyncMsg::DeployDone).ok();
            return;
        }
    };

    // Step 1: Namespace
    let r = k8s::create_namespace(&client, &namespace).await;
    report_step!("Namespace", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Step 2: Secrets
    let r = create_all_secrets(&client, &namespace, &config, &manifest).await;
    report_step!("Secrets", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Step 3: OS ConfigMap
    let r = k8s::create_os_configmap(&client, &namespace).await;
    report_step!("ConfigMap", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Build template vars
    let vars = build_template_vars(&namespace, &manifest, &config);

    // Step 4: PVCs
    let yaml = render_template(templates::PVCS_YAML, &vars);
    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
    report_step!("PVCs", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Step 5: RBAC
    let yaml = render_template(templates::RBAC_YAML, &vars);
    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
    report_step!("RBAC", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Step 6: NATS
    let yaml = render_template(templates::NATS_YAML, &vars);
    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
    report_step!("NATS", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Step 7: Qdrant
    let yaml = render_template(templates::QDRANT_YAML, &vars);
    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
    report_step!("Qdrant", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Clean up orphaned "brain" deployment from pre-blue/green installs
    let _ = k8s::delete_deployment(&client, &namespace, "brain").await;

    // Step 8: Brain (blue/green)
    let yaml = render_template(templates::BRAIN_YAML, &vars);
    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
    report_step!("Brain", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Step 9: Worker
    let yaml = render_template(templates::WORKER_YAML, &vars);
    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
    report_step!("Worker", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Step 10: Gateway
    let yaml = render_template(templates::GATEWAY_YAML, &vars);
    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
    report_step!("Gateway", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Step 11: UI
    let yaml = render_template(templates::UI_YAML, &vars);
    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
    report_step!("UI", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Step 12: Network Policies
    let yaml = render_template(templates::NETWORK_POLICIES_YAML, &vars);
    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
    report_step!("Network Policies", r.map_err(|e| anyhow::anyhow!("{}", e)));

    // Step 13: Restart active deployments to pick up new images/config
    for dep in &["brain-blue", "worker", "gateway", "ui"] {
        let _ = k8s::restart_deployment(&client, &namespace, dep).await;
    }

    // Optional extensions
    if !skip_extensions {
        for img in &manifest.images {
            if img.required {
                continue;
            }
            match img.component.as_str() {
                "voice" => {
                    let yaml = render_template(templates::VOICE_YAML, &vars);
                    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
                    report_step!("Voice", r.map_err(|e| anyhow::anyhow!("{}", e)));
                }
                "sysadmin" => {
                    let yaml = render_template(templates::SYSADMIN_YAML, &vars);
                    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
                    report_step!("SysAdmin", r.map_err(|e| anyhow::anyhow!("{}", e)));
                }
                "ext-toolbox" => {
                    let yaml = render_template(templates::TOOLBOX_YAML, &vars);
                    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
                    report_step!("Toolbox", r.map_err(|e| anyhow::anyhow!("{}", e)));
                }
                "ext-browser" => {
                    let yaml = render_template(templates::BROWSER_YAML, &vars);
                    let r = k8s::apply_yaml(&client, &namespace, &yaml).await.map(|_| ());
                    report_step!("Browser", r.map_err(|e| anyhow::anyhow!("{}", e)));
                }
                _ => {}
            }
        }
    }

    // Write deploy metadata
    let features: Vec<String> = config.features.iter()
        .filter(|f| f.enabled)
        .map(|f| f.id.clone())
        .collect();
    let components = vec![
        "brain".into(), "worker".into(), "gateway".into(),
        "ui".into(), "nats".into(), "qdrant".into(),
    ];
    let deploy_meta = meta::build_meta(&manifest.version, "blue", &features, &components);
    let _ = meta::write_meta(&client, &namespace, &deploy_meta).await;

    tx.send(AsyncMsg::DeployDone).ok();
}

pub(crate) async fn create_all_secrets(
    client: &kube::Client,
    namespace: &str,
    config: &InstallConfig,
    _manifest: &ReleaseManifest,
) -> Result<()> {
    // Brain secrets
    let mut brain_data = BTreeMap::new();
    if let Some(ref key) = config.anthropic_api_key {
        brain_data.insert("ANTHROPIC_API_KEY".into(), key.clone());
    }
    if let Some(ref model) = config.default_model {
        brain_data.insert("DEFAULT_MODEL".into(), model.clone());
    }
    if let Some(ref key) = config.voyage_api_key {
        brain_data.insert("VOYAGE_API_KEY".into(), key.clone());
    }
    brain_data.insert("AUTH_TOKEN".into(), config.auth_token.clone());
    brain_data.insert("AGENT_NAME".into(), config.agent_name.clone());
    if let Some(ref key) = config.openai_api_key {
        brain_data.insert("OPENAI_API_KEY".into(), key.clone());
    }
    if let Some(ref endpoints) = config.ollama_endpoints {
        brain_data.insert("OLLAMA_ENDPOINTS".into(), endpoints.clone());
    }
    k8s::create_secret(client, namespace, "bakerst-brain-secrets", &brain_data).await?;

    // Worker secrets
    let mut worker_data = BTreeMap::new();
    if let Some(ref key) = config.anthropic_api_key {
        worker_data.insert("ANTHROPIC_API_KEY".into(), key.clone());
    }
    if let Some(ref model) = config.default_model {
        worker_data.insert("DEFAULT_MODEL".into(), model.clone());
    }
    worker_data.insert("AGENT_NAME".into(), config.agent_name.clone());
    if let Some(ref key) = config.openai_api_key {
        worker_data.insert("OPENAI_API_KEY".into(), key.clone());
    }
    if let Some(ref endpoints) = config.ollama_endpoints {
        worker_data.insert("OLLAMA_ENDPOINTS".into(), endpoints.clone());
    }
    k8s::create_secret(client, namespace, "bakerst-worker-secrets", &worker_data).await?;

    // Gateway secrets
    let mut gateway_data = BTreeMap::new();
    gateway_data.insert("AUTH_TOKEN".into(), config.auth_token.clone());
    for feature in &config.features {
        if !feature.enabled {
            continue;
        }
        for (key, value) in &feature.secrets {
            if let Some(ref v) = value {
                match key.as_str() {
                    "TELEGRAM_BOT_TOKEN" | "DISCORD_BOT_TOKEN" | "DISCORD_APP_ID" => {
                        gateway_data.insert(key.clone(), v.clone());
                    }
                    "GITHUB_TOKEN" => {
                        let mut gh_data = BTreeMap::new();
                        gh_data.insert("GITHUB_TOKEN".into(), v.clone());
                        k8s::create_secret(client, namespace, "bakerst-github-secrets", &gh_data)
                            .await?;
                    }
                    "PERPLEXITY_API_KEY" => {
                        let mut px_data = BTreeMap::new();
                        px_data.insert("PERPLEXITY_API_KEY".into(), v.clone());
                        k8s::create_secret(client, namespace, "bakerst-perplexity-secrets", &px_data)
                            .await?;
                    }
                    _ => {}
                }
            }
        }
    }
    k8s::create_secret(client, namespace, "bakerst-gateway-secrets", &gateway_data).await?;

    // Voice secrets
    let mut voice_data = BTreeMap::new();
    voice_data.insert("AUTH_TOKEN".into(), config.auth_token.clone());
    // STT_API_KEY, TTS_API_KEY, PICOVOICE_ACCESS_KEY are optional — populated from features
    for f in &config.features {
        if !f.enabled {
            continue;
        }
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

    Ok(())
}

pub(crate) fn build_template_vars(namespace: &str, manifest: &ReleaseManifest, config: &InstallConfig) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    vars.insert("NAMESPACE".into(), namespace.into());
    vars.insert("VERSION".into(), manifest.version.clone());
    vars.insert("AGENT_NAME".into(), config.agent_name.clone());

    let deploy_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    vars.insert("DEPLOY_VERSION".into(), format!("{}-{}", manifest.version, deploy_ts));
    vars.insert("DOOR_POLICY".into(), "open".into());
    vars.insert("WHISPER_URL".into(), "".into());
    vars.insert("TTS_PROVIDER".into(), "openai".into());
    vars.insert("TTS_BASE_URL".into(), "".into());
    vars.insert("TTS_MODEL".into(), "".into());
    vars.insert("TTS_VOICE".into(), "bf_emma".into());
    for img in &manifest.images {
        let key = match img.component.as_str() {
            "brain" => "IMAGE_BRAIN",
            "worker" => "IMAGE_WORKER",
            "ui" => "IMAGE_UI",
            "gateway" => "IMAGE_GATEWAY",
            "voice" => "IMAGE_VOICE",
            "sysadmin" => "IMAGE_SYSADMIN",
            "ext-toolbox" => "IMAGE_TOOLBOX",
            "ext-browser" => "IMAGE_BROWSER",
            _ => continue,
        };
        vars.insert(key.into(), img.image.clone());
    }

    // Build FEATURE_VARS block for brain from enabled features
    let mut feature_lines = Vec::new();
    for feature in &config.features {
        if feature.enabled {
            match feature.id.as_str() {
                "telegram" => feature_lines.push("            - name: FEATURE_TELEGRAM\n              value: \"true\"".to_string()),
                "discord" => feature_lines.push("            - name: FEATURE_DISCORD\n              value: \"true\"".to_string()),
                "voyage" => feature_lines.push("            - name: FEATURE_MEMORY\n              value: \"true\"".to_string()),
                "github" | "perplexity" | "browser" | "obsidian" => {}
                _ => {}
            }
        }
    }
    // Extensions always enabled — ext-toolbox is always deployed
    feature_lines.push("            - name: FEATURE_EXTENSIONS\n              value: \"true\"".to_string());
    feature_lines.push("            - name: FEATURE_SCHEDULER\n              value: \"true\"".to_string());
    feature_lines.push("            - name: FEATURE_MCP\n              value: \"true\"".to_string());

    vars.insert("FEATURE_VARS".into(), feature_lines.join("\n"));

    let mut gw_lines = Vec::new();
    for feature in &config.features {
        if feature.enabled {
            match feature.id.as_str() {
                "telegram" => gw_lines.push("            - name: FEATURE_TELEGRAM\n              value: \"true\"".to_string()),
                "discord" => gw_lines.push("            - name: FEATURE_DISCORD\n              value: \"true\"".to_string()),
                _ => {}
            }
        }
    }
    vars.insert("GATEWAY_FEATURE_VARS".into(), gw_lines.join("\n"));

    vars
}

fn start_health_phase(app: &mut App, async_tx: &mpsc::UnboundedSender<AsyncMsg>) {
    let namespace = app.config.namespace.clone();
    let tx = async_tx.clone();

    let mut deploy_names: Vec<String> = vec![
        "brain".into(),
        "worker".into(),
        "gateway".into(),
        "ui".into(),
        "nats".into(),
        "qdrant".into(),
    ];

    if let Some(ref m) = app.manifest {
        for img in &m.images {
            if !img.required {
                match img.component.as_str() {
                    "voice" | "sysadmin" => {
                        deploy_names.push(img.component.clone());
                    }
                    "ext-toolbox" => {
                        deploy_names.push("ext-toolbox".into());
                    }
                    "ext-browser" => {
                        deploy_names.push("ext-browser".into());
                    }
                    _ => {}
                }
            }
        }
    }

    app.pod_statuses.push(health::PodHealth {
        name: "(initializing)".into(),
        deployment: "".into(),
        ready: false,
        phase: "Pending".into(),
        image: "".into(),
        restarts: 0,
        error: None,
        logs_tail: None,
    });

    let (health_tx, mut health_rx) = mpsc::unbounded_channel();

    tokio::spawn(async move {
        let client = match kube::Client::try_default().await {
            Ok(c) => c,
            Err(_) => {
                health_tx
                    .send(HealthEvent::Failed {
                        unhealthy: vec![],
                    })
                    .ok();
                return;
            }
        };

        let deploy_refs: Vec<&str> = deploy_names.iter().map(|s| s.as_str()).collect();
        let _ = health::poll_health(&client, &namespace, &deploy_refs, health_tx).await;
    });

    tokio::spawn(async move {
        while let Some(event) = health_rx.recv().await {
            if tx.send(AsyncMsg::Health(event)).is_err() {
                break;
            }
        }
    });
}

// ============================================================
//  Non-interactive mode (-y / --non-interactive)
// ============================================================

async fn run_non_interactive(cli: &Cli, _args: &InstallArgs) -> Result<()> {
    println!("Baker Street Installer v{}", env!("CARGO_PKG_VERSION"));

    // [1/8] Preflight
    println!("[1/8] Preflight checks...");
    let k8s_version = k8s::check_cluster().await.unwrap_or_else(|e| {
        eprintln!("  ERROR: K8s cluster not reachable: {}", e);
        std::process::exit(1);
    });
    println!("  K8s cluster: v{}", k8s_version);

    let manifest = if let Some(ref path) = cli.manifest {
        crate::manifest::load_manifest_from_file(path)?
    } else {
        crate::manifest::embedded_manifest()?
    };
    println!(
        "  Manifest: v{} ({} images)",
        manifest.version,
        manifest.images.len()
    );

    // [2/8] Secrets from environment
    println!("[2/8] Secrets: loading from environment...");
    let api_key = std::env::var("ANTHROPIC_API_KEY").ok();
    let default_model = std::env::var("BAKERST_DEFAULT_MODEL")
        .or_else(|_| std::env::var("DEFAULT_MODEL"))
        .ok();
    let voyage_api_key = std::env::var("VOYAGE_API_KEY").ok();
    let openai_api_key = std::env::var("OPENAI_API_KEY").ok()
        .or_else(|| std::env::var("BAKERST_OPENAI_API_KEY").ok());
    let ollama_endpoints = std::env::var("OLLAMA_ENDPOINTS").ok()
        .or_else(|| std::env::var("BAKERST_OLLAMA_ENDPOINTS").ok());

    if api_key.is_none() && openai_api_key.is_none() && ollama_endpoints.is_none() {
        eprintln!("  ERROR: At least one provider must be configured.");
        eprintln!("  Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, OLLAMA_ENDPOINTS");
        std::process::exit(1);
    }

    let agent_name = std::env::var("AGENT_NAME").unwrap_or_else(|_| "Baker".into());
    let auth_token =
        std::env::var("AUTH_TOKEN").unwrap_or_else(|_| templates::generate_auth_token());
    println!("  Loaded secrets from env");

    // [3/8] Features from environment
    println!("[3/8] Features: from environment...");
    let mut feature_selections = Vec::new();
    for feature in &manifest.optional_features {
        let has_secrets = feature.secrets.iter().all(|s| std::env::var(s).is_ok());
        feature_selections.push(FeatureSelection {
            id: feature.id.clone(),
            name: feature.name.clone(),
            enabled: has_secrets,
            secrets: feature.secrets.iter().map(|s| (s.clone(), std::env::var(s).ok())).collect(),
        });
        if has_secrets {
            println!("  Enabled: {}", feature.name);
        }
    }
    if feature_selections.iter().all(|f| !f.enabled) {
        println!("  No optional features enabled");
    }

    // [4/8] Confirm
    println!("[4/8] Deploying Baker Street v{}...", manifest.version);

    // [5/8] Pull images
    println!("[5/8] Pulling {} images...", manifest.images.len());
    let image_names: Vec<String> = manifest.images.iter().map(|i| i.image.clone()).collect();
    let (tx, mut _rx) = tokio::sync::mpsc::unbounded_channel();
    let results = images::pull_all(image_names, tx).await;
    let failed: Vec<_> = results.iter().filter(|r| r.is_err()).collect();
    if !failed.is_empty() {
        println!("  WARNING: {} image(s) failed to pull", failed.len());
    }
    println!(
        "  Pulled {}/{} images",
        results.len() - failed.len(),
        results.len()
    );

    // [6/8] Deploy
    println!("[6/8] Deploying resources...");
    let client = kube::Client::try_default().await?;
    let ns = &cli.namespace;

    k8s::create_namespace(&client, ns).await?;
    println!("  Namespace: {}", ns);

    // Create secrets
    let mut brain_secrets = BTreeMap::new();
    if let Some(ref key) = api_key {
        brain_secrets.insert("ANTHROPIC_API_KEY".into(), key.clone());
    }
    if let Some(ref model) = default_model {
        brain_secrets.insert("DEFAULT_MODEL".into(), model.clone());
    }
    if let Some(ref key) = voyage_api_key {
        brain_secrets.insert("VOYAGE_API_KEY".into(), key.clone());
    }
    brain_secrets.insert("AUTH_TOKEN".into(), auth_token.clone());
    brain_secrets.insert("AGENT_NAME".into(), agent_name.clone());
    if let Some(ref key) = openai_api_key {
        brain_secrets.insert("OPENAI_API_KEY".into(), key.clone());
    }
    if let Some(ref endpoints) = ollama_endpoints {
        brain_secrets.insert("OLLAMA_ENDPOINTS".into(), endpoints.clone());
    }
    k8s::create_secret(&client, ns, "bakerst-brain-secrets", &brain_secrets).await?;

    let mut worker_secrets = BTreeMap::new();
    if let Some(ref key) = api_key {
        worker_secrets.insert("ANTHROPIC_API_KEY".into(), key.clone());
    }
    if let Some(ref model) = default_model {
        worker_secrets.insert("DEFAULT_MODEL".into(), model.clone());
    }
    worker_secrets.insert("AGENT_NAME".into(), agent_name.clone());
    if let Some(ref key) = openai_api_key {
        worker_secrets.insert("OPENAI_API_KEY".into(), key.clone());
    }
    if let Some(ref endpoints) = ollama_endpoints {
        worker_secrets.insert("OLLAMA_ENDPOINTS".into(), endpoints.clone());
    }
    k8s::create_secret(&client, ns, "bakerst-worker-secrets", &worker_secrets).await?;

    let mut gateway_secrets = BTreeMap::new();
    gateway_secrets.insert("AUTH_TOKEN".into(), auth_token.clone());
    for feature in &manifest.optional_features {
        for secret_key in &feature.secrets {
            if let Ok(val) = std::env::var(secret_key) {
                match secret_key.as_str() {
                    "TELEGRAM_BOT_TOKEN" | "DISCORD_BOT_TOKEN" | "DISCORD_APP_ID" => {
                        gateway_secrets.insert(secret_key.clone(), val);
                    }
                    "GITHUB_TOKEN" => {
                        let mut gh_data = BTreeMap::new();
                        gh_data.insert("GITHUB_TOKEN".into(), val);
                        k8s::create_secret(&client, ns, "bakerst-github-secrets", &gh_data).await?;
                    }
                    _ => {}
                }
            }
        }
    }
    k8s::create_secret(&client, ns, "bakerst-gateway-secrets", &gateway_secrets).await?;

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

    println!("  Secrets created");

    k8s::create_os_configmap(&client, ns).await?;
    println!("  ConfigMap: bakerst-os");

    // Build template vars using shared function
    let ni_config = InstallConfig {
        anthropic_api_key: api_key.clone(),
        default_model: default_model.clone(),
        openai_api_key: openai_api_key.clone(),
        ollama_endpoints: ollama_endpoints.clone(),
        voyage_api_key: voyage_api_key.clone(),
        agent_name: agent_name.clone(),
        auth_token: auth_token.clone(),
        features: feature_selections,
        namespace: ns.to_string(),
    };
    let vars = build_template_vars(ns, &manifest, &ni_config);

    let deploy_steps = vec![
        ("PVCs", templates::PVCS_YAML),
        ("RBAC", templates::RBAC_YAML),
        ("NATS", templates::NATS_YAML),
        ("Qdrant", templates::QDRANT_YAML),
        ("Brain", templates::BRAIN_YAML),
        ("Worker", templates::WORKER_YAML),
        ("Gateway", templates::GATEWAY_YAML),
        ("UI", templates::UI_YAML),
        ("Network Policies", templates::NETWORK_POLICIES_YAML),
    ];

    // Clean up orphaned "brain" deployment from pre-blue/green installs
    let _ = k8s::delete_deployment(&client, ns, "brain").await;

    for (name, template) in &deploy_steps {
        let rendered = render_template(template, &vars);
        k8s::apply_yaml(&client, ns, &rendered).await?;
        println!("  Deployed: {}", name);
    }

    // Restart active deployments to pick up new images/config
    for dep in &["brain-blue", "worker", "gateway", "ui"] {
        k8s::restart_deployment(&client, ns, dep).await?;
        println!("  Restarted: {}", dep);
    }

    // [7/8] Health
    println!("[7/8] Health check...");
    let deployments = vec!["nats", "qdrant", "brain-blue", "worker", "gateway", "ui"];
    for dep in &deployments {
        match health::wait_for_rollout(&client, ns, dep, Duration::from_secs(180)).await {
            Ok(_) => println!("  {}: ready", dep),
            Err(e) => println!("  {}: FAILED ({})", dep, e),
        }
    }

    // Write deploy metadata
    let features: Vec<String> = ni_config.features.iter()
        .filter(|f| f.enabled)
        .map(|f| f.id.clone())
        .collect();
    let components = vec![
        "brain".into(), "worker".into(), "gateway".into(),
        "ui".into(), "nats".into(), "qdrant".into(),
    ];
    let deploy_meta = meta::build_meta(&manifest.version, "blue", &features, &components);
    if let Err(e) = meta::write_meta(&client, ns, &deploy_meta).await {
        println!("  WARNING: Failed to write deploy metadata: {}", e);
    }

    // [8/8] Complete
    println!("[8/8] Complete! UI: http://localhost:30080");
    println!("Auth Token: {}", auth_token);
    println!("  (save this token — you need it to log in)");
    println!("Agent Name: {}", agent_name);

    Ok(())
}

// ============================================================
//  Config-file mode (--config <PATH>)
// ============================================================

async fn run_config_install(cli: &Cli, args: &InstallArgs, config_path: &str) -> Result<()> {
    let config = config_file::load_config(config_path)?;

    if let Some(ref key) = config.credentials.anthropic_api_key {
        std::env::set_var("ANTHROPIC_API_KEY", key);
    }
    if let Some(ref model) = config.credentials.default_model {
        std::env::set_var("DEFAULT_MODEL", model);
    }
    if let Some(ref key) = config.credentials.voyage_api_key {
        std::env::set_var("VOYAGE_API_KEY", key);
    }
    if let Some(ref name) = config.credentials.agent_name {
        std::env::set_var("AGENT_NAME", name);
    }
    if let Some(ref token) = config.credentials.auth_token {
        std::env::set_var("AUTH_TOKEN", token);
    }
    if let Some(ref key) = config.credentials.openai_api_key {
        std::env::set_var("OPENAI_API_KEY", key);
    }
    if let Some(ref endpoints) = config.credentials.ollama_endpoints {
        std::env::set_var("OLLAMA_ENDPOINTS", endpoints);
    }

    for (_id, feature) in &config.features {
        if feature.enabled {
            for (key, val) in &feature.secrets {
                std::env::set_var(key, val);
            }
        }
    }

    // Delegate to non-interactive flow with -y semantics
    let ni_args = InstallArgs {
        non_interactive: true,
        config: None, // already processed
        data_dir: args.data_dir.clone(),
        skip_telemetry: args.skip_telemetry,
        skip_extensions: args.skip_extensions,
    };
    run_non_interactive(cli, &ni_args).await
}
