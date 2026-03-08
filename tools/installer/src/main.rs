mod app;
mod cli;
mod cmd_install;
mod cmd_status;
mod cmd_uninstall;
mod cmd_update;
mod config_file;
mod health;
mod images;
mod k8s;
mod manifest;
mod meta;
mod templates;
mod tui;

use anyhow::Result;
use clap::Parser;
use cli::{Cli, Command, InstallArgs};
use crossterm::terminal::{disable_raw_mode, LeaveAlternateScreen};
use crossterm::ExecutableCommand;
use std::io::stdout;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

fn setup_logging() {
    let log_dir = dirs();
    let file_appender = tracing_appender::rolling::never(&log_dir, "install.log");
    tracing_subscriber::registry()
        .with(EnvFilter::new("info"))
        .with(
            fmt::layer()
                .with_writer(file_appender)
                .with_ansi(false)
                .with_target(false),
        )
        .init();
    tracing::info!("Baker Street installer starting");
}

/// Return ~/.bakerst/, creating it if needed.
fn dirs() -> std::path::PathBuf {
    let dir = dirs_home().join(".bakerst");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

fn setup_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Restore terminal before printing panic
        let _ = disable_raw_mode();
        let _ = stdout().execute(LeaveAlternateScreen);
        default_hook(info);
        tracing::error!("PANIC: {}", info);
    }));
}

#[tokio::main]
async fn main() -> Result<()> {
    setup_logging();
    setup_panic_hook();

    let mut cli = Cli::parse();
    let command = cli.command.take().unwrap_or(Command::Install(InstallArgs::default()));
    let result = match command {
        Command::Install(args) => cmd_install::run(&cli, &args).await,
        Command::Update(args) => cmd_update::run(&cli, &args).await,
        Command::Status(args) => cmd_status::run(&cli, &args).await,
        Command::Uninstall(args) => cmd_uninstall::run(&cli, &args).await,
    };

    if let Err(ref e) = result {
        tracing::error!("Fatal error: {:#}", e);
    }

    result
}
