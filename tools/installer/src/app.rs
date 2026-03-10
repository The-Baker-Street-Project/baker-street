//! Application state for the TUI installer.
//!
//! This module will be rewritten in Task 15 to match the new flow.
//! For now, a minimal stub to satisfy compilation.

/// Top-level app state (placeholder — will be redesigned).
#[derive(Debug, Default)]
pub struct App {
    pub namespace: String,
    pub should_quit: bool,
}

impl App {
    pub fn new(namespace: String) -> Self {
        Self {
            namespace,
            should_quit: false,
        }
    }
}
