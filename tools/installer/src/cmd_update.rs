//! Update command — fetches latest manifest and applies changes.
//!
//! This module will be fully implemented in Task 16.

use anyhow::Result;

use crate::cli::{Cli, UpdateArgs};

/// Entry point for the `update` subcommand.
pub async fn run(_cli: &Cli, _args: UpdateArgs) -> Result<()> {
    todo!("cmd_update::run")
}
