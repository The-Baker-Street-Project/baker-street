use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "bakerst-install", version, about = "Baker Street Installer")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,

    /// Kubernetes namespace
    #[arg(long, default_value = "bakerst")]
    pub namespace: String,

    /// Enable verbose logging
    #[arg(short, long)]
    pub verbose: bool,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Install Baker Street (default)
    Install(InstallArgs),
    /// Check deployment status
    Status(StatusArgs),
    /// Update to latest version
    Update(UpdateArgs),
    /// Remove Baker Street
    Uninstall(UninstallArgs),
}

#[derive(clap::Args, Default)]
pub struct InstallArgs {
    /// Path to config file (skip interactive interview)
    #[arg(long)]
    pub config: Option<PathBuf>,

    /// Path to local manifest file (skip GitHub fetch)
    #[arg(long)]
    pub manifest: Option<PathBuf>,

    /// Path to local install template tarball (skip download)
    #[arg(long)]
    pub template: Option<PathBuf>,

    /// Install specific version (default: latest)
    #[arg(long)]
    pub version: Option<String>,

    /// Path for structured JSON log
    #[arg(long, default_value = "bakerst-install.log")]
    pub log: PathBuf,

    /// Fail on missing required values instead of prompting
    #[arg(long)]
    pub non_interactive: bool,

    /// Show what would be applied without applying
    #[arg(long)]
    pub dry_run: bool,

    /// Apply manifests but skip waiting for pods and verification
    #[arg(long)]
    pub no_wait: bool,
}

#[derive(clap::Args)]
pub struct StatusArgs {
    /// Output as JSON
    #[arg(long)]
    pub json: bool,

    /// Watch mode (poll every 5s)
    #[arg(long)]
    pub watch: bool,
}

#[derive(clap::Args)]
pub struct UpdateArgs {
    /// Skip confirmation prompt
    #[arg(long, short = 'y')]
    pub non_interactive: bool,

    /// Reconfigure secrets (re-run interview)
    #[arg(long)]
    pub reconfigure: bool,
}

#[derive(clap::Args)]
pub struct UninstallArgs {
    /// Skip confirmation prompt
    #[arg(long, short = 'y')]
    pub non_interactive: bool,
}
