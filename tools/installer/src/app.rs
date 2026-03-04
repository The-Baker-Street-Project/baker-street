#[derive(Clone, Debug)]
pub struct K8sContext {
    pub name: String,
    pub cluster: String,
    pub is_current: bool,
    pub cluster_type: ClusterType,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClusterType {
    DockerDesktop,
    Minikube,
    K3s,
    Kind,
    RancherDesktop,
    Cloud,
    Unknown,
}

impl ClusterType {
    pub fn from_context_name(name: &str, cluster: &str) -> Self {
        let n = name.to_lowercase();
        let c = cluster.to_lowercase();
        if n.contains("docker-desktop") || c.contains("docker-desktop") {
            ClusterType::DockerDesktop
        } else if n.contains("minikube") || c.contains("minikube") {
            ClusterType::Minikube
        } else if n.contains("k3s") || (n == "default" && c.contains("k3s")) {
            ClusterType::K3s
        } else if n.starts_with("kind-") || c.starts_with("kind-") {
            ClusterType::Kind
        } else if n.contains("rancher") || c.contains("rancher") {
            ClusterType::RancherDesktop
        } else if c.contains("eks") || c.contains("gke") || c.contains("aks")
            || c.contains("amazonaws") || c.contains("azmk8s") {
            ClusterType::Cloud
        } else {
            ClusterType::Unknown
        }
    }

    pub fn display_name(&self) -> &str {
        match self {
            ClusterType::DockerDesktop => "Docker Desktop",
            ClusterType::Minikube => "Minikube",
            ClusterType::K3s => "k3s",
            ClusterType::Kind => "kind",
            ClusterType::RancherDesktop => "Rancher Desktop",
            ClusterType::Cloud => "Cloud (not recommended)",
            ClusterType::Unknown => "Unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

impl Phase {
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

    pub fn total() -> usize {
        10
    }

    pub fn label(&self) -> &'static str {
        match self {
            Phase::Preflight => "Preflight",
            Phase::EnvVarChoice => "Secret Source",
            Phase::Secrets => "Secrets",
            Phase::Providers => "Providers",
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
            Phase::Preflight => Some(Phase::EnvVarChoice),
            Phase::EnvVarChoice => Some(Phase::Secrets),
            Phase::Secrets => Some(Phase::Providers),
            Phase::Providers => Some(Phase::Features),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderType {
    Anthropic,
    OpenAI,
    Ollama,
}

impl ProviderType {
    pub fn label(&self) -> &'static str {
        match self {
            ProviderType::Anthropic => "Anthropic",
            ProviderType::OpenAI => "OpenAI",
            ProviderType::Ollama => "Ollama",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderStep {
    BrainProvider,
    BrainModel,
    BrainCredential,
    WorkerChoice,
    WorkerProvider,
    WorkerModel,
    WorkerCredential,
    Done,
}

/// Collected secrets and configuration
#[derive(Debug, Clone, Default)]
pub struct InstallConfig {
    pub anthropic_api_key: Option<String>,
    pub default_model: Option<String>,
    pub openai_api_key: Option<String>,
    pub ollama_endpoints: Option<String>,
    pub voyage_api_key: Option<String>,
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

/// A single secret prompt in the Secrets phase
#[derive(Debug, Clone)]
pub struct SecretPrompt {
    pub key: String,
    pub description: String,
    pub required: bool,
    pub is_secret: bool, // mask input with bullets
    pub is_feature: bool, // true for feature-derived prompts
    pub value: Option<String>,
}

/// Top-level app state
pub struct App {
    pub phase: Phase,
    pub config: InstallConfig,
    pub should_quit: bool,
    pub cluster_name: String,

    // Preflight results
    pub preflight_checks: Vec<(String, ItemStatus)>,

    // K8s context detection
    pub available_contexts: Vec<K8sContext>,
    pub selected_context_idx: usize,
    pub context_picker_active: bool,

    // Env var choice phase
    pub use_env_vars: Option<bool>,
    pub detected_env_vars: Vec<(String, String)>, // (key, masked_value)

    // Secrets phase
    pub secret_prompts: Vec<SecretPrompt>,
    pub current_secret_index: usize,
    pub secret_input: String,

    // Providers phase
    pub provider_step: ProviderStep,
    pub provider_cursor: usize,
    pub provider_input: String,

    pub brain_provider: Option<ProviderType>,
    pub brain_model_id: Option<String>,
    pub brain_model_display: Option<String>,

    pub worker_same_as_brain: bool,
    pub worker_provider: Option<ProviderType>,
    pub worker_model_id: Option<String>,
    pub worker_model_display: Option<String>,

    // Features phase
    pub feature_cursor: usize,
    pub collecting_feature_secrets: bool,

    // Confirm phase
    pub confirm_selected: usize, // 0 = Confirm, 1 = Cancel

    // Pull phase
    pub pull_statuses: Vec<(String, ItemStatus)>,
    pub pull_progress: (usize, usize), // (done, total)

    // Deploy phase
    pub deploy_statuses: Vec<(String, ItemStatus)>,
    pub deploy_progress: (usize, usize),

    // Health phase
    pub pod_statuses: Vec<crate::health::PodHealth>,
    pub health_done: bool,
    pub health_failed: bool,

    // Complete phase
    pub manifest_version: String,

    // Manifest (stored after preflight fetch)
    pub manifest: Option<crate::manifest::ReleaseManifest>,
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

            // Preflight
            preflight_checks: Vec::new(),

            // K8s context detection
            available_contexts: Vec::new(),
            selected_context_idx: 0,
            context_picker_active: false,

            // Env var choice
            use_env_vars: None,
            detected_env_vars: Vec::new(),

            // Secrets
            secret_prompts: Vec::new(),
            current_secret_index: 0,
            secret_input: String::new(),

            // Providers
            provider_step: ProviderStep::BrainProvider,
            provider_cursor: 0,
            provider_input: String::new(),

            brain_provider: None,
            brain_model_id: None,
            brain_model_display: None,

            worker_same_as_brain: true,
            worker_provider: None,
            worker_model_id: None,
            worker_model_display: None,

            // Features
            feature_cursor: 0,
            collecting_feature_secrets: false,

            // Confirm
            confirm_selected: 0,

            // Pull
            pull_statuses: Vec::new(),
            pull_progress: (0, 0),

            // Deploy
            deploy_statuses: Vec::new(),
            deploy_progress: (0, 0),

            // Health
            pod_statuses: Vec::new(),
            health_done: false,
            health_failed: false,

            // Complete
            manifest_version: String::new(),

            // Manifest
            manifest: None,
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

    /// Go back to Providers from Confirm
    pub fn back_to_providers(&mut self) {
        if self.phase == Phase::Confirm {
            self.phase = Phase::Providers;
            // Reset provider step to beginning for re-entry
            self.provider_step = ProviderStep::BrainProvider;
            self.provider_cursor = 0;
            self.provider_input.clear();
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
        assert_eq!(count, 9);
        assert_eq!(phase, Phase::Complete);
    }

    #[test]
    fn complete_has_no_next() {
        assert_eq!(Phase::Complete.next(), None);
    }

    #[test]
    fn phase_index_is_sequential() {
        assert_eq!(Phase::Preflight.index(), 0);
        assert_eq!(Phase::Complete.index(), 9);
    }

    #[test]
    fn app_advance_works() {
        let mut app = App::new("bakerst".into());
        assert_eq!(app.phase, Phase::Preflight);
        assert!(app.advance());
        assert_eq!(app.phase, Phase::EnvVarChoice);
    }

    #[test]
    fn app_back_to_providers_only_from_confirm() {
        let mut app = App::new("bakerst".into());
        app.phase = Phase::Confirm;
        app.back_to_providers();
        assert_eq!(app.phase, Phase::Providers);
    }

    #[test]
    fn app_back_to_providers_noop_from_other_phases() {
        let mut app = App::new("bakerst".into());
        app.phase = Phase::Deploy;
        app.back_to_providers();
        assert_eq!(app.phase, Phase::Deploy);
    }

    #[test]
    fn provider_type_labels() {
        assert_eq!(ProviderType::Anthropic.label(), "Anthropic");
        assert_eq!(ProviderType::OpenAI.label(), "OpenAI");
        assert_eq!(ProviderType::Ollama.label(), "Ollama");
    }
}
