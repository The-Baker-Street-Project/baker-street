//! TUI rendering with ratatui.
//!
//! Three-zone layout: header (title), main (phases + details), status bar.
//! Shows completed phases with a checkmark, current phase with a spinner,
//! and pending phases dimmed.

use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Terminal,
};
use std::io::stdout;
use std::time::Instant;

use crate::app::{App, Phase};

const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// All phases in display order.
const PHASE_LABELS: &[(u8, &str)] = &[
    (0, "Preflight checks"),
    (1, "Fetch manifest"),
    (2, "Download template"),
    (3, "Configure"),
    (4, "Pull images"),
    (5, "Apply manifests"),
    (6, "Verify deployment"),
    (7, "Complete"),
];

pub struct Tui {
    terminal: Terminal<CrosstermBackend<std::io::Stdout>>,
    start: Instant,
}

impl Tui {
    pub fn new() -> anyhow::Result<Self> {
        enable_raw_mode()?;
        stdout().execute(EnterAlternateScreen)?;
        let backend = CrosstermBackend::new(stdout());
        let terminal = Terminal::new(backend)?;
        Ok(Self {
            terminal,
            start: Instant::now(),
        })
    }

    pub fn restore(&mut self) -> anyhow::Result<()> {
        disable_raw_mode()?;
        stdout().execute(LeaveAlternateScreen)?;
        Ok(())
    }

    /// Poll for a key event with a short timeout (for non-blocking TUI loop).
    /// Returns true if the user pressed 'q' to quit.
    pub fn handle_input(&self, app: &App) -> anyhow::Result<bool> {
        if event::poll(std::time::Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    return Ok(false);
                }
                match key.code {
                    KeyCode::Char('q') => return Ok(true),
                    KeyCode::Char('c') => {
                        if let Some(ref token) = app.auth_token {
                            copy_to_clipboard(token);
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(false)
    }

    pub fn draw(&mut self, app: &App) -> anyhow::Result<()> {
        let elapsed = self.start.elapsed();
        let spinner_idx = (elapsed.as_millis() / 80) as usize % SPINNER_FRAMES.len();
        let spinner = SPINNER_FRAMES[spinner_idx];

        self.terminal.draw(|frame| {
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(3),  // header
                    Constraint::Min(10),   // main
                    Constraint::Length(3),  // status bar
                ])
                .split(frame.area());

            // --- Header ---
            let header = Paragraph::new(Line::from(vec![
                Span::styled(
                    " Baker Street Installer ",
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("v{}", env!("CARGO_PKG_VERSION")),
                    Style::default().fg(Color::DarkGray),
                ),
            ]))
            .block(Block::default().borders(Borders::BOTTOM));
            frame.render_widget(header, chunks[0]);

            // --- Main: phases + details ---
            let current_idx = phase_index(&app.phase);
            let is_failed = matches!(app.phase, Phase::Failed);
            let is_complete = matches!(app.phase, Phase::Complete);

            let mut lines: Vec<Line> = Vec::new();
            lines.push(Line::from(""));

            for &(idx, label) in PHASE_LABELS {
                let line = if is_failed && idx == current_idx {
                    // Failed phase
                    Line::from(vec![
                        Span::styled("  \u{2717} ", Style::default().fg(Color::Red)),
                        Span::styled(label, Style::default().fg(Color::Red)),
                    ])
                } else if idx < current_idx || (is_complete && idx <= current_idx) {
                    // Completed phase
                    Line::from(vec![
                        Span::styled(
                            "  \u{2713} ",
                            Style::default().fg(Color::Green),
                        ),
                        Span::styled(label, Style::default().fg(Color::Green)),
                    ])
                } else if idx == current_idx && !is_failed {
                    // Active phase with spinner
                    Line::from(vec![
                        Span::styled(
                            format!("  {} ", spinner),
                            Style::default().fg(Color::Yellow),
                        ),
                        Span::styled(
                            label,
                            Style::default()
                                .fg(Color::Yellow)
                                .add_modifier(Modifier::BOLD),
                        ),
                    ])
                } else {
                    // Pending phase
                    Line::from(vec![
                        Span::styled("    ", Style::default()),
                        Span::styled(label, Style::default().fg(Color::DarkGray)),
                    ])
                };
                lines.push(line);
            }

            // Details section: show recent log entries
            lines.push(Line::from(""));
            let detail_start = app.log_entries.len().saturating_sub(5);
            for entry in &app.log_entries[detail_start..] {
                lines.push(Line::from(Span::styled(
                    format!("  {}", entry),
                    Style::default().fg(Color::DarkGray),
                )));
            }

            // Show errors if any
            if !app.errors.is_empty() {
                lines.push(Line::from(""));
                for err in &app.errors {
                    lines.push(Line::from(Span::styled(
                        format!("  ERROR: {}", err),
                        Style::default().fg(Color::Red),
                    )));
                }
            }

            let main = Paragraph::new(lines).block(
                Block::default()
                    .borders(Borders::NONE),
            );
            frame.render_widget(main, chunks[1]);

            // --- Status bar ---
            let elapsed_secs = elapsed.as_secs();
            let elapsed_str = format!("{}:{:02}", elapsed_secs / 60, elapsed_secs % 60);

            let status_text = if let Some(ref msg) = app.status_message {
                msg.clone()
            } else if is_complete {
                "Installation complete! Press 'c' to copy auth token, 'q' to exit".into()
            } else if is_failed {
                "Installation failed. Press 'q' to exit".into()
            } else {
                format!("Elapsed: {}  |  q: quit", elapsed_str)
            };

            let status_bar = Paragraph::new(Line::from(Span::styled(
                format!(" {}", status_text),
                Style::default().fg(Color::DarkGray),
            )))
            .block(Block::default().borders(Borders::TOP));
            frame.render_widget(status_bar, chunks[2]);
        })?;
        Ok(())
    }
}

impl Drop for Tui {
    fn drop(&mut self) {
        self.restore().ok();
    }
}

/// Map a Phase to its ordinal index for display comparison.
fn phase_index(phase: &Phase) -> u8 {
    match phase {
        Phase::Preflight => 0,
        Phase::FetchManifest => 1,
        Phase::DownloadTemplate => 2,
        Phase::Configure => 3,
        Phase::PullImages => 4,
        Phase::Apply => 5,
        Phase::Verify => 6,
        Phase::Complete => 7,
        Phase::Failed => {
            // Failed can happen during any phase; we return 7 so all prior
            // phases show as completed. The caller should set the phase to
            // Failed *after* updating errors, so the last active phase is
            // captured in log_entries.
            7
        }
    }
}

/// Attempt to copy text to the system clipboard.
/// Falls back to shell commands if the clipboard crate fails.
fn copy_to_clipboard(text: &str) {
    // Try cli-clipboard first
    if cli_clipboard::set_contents(text.to_string()).is_ok() {
        return;
    }
    // Fallback: try platform-specific commands
    let commands: &[(&str, &[&str])] = &[
        ("pbcopy", &[]),            // macOS
        ("xclip", &["-selection", "clipboard"]), // Linux X11
        ("xsel", &["--clipboard", "--input"]),   // Linux X11 alt
        ("wl-copy", &[]),           // Wayland
    ];
    for (cmd, args) in commands {
        if let Ok(mut child) = std::process::Command::new(cmd)
            .args(*args)
            .stdin(std::process::Stdio::piped())
            .spawn()
        {
            if let Some(ref mut stdin) = child.stdin {
                use std::io::Write;
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
            return;
        }
    }
    // If all else fails, just print it
    eprintln!("Could not copy to clipboard. Auth token: {}", text);
}
