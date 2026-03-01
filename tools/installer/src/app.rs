#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Preflight,
    Secrets,
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
            Phase::Secrets => 1,
            Phase::Features => 2,
            Phase::Confirm => 3,
            Phase::Pull => 4,
            Phase::Deploy => 5,
            Phase::Health => 6,
            Phase::Complete => 7,
        }
    }

    pub fn total() -> usize {
        8
    }

    pub fn label(&self) -> &'static str {
        match self {
            Phase::Preflight => "Preflight",
            Phase::Secrets => "Secrets",
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
            Phase::Preflight => Some(Phase::Secrets),
            Phase::Secrets => Some(Phase::Features),
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

/// Collected secrets and configuration
#[derive(Debug, Clone, Default)]
pub struct InstallConfig {
    pub oauth_token: Option<String>,
    pub api_key: Option<String>,
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

    // Secrets phase
    pub secret_prompts: Vec<SecretPrompt>,
    pub current_secret_index: usize,
    pub secret_input: String,

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

            // Secrets
            secret_prompts: Vec::new(),
            current_secret_index: 0,
            secret_input: String::new(),

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

    /// Only valid from Confirm → back to Secrets
    pub fn back_to_secrets(&mut self) {
        if self.phase == Phase::Confirm {
            self.phase = Phase::Secrets;
            // Reset secret input state for re-entry
            self.current_secret_index = 0;
            self.secret_input = String::new();
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
        assert_eq!(count, 7);
        assert_eq!(phase, Phase::Complete);
    }

    #[test]
    fn complete_has_no_next() {
        assert_eq!(Phase::Complete.next(), None);
    }

    #[test]
    fn phase_index_is_sequential() {
        assert_eq!(Phase::Preflight.index(), 0);
        assert_eq!(Phase::Complete.index(), 7);
    }

    #[test]
    fn app_advance_works() {
        let mut app = App::new("bakerst".into());
        assert_eq!(app.phase, Phase::Preflight);
        assert!(app.advance());
        assert_eq!(app.phase, Phase::Secrets);
    }

    #[test]
    fn app_back_to_secrets_only_from_confirm() {
        let mut app = App::new("bakerst".into());
        app.phase = Phase::Confirm;
        app.back_to_secrets();
        assert_eq!(app.phase, Phase::Secrets);
    }

    #[test]
    fn app_back_to_secrets_noop_from_other_phases() {
        let mut app = App::new("bakerst".into());
        app.phase = Phase::Deploy;
        app.back_to_secrets();
        assert_eq!(app.phase, Phase::Deploy);
    }
}
