mod app;
mod cli;
mod health;
mod images;
mod k8s;
mod manifest;
mod templates;
mod tui;

use anyhow::Result;
use clap::Parser;
use cli::Cli;
use app::App;
use tui::Tui;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    if cli.status {
        println!("Status mode not yet implemented");
        return Ok(());
    }
    if cli.uninstall {
        println!("Uninstall mode not yet implemented");
        return Ok(());
    }

    if cli.non_interactive {
        println!("Baker Street Installer v{}", env!("CARGO_PKG_VERSION"));
        println!("Non-interactive mode not yet implemented");
        return Ok(());
    }

    // Interactive TUI mode
    let mut app = App::new(cli.namespace.clone());
    let mut tui = Tui::new()?;

    loop {
        tui.draw(&app)?;

        if let crossterm::event::Event::Key(key) = crossterm::event::read()? {
            match key.code {
                crossterm::event::KeyCode::Char('q') => break,
                crossterm::event::KeyCode::Enter => {
                    if !app.advance() {
                        break; // Complete phase, exit
                    }
                }
                _ => {}
            }
        }

        if app.should_quit {
            break;
        }
    }

    tui.restore()?;
    Ok(())
}
