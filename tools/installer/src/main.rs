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
use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;
use tokio::sync::mpsc;

use app::{App, FeatureSelection, ItemStatus, Phase, SecretPrompt};
use health::HealthEvent;
use images::PullEvent;
use manifest::ReleaseManifest;
use templates::{generate_auth_token, render as render_template};
use tui::Tui;

/// Internal message type for async phase operations communicating back to the main loop
enum AsyncMsg {
    Pull(PullEvent),
    Health(HealthEvent),
    DeployStep { index: usize, result: Result<(), String> },
    DeployDone,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    if cli.status {
        return run_status(&cli).await;
    }
    if cli.uninstall {
        return run_uninstall(&cli).await;
    }

    if cli.non_interactive {
        return run_non_interactive(&cli).await;
    }

    // Interactive TUI mode
    let mut app = App::new(cli.namespace.clone());

    // Channel for async operations to communicate back
    let (async_tx, mut async_rx) = mpsc::unbounded_channel::<AsyncMsg>();

    let mut tui = Tui::new()?;

    // Run preflight immediately
    run_preflight(&mut app, &cli).await;

    loop {
        tui.draw(&app)?;

        // Poll for keyboard events with a short timeout (non-blocking)
        if event::poll(Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                // Global quit: Ctrl+C or 'q' (except during text input phases)
                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c')
                {
                    app.should_quit = true;
                }

                if !app.should_quit {
                    handle_key(&mut app, key, &cli, &async_tx).await?;
                }
            }
        }

        // Drain async messages (non-blocking)
        while let Ok(msg) = async_rx.try_recv() {
            handle_async_msg(&mut app, msg);
        }

        // Check for auto-advance conditions
        handle_auto_advance(&mut app, &cli, &async_tx).await?;

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

    match manifest_result {
        Ok(m) => {
            app.manifest_version = m.version.clone();
            app.preflight_checks[2] = (
                format!("Release manifest (v{})", m.version),
                ItemStatus::Done,
            );
            // Build secret prompts from manifest
            build_secret_prompts(app, &m);
            // Build feature selections from manifest
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

    // Auto-advance to Secrets phase
    app.advance();
}

fn build_secret_prompts(app: &mut App, manifest: &ReleaseManifest) {
    app.secret_prompts.clear();

    for secret in &manifest.required_secrets {
        app.secret_prompts.push(SecretPrompt {
            key: secret.key.clone(),
            description: secret.description.clone(),
            required: secret.required,
            is_secret: secret.input_type == "secret",
            is_feature: false,
            value: None,
        });
    }

    // Agent name uses default ("Baker") — no prompt needed
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
    _async_tx: &mpsc::UnboundedSender<AsyncMsg>,
) -> Result<()> {
    match app.phase {
        Phase::Preflight => {
            // Preflight auto-advances; 'q' to quit
            if key.code == KeyCode::Char('q') {
                app.should_quit = true;
            }
        }

        Phase::Secrets => handle_secrets_key(app, key),

        Phase::Features => handle_features_key(app, key),

        Phase::Confirm => handle_confirm_key(app, key),

        Phase::Pull => {
            // Pull auto-advances; 'q' to quit
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

fn handle_secrets_key(app: &mut App, key: event::KeyEvent) {
    if app.current_secret_index >= app.secret_prompts.len() {
        return; // All done, waiting for auto-advance
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
            // Skip optional secret
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

    // If required and empty, don't advance
    if prompt.required && input.is_empty() {
        return;
    }

    // Store the value
    let value = if input.is_empty() { None } else { Some(input) };
    app.secret_prompts[idx].value = value.clone();

    // Map secret values into config
    match app.secret_prompts[idx].key.as_str() {
        "ANTHROPIC_OAUTH_TOKEN" => app.config.oauth_token = value,
        "ANTHROPIC_API_KEY" => app.config.api_key = value,
        "VOYAGE_API_KEY" => app.config.voyage_api_key = value,
        "AGENT_NAME" => {
            if let Some(ref v) = value {
                if !v.is_empty() {
                    app.config.agent_name = v.clone();
                }
            }
        }
        other => {
            // Store into the matching feature's secrets
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
            // Generate auth token before confirm
            app.config.auth_token = generate_auth_token();

            // Remove any previously appended feature prompts (handles Cancel → retry)
            app.secret_prompts.retain(|p| !p.is_feature);
            let base_count = app.secret_prompts.len();

            // Collect secrets for enabled features
            let mut feature_prompts = Vec::new();
            for feature in &app.config.features {
                if feature.enabled {
                    for (key, _) in &feature.secrets {
                        feature_prompts.push(SecretPrompt {
                            key: key.clone(),
                            description: format!("{} — {}", feature.name, key),
                            required: false,
                            is_secret: key.contains("TOKEN") || key.contains("KEY"),
                            is_feature: true,
                            value: None,
                        });
                    }
                }
            }

            if feature_prompts.is_empty() {
                app.advance(); // straight to Confirm
            } else {
                // Append feature secret prompts and go back to Secrets phase
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
                // Confirm — advance to Pull
                app.advance();
            } else {
                // Cancel — back to Secrets
                app.back_to_secrets();
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
            // All deploy steps finished — advance to Health
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
            // Update or insert pod status
            if let Some(existing) = app.pod_statuses.iter_mut().find(|p| p.name == pod.name) {
                *existing = pod;
            } else {
                app.pod_statuses.push(pod);
            }
        }
        HealthEvent::RecoveryAttempt {
            deployment: _,
            attempt: _,
        } => {
            // Could show recovery info; for now just let pod updates handle it
        }
        HealthEvent::AllHealthy => {
            app.health_done = true;
            app.health_failed = false;
        }
        HealthEvent::Failed { unhealthy } => {
            // Update pod_statuses with the final unhealthy set
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

/// Tracks whether we've started async work for a given phase.
/// We use a simple approach: check app state to determine if work needs to start.
async fn handle_auto_advance(
    app: &mut App,
    cli: &Cli,
    async_tx: &mpsc::UnboundedSender<AsyncMsg>,
) -> Result<()> {
    match app.phase {
        Phase::Secrets => {
            // Auto-advance when all secrets are collected
            if app.current_secret_index >= app.secret_prompts.len() {
                if app.collecting_feature_secrets {
                    // Feature secrets done — skip Features, go straight to Confirm
                    app.collecting_feature_secrets = false;
                    app.phase = Phase::Confirm;
                } else {
                    app.advance(); // normal: Secrets → Features
                }
            }
        }

        Phase::Pull => {
            // Start pull if not already started
            if app.pull_statuses.is_empty() {
                start_pull_phase(app, cli, async_tx);
            }
            // Auto-advance when all pulls are done
            let (done, total) = app.pull_progress;
            if total > 0 && done >= total {
                app.advance();
            }
        }

        Phase::Deploy => {
            // Start deploy if not already started
            if app.deploy_statuses.is_empty() {
                start_deploy_phase(app, cli, async_tx).await;
            }
            // Auto-advance is triggered by DeployDone message
        }

        Phase::Health => {
            // Start health polling if not already started
            if app.pod_statuses.is_empty() && !app.health_done {
                start_health_phase(app, async_tx);
            }
            // Auto-advance when health is done and all healthy
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
    cli: &Cli,
    async_tx: &mpsc::UnboundedSender<AsyncMsg>,
) {
    let manifest = match &app.manifest {
        Some(m) => m.clone(),
        None => return,
    };

    // Build image list from manifest
    let mut images: Vec<String> = Vec::new();
    for img in &manifest.images {
        if !img.required && cli.skip_extensions {
            continue;
        }
        images.push(img.image.clone());
    }

    // Initialize pull statuses
    app.pull_statuses = images
        .iter()
        .map(|img| (img.clone(), ItemStatus::Pending))
        .collect();
    app.pull_progress = (0, images.len());

    if images.is_empty() {
        // Nothing to pull, auto-advance
        app.pull_progress = (0, 0);
        return;
    }

    let tx = async_tx.clone();
    let (pull_tx, mut pull_rx) = mpsc::unbounded_channel();

    // Spawn the pull_all task
    tokio::spawn(async move {
        let _results = images::pull_all(images, pull_tx).await;
    });

    // Spawn a relay task that forwards PullEvent -> AsyncMsg
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
    cli: &Cli,
    async_tx: &mpsc::UnboundedSender<AsyncMsg>,
) {
    let manifest = match &app.manifest {
        Some(m) => m.clone(),
        None => return,
    };

    // Build the list of deploy steps
    let mut steps: Vec<(&str, String)> = Vec::new(); // (label, description)

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

    if !cli.skip_extensions {
        // Check for optional services in manifest
        for img in &manifest.images {
            if !img.required {
                match img.component.as_str() {
                    "voice" => steps.push(("Voice", "Voice service".into())),
                    "sysadmin" => steps.push(("SysAdmin", "SysAdmin service".into())),
                    _ => {}
                }
            }
        }
    }

    // Initialize deploy statuses
    app.deploy_statuses = steps
        .iter()
        .map(|(label, _)| (label.to_string(), ItemStatus::Pending))
        .collect();
    app.deploy_progress = (0, steps.len());

    // We run deploy sequentially in a background task
    let tx = async_tx.clone();
    let namespace = app.config.namespace.clone();
    let config = app.config.clone();
    let skip_extensions = cli.skip_extensions;
    let manifest_clone = manifest;

    tokio::spawn(async move {
        run_deploy_sequence(tx, namespace, config, skip_extensions, manifest_clone).await;
    });
}

async fn run_deploy_sequence(
    tx: mpsc::UnboundedSender<AsyncMsg>,
    namespace: String,
    config: app::InstallConfig,
    skip_extensions: bool,
    manifest: ReleaseManifest,
) {
    let mut step_index: usize = 0;

    // Helper macro for reporting step results
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

    // Connect to K8s cluster
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

    // Step 8: Brain
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

    tx.send(AsyncMsg::DeployDone).ok();
}

async fn create_all_secrets(
    client: &kube::Client,
    namespace: &str,
    config: &app::InstallConfig,
    _manifest: &ReleaseManifest,
) -> Result<()> {
    // Brain secrets
    let mut brain_data = BTreeMap::new();
    if let Some(ref token) = config.oauth_token {
        brain_data.insert("ANTHROPIC_OAUTH_TOKEN".into(), token.clone());
    }
    if let Some(ref key) = config.api_key {
        brain_data.insert("ANTHROPIC_API_KEY".into(), key.clone());
    }
    if let Some(ref key) = config.voyage_api_key {
        brain_data.insert("VOYAGE_API_KEY".into(), key.clone());
    }
    brain_data.insert("AUTH_TOKEN".into(), config.auth_token.clone());
    brain_data.insert("AGENT_NAME".into(), config.agent_name.clone());
    k8s::create_secret(client, namespace, "bakerst-brain-secrets", &brain_data).await?;

    // Worker secrets
    let mut worker_data = BTreeMap::new();
    if let Some(ref token) = config.oauth_token {
        worker_data.insert("ANTHROPIC_OAUTH_TOKEN".into(), token.clone());
    }
    if let Some(ref key) = config.api_key {
        worker_data.insert("ANTHROPIC_API_KEY".into(), key.clone());
    }
    worker_data.insert("AGENT_NAME".into(), config.agent_name.clone());
    k8s::create_secret(client, namespace, "bakerst-worker-secrets", &worker_data).await?;

    // Gateway secrets
    let mut gateway_data = BTreeMap::new();
    gateway_data.insert("AUTH_TOKEN".into(), config.auth_token.clone());
    // Check for telegram/discord feature secrets
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
                        // GitHub gets its own secret
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

    Ok(())
}

fn build_template_vars(namespace: &str, manifest: &ReleaseManifest, config: &app::InstallConfig) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    vars.insert("NAMESPACE".into(), namespace.into());
    vars.insert("VERSION".into(), manifest.version.clone());
    vars.insert("AGENT_NAME".into(), config.agent_name.clone());
    vars.insert("DOOR_POLICY".into(), "open".into());
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
    let mut has_extension = false;
    for feature in &config.features {
        if feature.enabled {
            match feature.id.as_str() {
                "telegram" => feature_lines.push("            - name: FEATURE_TELEGRAM\n              value: \"true\"".to_string()),
                "discord" => feature_lines.push("            - name: FEATURE_DISCORD\n              value: \"true\"".to_string()),
                "voyage" => feature_lines.push("            - name: FEATURE_MEMORY\n              value: \"true\"".to_string()),
                "github" | "perplexity" | "browser" | "obsidian" => has_extension = true,
                _ => {}
            }
        }
    }
    if has_extension {
        feature_lines.push("            - name: FEATURE_EXTENSIONS\n              value: \"true\"".to_string());
    }
    // Always enable scheduler and MCP in prod
    feature_lines.push("            - name: FEATURE_SCHEDULER\n              value: \"true\"".to_string());
    feature_lines.push("            - name: FEATURE_MCP\n              value: \"true\"".to_string());

    vars.insert("FEATURE_VARS".into(), feature_lines.join("\n"));

    // Build GATEWAY_FEATURE_VARS for gateway (telegram, discord)
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

    // Determine which deployments to watch based on manifest
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

    // Use a sentinel in pod_statuses to indicate health polling has started
    // (we check is_empty in handle_auto_advance)
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

    // Relay health events to the main async channel
    tokio::spawn(async move {
        while let Some(event) = health_rx.recv().await {
            if tx.send(AsyncMsg::Health(event)).is_err() {
                break;
            }
        }
    });
}

// ============================================================
//  Non-interactive mode (--non-interactive)
// ============================================================

async fn run_non_interactive(cli: &Cli) -> Result<()> {
    println!("Baker Street Installer v{}", env!("CARGO_PKG_VERSION"));

    // [1/8] Preflight
    println!("[1/8] Preflight checks...");
    let k8s_version = k8s::check_cluster().await.unwrap_or_else(|e| {
        eprintln!("  ERROR: K8s cluster not reachable: {}", e);
        std::process::exit(1);
    });
    println!("  K8s cluster: v{}", k8s_version);

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
    println!(
        "  Manifest: v{} ({} images)",
        manifest.version,
        manifest.images.len()
    );

    // [2/8] Secrets from environment
    println!("[2/8] Secrets: loading from environment...");
    let oauth_token = std::env::var("ANTHROPIC_OAUTH_TOKEN").ok();
    let api_key = std::env::var("ANTHROPIC_API_KEY").ok();
    if oauth_token.is_none() && api_key.is_none() {
        eprintln!("  ERROR: ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY must be set");
        std::process::exit(1);
    }
    let voyage_api_key = std::env::var("VOYAGE_API_KEY").ok();
    let agent_name = std::env::var("AGENT_NAME").unwrap_or_else(|_| "Baker".into());
    let auth_token =
        std::env::var("AUTH_TOKEN").unwrap_or_else(|_| templates::generate_auth_token());
    println!(
        "  Loaded {} secrets from env",
        if oauth_token.is_some() { 2 } else { 1 } + 2
    );

    // [3/8] Features from environment
    println!("[3/8] Features: from environment...");
    let mut enabled_features = Vec::new();
    for feature in &manifest.optional_features {
        let has_secrets = feature.secrets.iter().all(|s| std::env::var(s).is_ok());
        if has_secrets {
            enabled_features.push(feature.name.clone());
            println!("  Enabled: {}", feature.name);
        }
    }
    if enabled_features.is_empty() {
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
    if let Some(ref token) = oauth_token {
        brain_secrets.insert("ANTHROPIC_OAUTH_TOKEN".into(), token.clone());
    }
    if let Some(ref key) = api_key {
        brain_secrets.insert("ANTHROPIC_API_KEY".into(), key.clone());
    }
    if let Some(ref key) = voyage_api_key {
        brain_secrets.insert("VOYAGE_API_KEY".into(), key.clone());
    }
    brain_secrets.insert("AUTH_TOKEN".into(), auth_token.clone());
    brain_secrets.insert("AGENT_NAME".into(), agent_name.clone());
    k8s::create_secret(&client, ns, "bakerst-brain-secrets", &brain_secrets).await?;

    let mut worker_secrets = BTreeMap::new();
    if let Some(ref token) = oauth_token {
        worker_secrets.insert("ANTHROPIC_OAUTH_TOKEN".into(), token.clone());
    }
    if let Some(ref key) = api_key {
        worker_secrets.insert("ANTHROPIC_API_KEY".into(), key.clone());
    }
    worker_secrets.insert("AGENT_NAME".into(), agent_name.clone());
    k8s::create_secret(&client, ns, "bakerst-worker-secrets", &worker_secrets).await?;

    let mut gateway_secrets = BTreeMap::new();
    gateway_secrets.insert("AUTH_TOKEN".into(), auth_token.clone());
    // Add feature secrets from environment
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
    println!("  Secrets created");

    k8s::create_os_configmap(&client, ns).await?;
    println!("  ConfigMap: bakerst-os");

    // Apply templates
    let mut vars = HashMap::new();
    vars.insert("NAMESPACE".into(), ns.clone());
    vars.insert("VERSION".into(), manifest.version.clone());
    vars.insert("AGENT_NAME".into(), agent_name.clone());
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

    for (name, template) in &deploy_steps {
        let rendered = render_template(template, &vars);
        k8s::apply_yaml(&client, ns, &rendered).await?;
        println!("  Deployed: {}", name);
    }

    // [7/8] Health
    println!("[7/8] Health check...");
    let deployments = vec!["nats", "qdrant", "brain", "worker", "gateway", "ui"];
    for dep in &deployments {
        match health::wait_for_rollout(&client, ns, dep, Duration::from_secs(180)).await {
            Ok(_) => println!("  {}: ready", dep),
            Err(e) => println!("  {}: FAILED ({})", dep, e),
        }
    }

    // [8/8] Complete
    println!("[8/8] Complete! UI: http://localhost:30080");
    println!("Auth Token: {}", auth_token);
    println!("  (save this token — you need it to log in)");
    println!("Agent Name: {}", agent_name);

    Ok(())
}

// ============================================================
//  Uninstall mode (--uninstall)
// ============================================================

async fn run_uninstall(cli: &Cli) -> Result<()> {
    println!(
        "Uninstalling Baker Street from namespace '{}'",
        cli.namespace
    );

    if !cli.non_interactive {
        print!("Are you sure? This will delete ALL resources. [y/N] ");
        std::io::Write::flush(&mut std::io::stdout())?;
        let mut input = String::new();
        std::io::stdin().read_line(&mut input)?;
        if !input.trim().eq_ignore_ascii_case("y") {
            println!("Cancelled.");
            return Ok(());
        }
    }

    let client = kube::Client::try_default().await?;

    println!("Deleting namespace '{}'...", cli.namespace);
    k8s::delete_namespace(&client, &cli.namespace).await?;

    println!("Deleting namespace 'bakerst-telemetry'...");
    k8s::delete_namespace(&client, "bakerst-telemetry").await?;

    println!("Uninstall complete.");
    Ok(())
}

// ============================================================
//  Status mode (--status)
// ============================================================

async fn run_status(cli: &Cli) -> Result<()> {
    let client = kube::Client::try_default().await?;
    let statuses = k8s::get_deployments_status(&client, &cli.namespace).await?;

    if cli.non_interactive {
        // JSON output
        let json: Vec<_> = statuses
            .iter()
            .map(|s| {
                serde_json::json!({
                    "name": s.name,
                    "desired": s.desired,
                    "ready": s.ready,
                    "image": s.image,
                })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&json)?);
    } else {
        println!("Baker Street Status (namespace: {})", cli.namespace);
        println!(
            "{:<20} {:>7} {:>7} {}",
            "DEPLOYMENT", "DESIRED", "READY", "IMAGE"
        );
        println!("{}", "-".repeat(80));
        for s in &statuses {
            let status_icon = if s.ready >= s.desired {
                "\u{2713}"
            } else {
                "\u{2717}"
            };
            println!(
                "{} {:<18} {:>7} {:>7} {}",
                status_icon, s.name, s.desired, s.ready, s.image
            );
        }
    }
    Ok(())
}
