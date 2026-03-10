use bakerst_install::{cli, cmd_install, cmd_status, cmd_update, cmd_uninstall};
use clap::Parser;
use anyhow::Result;
use tracing_subscriber::EnvFilter;
use std::fs;

#[tokio::main]
async fn main() -> Result<()> {
    let mut cli = cli::Cli::parse();

    // Ensure ~/.bakerst/ exists
    let bakerst_dir = dirs::home_dir()
        .expect("Cannot determine home directory")
        .join(".bakerst");
    fs::create_dir_all(&bakerst_dir)?;

    // Setup logging
    let log_file = if let Some(cli::Commands::Install(ref args)) = cli.command {
        args.log.clone()
    } else {
        bakerst_dir.join("install.log")
    };

    let file_appender = tracing_appender::rolling::never(
        log_file.parent().unwrap_or(".".as_ref()),
        log_file.file_name().unwrap_or("install.log".as_ref()),
    );
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| if cli.verbose { "debug".into() } else { "info".into() })
        )
        .with_writer(non_blocking)
        .json()
        .init();

    // Setup panic hook for terminal cleanup
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let _ = crossterm::terminal::disable_raw_mode();
        let _ = crossterm::execute!(
            std::io::stderr(),
            crossterm::terminal::LeaveAlternateScreen
        );
        original_hook(panic_info);
    }));

    // Extract command BEFORE matching to avoid partial move of cli
    let command = cli.command.take()
        .unwrap_or(cli::Commands::Install(cli::InstallArgs::default()));

    match command {
        cli::Commands::Install(args) => cmd_install::run(&cli, args).await,
        cli::Commands::Status(args) => cmd_status::run(&cli, args).await,
        cli::Commands::Update(args) => cmd_update::run(&cli, args).await,
        cli::Commands::Uninstall(args) => cmd_uninstall::run(&cli, args).await,
    }
}
