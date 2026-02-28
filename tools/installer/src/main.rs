mod app;
mod cli;
mod manifest;

use clap::Parser;
use cli::Cli;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if cli.status {
        println!("Status mode not yet implemented");
        return Ok(());
    }
    if cli.uninstall {
        println!("Uninstall mode not yet implemented");
        return Ok(());
    }

    println!("Baker Street Installer v{}", env!("CARGO_PKG_VERSION"));
    println!("Namespace: {}", cli.namespace);
    Ok(())
}
