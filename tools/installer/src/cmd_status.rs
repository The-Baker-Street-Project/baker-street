//! Status command — displays current deployment state.
//!
//! This module will be fully implemented in Task 16.

use anyhow::Result;

use crate::cli::{Cli, StatusArgs};

/// Entry point for the `status` subcommand.
pub async fn run(_cli: &Cli, _args: StatusArgs) -> Result<()> {
    todo!("cmd_status::run")
}
