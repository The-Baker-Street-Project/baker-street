//! Install command — orchestrates the full install flow:
//! fetch manifest, interview, pull images, apply K8s resources, verify.
//!
//! This module will be fully implemented in Task 12.

use anyhow::Result;

use crate::cli::{Cli, InstallArgs};

/// Entry point for the `install` subcommand.
pub async fn run(_cli: &Cli, _args: InstallArgs) -> Result<()> {
    todo!("cmd_install::run")
}
