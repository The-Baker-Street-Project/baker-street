use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "bakerst-install", version, about = "Baker Street Kubernetes installer")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,

    /// Override namespace (default: bakerst)
    #[arg(long, global = true, default_value = "bakerst")]
    pub namespace: String,

    /// Show debug output
    #[arg(short, long, global = true)]
    pub verbose: bool,

    /// Use a local manifest file instead of fetching from GitHub
    #[arg(long, global = true, value_name = "PATH")]
    pub manifest: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Install Baker Street (default when no subcommand given)
    Install(InstallArgs),

    /// Update an existing Baker Street deployment
    Update(UpdateArgs),

    /// Show deployment status
    Status(StatusArgs),

    /// Remove all Baker Street resources
    Uninstall(UninstallArgs),
}

#[derive(Parser, Debug, Default)]
pub struct InstallArgs {
    /// Non-interactive mode: use env vars, no TUI
    #[arg(short = 'y', long = "non-interactive")]
    pub non_interactive: bool,

    /// Install from a YAML config file (non-interactive)
    #[arg(long, value_name = "PATH")]
    pub config: Option<String>,

    /// Override PVC with hostPath at this directory
    #[arg(long, value_name = "PATH")]
    pub data_dir: Option<String>,

    /// Skip telemetry stack
    #[arg(long)]
    pub skip_telemetry: bool,

    /// Skip extension pods
    #[arg(long)]
    pub skip_extensions: bool,
}

#[derive(Parser, Debug, Default)]
pub struct UpdateArgs {
    /// Non-interactive mode: skip prompts
    #[arg(short = 'y', long = "non-interactive")]
    pub non_interactive: bool,

    /// Re-prompt for secrets (reconfigure)
    #[arg(long)]
    pub reconfigure: bool,

    /// Update a single component only
    #[arg(long, value_name = "NAME")]
    pub component: Option<String>,

    /// Skip extension pods
    #[arg(long)]
    pub skip_extensions: bool,

    /// Force update even if versions match
    #[arg(long)]
    pub force: bool,
}

#[derive(Parser, Debug, Default)]
pub struct StatusArgs {
    /// Output as JSON
    #[arg(long)]
    pub json: bool,

    /// Continuously poll (every 5s)
    #[arg(long)]
    pub watch: bool,
}

#[derive(Parser, Debug, Default)]
pub struct UninstallArgs {
    /// Skip confirmation prompt
    #[arg(short = 'y', long = "non-interactive")]
    pub non_interactive: bool,
}
