//! Interview engine — drives the TUI secret/feature prompts
//! based on the config schema.
//!
//! This module will be fully implemented in Task 10.

use anyhow::Result;
use std::collections::HashMap;

/// Collected answers from the interview process.
#[derive(Debug, Clone, Default)]
pub struct InterviewAnswers {
    pub secrets: HashMap<String, String>,
    pub features: HashMap<String, bool>,
}

/// Run the interactive interview, returning collected answers.
/// Uses the config schema to determine what to ask.
pub async fn run_interview(
    _schema: &crate::config_schema::ConfigSchema,
) -> Result<InterviewAnswers> {
    todo!("interview::run_interview")
}
