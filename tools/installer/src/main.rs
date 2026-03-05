mod app;
mod brain_client;
mod chat_app;
mod chat_tui;
mod cli;
mod cmd_chat;
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
mod theme;
mod tui;

use anyhow::Result;
use clap::Parser;
use cli::{Cli, Command, InstallArgs};

#[tokio::main]
async fn main() -> Result<()> {
    let mut cli = Cli::parse();
    let command = cli.command.take().unwrap_or(Command::Install(InstallArgs::default()));
    match command {
        Command::Install(args) => cmd_install::run(&cli, &args).await,
        Command::Update(args) => cmd_update::run(&cli, &args).await,
        Command::Status(args) => cmd_status::run(&cli, &args).await,
        Command::Uninstall(args) => cmd_uninstall::run(&cli, &args).await,
        Command::Chat(args) => cmd_chat::run(&cli, &args).await,
    }
}
