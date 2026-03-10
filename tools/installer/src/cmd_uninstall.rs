//! Uninstall command — removes all Baker Street resources.
//!
//! This module will be fully implemented in Task 16.

use anyhow::Result;

use crate::cli::{Cli, UninstallArgs};

/// Entry point for the `uninstall` subcommand.
pub async fn run(_cli: &Cli, _args: UninstallArgs) -> Result<()> {
    todo!("cmd_uninstall::run")
}
