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

use crate::app::{App, ItemStatus, Phase};
use crate::templates::mask_secret;

// Baker Street color palette
const BG: Color = Color::Rgb(26, 26, 46); // #1a1a2e
const FG: Color = Color::Rgb(224, 224, 224); // #e0e0e0
const ACCENT: Color = Color::Rgb(233, 69, 96); // #e94560
const SUCCESS: Color = Color::Rgb(74, 222, 128); // #4ade80
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
        Phase::Secrets => "Enter to submit  |  Esc to skip optional",
        Phase::Features => "\u{2191}\u{2193} move  Space toggle  Enter \u{25b8}",
        Phase::Confirm => "\u{2190}\u{2192} select  Enter \u{25b8}",
        Phase::Complete => "o open browser  q quit",
        Phase::Preflight | Phase::Pull | Phase::Deploy | Phase::Health => "q quit  (auto-advancing...)",
        //_ => "Enter \u{25b8}",
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
    match app.phase {
        Phase::Preflight => render_preflight(frame, area, app),
        Phase::Secrets => render_secrets(frame, area, app),
        Phase::Features => render_features(frame, area, app),
        Phase::Confirm => render_confirm(frame, area, app),
        Phase::Pull => render_pull(frame, area, app),
        Phase::Deploy => render_deploy(frame, area, app),
        Phase::Health => render_health(frame, area, app),
        Phase::Complete => render_complete(frame, area, app),
    }
}

// ---------- Phase 1: Preflight ----------

fn render_preflight(frame: &mut Frame, area: Rect, app: &App) {
    let mut lines = vec![
        Line::from(Span::styled(
            " Preflight Checks",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];

    if app.preflight_checks.is_empty() {
        lines.push(Line::from(Span::styled(
            "  \u{25cb} Running checks...",
            Style::default().fg(MUTED),
        )));
    } else {
        for (label, status) in &app.preflight_checks {
            let (icon, color) = status_icon_color(status);
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(icon, Style::default().fg(color)),
                Span::raw(" "),
                Span::styled(label.clone(), Style::default().fg(FG)),
            ]));
        }
    }

    let paragraph = Paragraph::new(lines)
        .style(Style::default().bg(BG))
        .block(Block::default().borders(Borders::NONE));

    frame.render_widget(paragraph, area);
}

// ---------- Phase 2: Secrets ----------

fn render_secrets(frame: &mut Frame, area: Rect, app: &App) {
    let mut lines = vec![
        Line::from(Span::styled(
            " Authentication & Secrets",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];

    // Show completed secrets above current
    for (i, prompt) in app.secret_prompts.iter().enumerate() {
        if i >= app.current_secret_index {
            break;
        }
        let display_val = match &prompt.value {
            Some(v) if !v.is_empty() => {
                if prompt.is_secret {
                    mask_secret(v)
                } else {
                    v.clone()
                }
            }
            _ => "(skipped)".to_string(),
        };
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled("\u{2713}", Style::default().fg(SUCCESS)),
            Span::raw(" "),
            Span::styled(&prompt.key, Style::default().fg(FG)),
            Span::raw(": "),
            Span::styled(display_val, Style::default().fg(MUTED)),
        ]));
    }

    // Show current prompt
    if app.current_secret_index < app.secret_prompts.len() {
        let prompt = &app.secret_prompts[app.current_secret_index];
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled("\u{25b8} ", Style::default().fg(ACCENT)),
            Span::styled(
                &prompt.description,
                Style::default().fg(FG).add_modifier(Modifier::BOLD),
            ),
        ]));
        let req_text = if prompt.required { " (required)" } else { " (optional, Enter to skip)" };
        lines.push(Line::from(vec![
            Span::raw("    "),
            Span::styled(req_text, Style::default().fg(MUTED)),
        ]));
        lines.push(Line::from(""));

        // Show input field
        let display_input = if prompt.is_secret {
            "\u{2022}".repeat(app.secret_input.len())
        } else {
            app.secret_input.clone()
        };
        lines.push(Line::from(vec![
            Span::raw("  > "),
            Span::styled(display_input, Style::default().fg(INFO)),
            Span::styled("\u{2588}", Style::default().fg(ACCENT)), // cursor
        ]));
    } else {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "  All secrets collected. Advancing...",
            Style::default().fg(SUCCESS),
        )));
    }

    let paragraph = Paragraph::new(lines)
        .style(Style::default().bg(BG))
        .block(Block::default().borders(Borders::NONE));

    frame.render_widget(paragraph, area);
}

// ---------- Phase 3: Features ----------

fn render_features(frame: &mut Frame, area: Rect, app: &App) {
    let mut lines = vec![
        Line::from(Span::styled(
            " Optional Features",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "  Use \u{2191}\u{2193} to navigate, Space to toggle, Enter to confirm",
            Style::default().fg(MUTED),
        )),
        Line::from(""),
    ];

    if app.config.features.is_empty() {
        lines.push(Line::from(Span::styled(
            "  No optional features available. Press Enter to continue.",
            Style::default().fg(MUTED),
        )));
    } else {
        for (i, feature) in app.config.features.iter().enumerate() {
            let is_selected = i == app.feature_cursor;
            let checkbox = if feature.enabled { "\u{2611}" } else { "\u{2610}" };
            let fg = if is_selected { ACCENT } else { FG };
            let prefix = if is_selected { "\u{25b8} " } else { "  " };

            lines.push(Line::from(vec![
                Span::styled(prefix, Style::default().fg(ACCENT)),
                Span::styled(
                    format!("{} {}", checkbox, feature.name),
                    Style::default().fg(fg).add_modifier(if is_selected {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
                ),
                Span::raw("  "),
                Span::styled(
                    format!("({})", feature.id),
                    Style::default().fg(MUTED),
                ),
            ]));
        }
    }

    let paragraph = Paragraph::new(lines)
        .style(Style::default().bg(BG))
        .block(Block::default().borders(Borders::NONE));

    frame.render_widget(paragraph, area);
}

// ---------- Phase 4: Confirm ----------

fn render_confirm(frame: &mut Frame, area: Rect, app: &App) {
    let mut lines = vec![
        Line::from(Span::styled(
            " Confirm Installation",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];

    // Box top
    let box_width = 56;
    lines.push(Line::from(Span::styled(
        format!("  \u{250c}{}\u{2510}", "\u{2500}".repeat(box_width)),
        Style::default().fg(MUTED),
    )));

    // Authentication section
    lines.push(box_line(box_width, " Authentication", ACCENT, true));
    let auth_method = if app.config.oauth_token.is_some() {
        "OAuth Token"
    } else if app.config.api_key.is_some() {
        "API Key"
    } else {
        "Not set"
    };
    lines.push(box_line(box_width, &format!("   Method: {}", auth_method), FG, false));

    // Configuration section
    lines.push(box_line(box_width, "", MUTED, false));
    lines.push(box_line(box_width, " Configuration", ACCENT, true));
    lines.push(box_line(
        box_width,
        &format!("   Namespace: {}", app.config.namespace),
        FG,
        false,
    ));
    lines.push(box_line(
        box_width,
        &format!("   Agent Name: {}", app.config.agent_name),
        FG,
        false,
    ));
    let version_display = if app.manifest_version.is_empty() {
        "local"
    } else {
        &app.manifest_version
    };
    lines.push(box_line(
        box_width,
        &format!("   Version: {}", version_display),
        FG,
        false,
    ));

    // Features section
    lines.push(box_line(box_width, "", MUTED, false));
    lines.push(box_line(box_width, " Features", ACCENT, true));
    if app.config.features.is_empty() {
        lines.push(box_line(box_width, "   (none)", MUTED, false));
    } else {
        for f in &app.config.features {
            let icon = if f.enabled { "\u{2713}" } else { "\u{2717}" };
            let color = if f.enabled { SUCCESS } else { MUTED };
            // We need to build this carefully
            let text = format!("   {} {}", icon, f.name);
            lines.push(box_line(box_width, &text, color, false));
        }
    }

    // Box bottom
    lines.push(Line::from(Span::styled(
        format!("  \u{2514}{}\u{2518}", "\u{2500}".repeat(box_width)),
        Style::default().fg(MUTED),
    )));

    // Buttons
    lines.push(Line::from(""));
    let confirm_style = if app.confirm_selected == 0 {
        Style::default().fg(BG).bg(SUCCESS).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(FG)
    };
    let cancel_style = if app.confirm_selected == 1 {
        Style::default().fg(BG).bg(WARNING).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(FG)
    };

    lines.push(Line::from(vec![
        Span::raw("      "),
        Span::styled(" Confirm ", confirm_style),
        Span::raw("   "),
        Span::styled(" Cancel ", cancel_style),
    ]));

    let paragraph = Paragraph::new(lines)
        .style(Style::default().bg(BG))
        .block(Block::default().borders(Borders::NONE));

    frame.render_widget(paragraph, area);
}

/// Helper to make a line inside the confirm box
fn box_line(box_width: usize, text: &str, color: Color, bold: bool) -> Line<'static> {
    let padding = box_width.saturating_sub(text.len());
    let mut style = Style::default().fg(color);
    if bold {
        style = style.add_modifier(Modifier::BOLD);
    }
    Line::from(vec![
        Span::styled("  \u{2502}", Style::default().fg(MUTED)),
        Span::styled(text.to_string(), style),
        Span::raw(" ".repeat(padding)),
        Span::styled("\u{2502}", Style::default().fg(MUTED)),
    ])
}

// ---------- Phase 5: Pull Images ----------

fn render_pull(frame: &mut Frame, area: Rect, app: &App) {
    let mut lines = vec![
        Line::from(Span::styled(
            " Pulling Images",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];

    // Progress bar
    let (done, total) = app.pull_progress;
    if total > 0 {
        lines.push(render_progress_bar(done, total, area.width.saturating_sub(6) as usize));
        lines.push(Line::from(Span::styled(
            format!("  {}/{} images", done, total),
            Style::default().fg(MUTED),
        )));
    }
    lines.push(Line::from(""));

    // Per-image status
    for (image, status) in &app.pull_statuses {
        let (icon, color) = status_icon_color(status);
        let detail = match status {
            ItemStatus::Done => " done".to_string(),
            ItemStatus::InProgress => " pulling...".to_string(),
            ItemStatus::Failed(e) => format!(" FAILED: {}", e),
            ItemStatus::Pending => String::new(),
            ItemStatus::Skipped => " skipped".to_string(),
        };
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(icon, Style::default().fg(color)),
            Span::raw(" "),
            Span::styled(image.clone(), Style::default().fg(FG)),
            Span::styled(detail, Style::default().fg(MUTED)),
        ]));
    }

    let paragraph = Paragraph::new(lines)
        .style(Style::default().bg(BG))
        .block(Block::default().borders(Borders::NONE));

    frame.render_widget(paragraph, area);
}

// ---------- Phase 6: Deploy ----------

fn render_deploy(frame: &mut Frame, area: Rect, app: &App) {
    let mut lines = vec![
        Line::from(Span::styled(
            " Deploying Resources",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];

    // Progress bar
    let (done, total) = app.deploy_progress;
    if total > 0 {
        lines.push(render_progress_bar(done, total, area.width.saturating_sub(6) as usize));
        lines.push(Line::from(Span::styled(
            format!("  {}/{} resources", done, total),
            Style::default().fg(MUTED),
        )));
    }
    lines.push(Line::from(""));

    // Per-resource status
    for (resource, status) in &app.deploy_statuses {
        let (icon, color) = status_icon_color(status);
        let detail = match status {
            ItemStatus::Done => " applied".to_string(),
            ItemStatus::InProgress => " applying...".to_string(),
            ItemStatus::Failed(e) => format!(" FAILED: {}", e),
            ItemStatus::Pending => String::new(),
            ItemStatus::Skipped => " skipped".to_string(),
        };
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(icon, Style::default().fg(color)),
            Span::raw(" "),
            Span::styled(resource.clone(), Style::default().fg(FG)),
            Span::styled(detail, Style::default().fg(MUTED)),
        ]));
    }

    let paragraph = Paragraph::new(lines)
        .style(Style::default().bg(BG))
        .block(Block::default().borders(Borders::NONE));

    frame.render_widget(paragraph, area);
}

// ---------- Phase 7: Health Check ----------

fn render_health(frame: &mut Frame, area: Rect, app: &App) {
    let mut lines = vec![
        Line::from(Span::styled(
            " Health Check",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];

    if app.pod_statuses.is_empty() && !app.health_done {
        lines.push(Line::from(Span::styled(
            "  Waiting for pods to start...",
            Style::default().fg(MUTED),
        )));
    } else {
        // Table header
        lines.push(Line::from(vec![
            Span::styled(
                format!("  {:<35} {:<18} {:<8} {:<10}", "POD", "STATUS", "READY", "RESTARTS"),
                Style::default().fg(MUTED).add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(Span::styled(
            format!("  {}", "\u{2500}".repeat(75)),
            Style::default().fg(MUTED),
        )));

        for pod in &app.pod_statuses {
            let ready_str = if pod.ready { "Yes" } else { "No" };
            let status_color = if pod.ready {
                SUCCESS
            } else if pod.error.is_some() {
                WARNING
            } else {
                FG
            };

            let phase_display = if let Some(ref err) = pod.error {
                err.clone()
            } else {
                pod.phase.clone()
            };

            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(
                    format!("{:<35}", truncate_str(&pod.name, 35)),
                    Style::default().fg(FG),
                ),
                Span::styled(
                    format!("{:<18}", truncate_str(&phase_display, 18)),
                    Style::default().fg(status_color),
                ),
                Span::styled(
                    format!("{:<8}", ready_str),
                    Style::default().fg(if pod.ready { SUCCESS } else { WARNING }),
                ),
                Span::styled(
                    format!("{:<10}", pod.restarts),
                    Style::default().fg(if pod.restarts > 0 { WARNING } else { FG }),
                ),
            ]));
        }
    }

    if app.health_done && !app.health_failed {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "  All pods healthy! Advancing...",
            Style::default().fg(SUCCESS),
        )));
    }

    if app.health_failed {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "  Some pods failed to become healthy. Check logs above.",
            Style::default().fg(WARNING),
        )));
    }

    let paragraph = Paragraph::new(lines)
        .style(Style::default().bg(BG))
        .block(Block::default().borders(Borders::NONE));

    frame.render_widget(paragraph, area);
}

// ---------- Phase 8: Complete ----------

fn render_complete(frame: &mut Frame, area: Rect, app: &App) {
    let mut lines = vec![
        Line::from(""),
        Line::from(Span::styled(
            "  \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}   \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}  ",
            Style::default().fg(ACCENT),
        )),
        Line::from(Span::styled(
            "  \u{2588}   \u{2588}  \u{2588}       ",
            Style::default().fg(ACCENT),
        )),
        Line::from(Span::styled(
            "  \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}   \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}  Baker Street",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "  \u{2588}   \u{2588}       \u{2588}  Deployed Successfully!",
            Style::default().fg(ACCENT),
        )),
        Line::from(Span::styled(
            "  \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}  \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}  ",
            Style::default().fg(ACCENT),
        )),
        Line::from(""),
        Line::from(""),
    ];

    // Access info
    lines.push(Line::from(vec![
        Span::styled("  Access URL: ", Style::default().fg(MUTED)),
        Span::styled(
            format!("http://localhost:30080"),
            Style::default().fg(INFO).add_modifier(Modifier::BOLD),
        ),
    ]));

    lines.push(Line::from(vec![
        Span::styled("  Namespace:  ", Style::default().fg(MUTED)),
        Span::styled(
            app.config.namespace.clone(),
            Style::default().fg(FG),
        ),
    ]));

    lines.push(Line::from(vec![
        Span::styled("  Agent Name: ", Style::default().fg(MUTED)),
        Span::styled(
            app.config.agent_name.clone(),
            Style::default().fg(FG),
        ),
    ]));

    if !app.config.auth_token.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("  Auth Token: ", Style::default().fg(MUTED)),
            Span::styled(
                mask_secret(&app.config.auth_token),
                Style::default().fg(FG),
            ),
        ]));
    }

    let version_display = if app.manifest_version.is_empty() {
        "local".to_string()
    } else {
        app.manifest_version.clone()
    };
    lines.push(Line::from(vec![
        Span::styled("  Version:    ", Style::default().fg(MUTED)),
        Span::styled(version_display, Style::default().fg(FG)),
    ]));

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  Press 'o' to open in browser, 'q' to quit",
        Style::default().fg(MUTED),
    )));

    let paragraph = Paragraph::new(lines)
        .style(Style::default().bg(BG))
        .block(Block::default().borders(Borders::NONE));

    frame.render_widget(paragraph, area);
}

// ---------- Helpers ----------

fn status_icon_color(status: &ItemStatus) -> (String, Color) {
    match status {
        ItemStatus::Pending => ("\u{25cb}".to_string(), MUTED),      // ○
        ItemStatus::InProgress => ("\u{25cf}".to_string(), INFO),      // ●
        ItemStatus::Done => ("\u{2713}".to_string(), SUCCESS),         // ✓
        ItemStatus::Failed(_) => ("\u{2717}".to_string(), WARNING),    // ✗
        ItemStatus::Skipped => ("\u{2500}".to_string(), MUTED),        // ─
    }
}

fn render_progress_bar(done: usize, total: usize, width: usize) -> Line<'static> {
    let bar_width = width.saturating_sub(4);
    let filled = if total > 0 {
        (done * bar_width) / total
    } else {
        0
    };
    let empty = bar_width.saturating_sub(filled);

    Line::from(vec![
        Span::raw("  ["),
        Span::styled(
            "\u{2588}".repeat(filled),
            Style::default().fg(SUCCESS),
        ),
        Span::styled(
            "\u{2591}".repeat(empty),
            Style::default().fg(MUTED),
        ),
        Span::raw("]"),
    ])
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max.saturating_sub(3)])
    }
}
