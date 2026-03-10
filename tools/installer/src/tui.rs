//! TUI rendering with ratatui.
//!
//! This module will be rewritten in Task 15 to match the new flow.
//! For now, a minimal stub to satisfy compilation.

use crossterm::{
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::{backend::CrosstermBackend, Terminal};
use std::io::stdout;

use crate::app::App;

pub struct Tui {
    terminal: Terminal<CrosstermBackend<std::io::Stdout>>,
}

impl Tui {
    pub fn new() -> anyhow::Result<Self> {
        enable_raw_mode()?;
        stdout().execute(EnterAlternateScreen)?;
        let backend = CrosstermBackend::new(stdout());
        let terminal = Terminal::new(backend)?;
        Ok(Self { terminal })
    }

    pub fn restore(&mut self) -> anyhow::Result<()> {
        disable_raw_mode()?;
        stdout().execute(LeaveAlternateScreen)?;
        Ok(())
    }

    pub fn draw(&mut self, _app: &App) -> anyhow::Result<()> {
        self.terminal.draw(|_frame| {
            // Placeholder — will be implemented in Task 15
        })?;
        Ok(())
    }
}

impl Drop for Tui {
    fn drop(&mut self) {
        self.restore().ok();
    }
}
