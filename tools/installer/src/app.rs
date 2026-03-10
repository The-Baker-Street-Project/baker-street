//! Application state for the TUI installer.

use crate::manifest::Manifest;
use crate::interview::InterviewResult;
use std::path::PathBuf;

#[derive(Debug, Default)]
pub enum Phase {
    #[default]
    Preflight,
    FetchManifest,
    DownloadTemplate,
    Configure,
    PullImages,
    Apply,
    Verify,
    Complete,
    Failed,
}

pub struct App {
    pub phase: Phase,
    pub manifest: Option<Manifest>,
    pub config: Option<InterviewResult>,
    pub template_dir: Option<PathBuf>,
    pub k8s_context: Option<String>,
    pub namespace: String,
    pub log_entries: Vec<String>,
    pub errors: Vec<String>,
    pub dry_run: bool,
    pub auth_token: Option<String>,
    pub status_message: Option<String>,
}

impl App {
    pub fn new(namespace: &str) -> Self {
        Self {
            phase: Phase::Preflight,
            manifest: None,
            config: None,
            template_dir: None,
            k8s_context: None,
            namespace: namespace.to_string(),
            log_entries: Vec::new(),
            errors: Vec::new(),
            dry_run: false,
            auth_token: None,
            status_message: None,
        }
    }
}
