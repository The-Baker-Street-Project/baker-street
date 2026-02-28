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

/// Top-level app state
pub struct App {
    pub phase: Phase,
    pub config: InstallConfig,
    pub should_quit: bool,
    pub cluster_name: String,
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
