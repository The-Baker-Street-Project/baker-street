use crossterm::{
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame, Terminal,
};
use std::io::stdout;

use crate::app::{App, Phase};

// Baker Street color palette
const BG: Color = Color::Rgb(26, 26, 46); // #1a1a2e
const FG: Color = Color::Rgb(224, 224, 224); // #e0e0e0
const ACCENT: Color = Color::Rgb(233, 69, 96); // #e94560
#[allow(dead_code)]
const SUCCESS: Color = Color::Rgb(74, 222, 128); // #4ade80
#[allow(dead_code)]
const WARNING: Color = Color::Rgb(251, 191, 36); // #fbbf24
const INFO: Color = Color::Rgb(126, 200, 227); // #7ec8e3
const MUTED: Color = Color::Rgb(102, 102, 102); // #666666

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

    pub fn draw(&mut self, app: &App) -> anyhow::Result<()> {
        self.terminal.draw(|frame| render(frame, app))?;
        Ok(())
    }
}

impl Drop for Tui {
    fn drop(&mut self) {
        self.restore().ok();
    }
}

fn render(frame: &mut Frame, app: &App) {
    let size = frame.area();

    // Three-zone layout: header, main, status bar
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // header
            Constraint::Min(10),  // main panel
            Constraint::Length(3), // status bar
        ])
        .split(size);

    render_header(frame, chunks[0], app);
    render_phase(frame, chunks[1], app);
    render_status_bar(frame, chunks[2], app);
}

fn render_header(frame: &mut Frame, area: Rect, app: &App) {
    let title = format!(
        " Baker Street Installer v{} ",
        env!("CARGO_PKG_VERSION")
    );
    let cluster = format!(" {} ", app.cluster_name);

    let header = Paragraph::new(Line::from(vec![
        Span::styled(
            title,
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "\u{2500}".repeat(area.width.saturating_sub(40) as usize),
            Style::default().fg(MUTED),
        ),
        Span::styled(cluster, Style::default().fg(INFO)),
    ]))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(MUTED)),
    );

    frame.render_widget(header, area);
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let phase_text = format!(
        "  Phase {}/{}: {}",
        app.phase.index() + 1,
        Phase::total(),
        app.phase.label(),
    );

    let keys = match app.phase {
        Phase::Secrets => "Enter to submit",
        Phase::Features => "\u{2191}\u{2193} move  Space toggle  Enter \u{25b8}",
        Phase::Confirm => "\u{2190}\u{2192} select  Enter \u{25b8}",
        Phase::Complete => "o open browser  q quit",
        _ => "Enter \u{25b8}",
    };

    let bar = Paragraph::new(Line::from(vec![
        Span::styled(phase_text, Style::default().fg(FG)),
        Span::raw("  "),
        Span::styled(
            format!(
                "{:>width$}",
                keys,
                width = area.width.saturating_sub(30) as usize
            ),
            Style::default().fg(MUTED),
        ),
    ]))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(MUTED)),
    );

    frame.render_widget(bar, area);
}

fn render_phase(frame: &mut Frame, area: Rect, app: &App) {
    // Each phase has its own render function.
    // Implementation delegates to render_preflight, render_secrets, etc.
    // These are populated in subsequent tasks as each phase is wired up.
    let placeholder = Paragraph::new(format!("Phase: {} (rendering TODO)", app.phase.label()))
        .style(Style::default().fg(FG).bg(BG))
        .block(Block::default().borders(Borders::NONE));
    frame.render_widget(placeholder, area);
}
