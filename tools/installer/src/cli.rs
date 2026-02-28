use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "bakerst-install", version, about = "Baker Street Kubernetes installer")]
pub struct Cli {
    /// Install a specific release version (default: latest)
    #[arg(long = "release", value_name = "TAG")]
    pub release_version: Option<String>,

    /// Use a local manifest file instead of fetching from GitHub
    #[arg(long, value_name = "PATH")]
    pub manifest: Option<String>,

    /// Non-interactive mode: use env vars, no TUI
    #[arg(long)]
    pub non_interactive: bool,

    /// Remove all Baker Street resources
    #[arg(long)]
    pub uninstall: bool,

    /// Show deployment status and exit
    #[arg(long)]
    pub status: bool,

    /// Override PVC with hostPath at this directory
    #[arg(long, value_name = "PATH")]
    pub data_dir: Option<String>,

    /// Skip telemetry stack
    #[arg(long)]
    pub skip_telemetry: bool,

    /// Skip extension pods
    #[arg(long)]
    pub skip_extensions: bool,

    /// Override namespace (default: bakerst)
    #[arg(long, default_value = "bakerst")]
    pub namespace: String,

    /// Show debug output
    #[arg(short, long)]
    pub verbose: bool,
}
