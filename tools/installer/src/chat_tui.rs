use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::chat_app::{ChatApp, ConnectionStatus, Role};
use crate::theme::{BG, FG, ACCENT, SUCCESS, WARNING, INFO, MUTED};

pub fn render(frame: &mut Frame, app: &ChatApp) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),  // header
            Constraint::Min(5),    // messages
            Constraint::Length(3), // input
            Constraint::Length(1), // status bar
        ])
        .split(frame.area());

    render_header(frame, chunks[0], app);
    render_messages(frame, chunks[1], app);
    render_input(frame, chunks[2], app);
    render_status_bar(frame, chunks[3], app);
}

fn render_header(frame: &mut Frame, area: Rect, app: &ChatApp) {
    let title = match &app.connection {
        ConnectionStatus::Connected { agent_name } => {
            format!(" Baker Street \u{2014} {} ", agent_name)
        }
        ConnectionStatus::Connecting => " Baker Street \u{2014} Connecting... ".to_string(),
        ConnectionStatus::Error(e) => format!(" Baker Street \u{2014} Error: {} ", e),
    };

    let header = Paragraph::new(Line::from(Span::styled(
        title,
        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
    )))
    .block(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(MUTED))
            .style(Style::default().bg(BG)),
    );

    frame.render_widget(header, area);
}

fn render_messages(frame: &mut Frame, area: Rect, app: &ChatApp) {
    let mut lines: Vec<Line> = Vec::new();

    for msg in &app.messages {
        let (prefix, color) = match msg.role {
            Role::User => ("You", INFO),
            Role::Assistant => ("Baker", SUCCESS),
            Role::System => ("", MUTED),
        };

        if msg.role == Role::System {
            lines.push(Line::from(Span::styled(
                format!("  {}", msg.content),
                Style::default().fg(MUTED).add_modifier(Modifier::ITALIC),
            )));
        } else {
            lines.push(Line::from(Span::styled(
                format!("  {}: ", prefix),
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            )));
            for text_line in msg.content.lines() {
                lines.push(Line::from(Span::styled(
                    format!("    {}", text_line),
                    Style::default().fg(FG),
                )));
            }
        }
        lines.push(Line::from(""));
    }

    if app.is_streaming {
        lines.push(Line::from(Span::styled(
            "  \u{25cf} typing...",
            Style::default().fg(WARNING),
        )));
    }

    // Calculate scroll: show the last N lines that fit
    let visible_height = area.height as usize;
    let total_lines = lines.len();
    let skip = if total_lines > visible_height {
        total_lines - visible_height - app.scroll_offset as usize
    } else {
        0
    };

    let paragraph = Paragraph::new(lines)
        .scroll((skip as u16, 0))
        .wrap(Wrap { trim: false })
        .style(Style::default().bg(BG));

    frame.render_widget(paragraph, area);
}

fn render_input(frame: &mut Frame, area: Rect, app: &ChatApp) {
    let input_text = if app.is_streaming {
        "\u{23F3} Waiting for response...".to_string()
    } else {
        app.input.clone()
    };

    let input = Paragraph::new(Line::from(vec![
        Span::styled(" \u{276F} ", Style::default().fg(ACCENT)),
        Span::styled(input_text, Style::default().fg(FG)),
    ]))
    .block(
        Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(MUTED))
            .style(Style::default().bg(BG)),
    );

    frame.render_widget(input, area);

    // Position cursor
    if !app.is_streaming {
        let cursor_x = area.x + 3 + app.cursor_pos as u16;
        let cursor_y = area.y + 1;
        frame.set_cursor_position((cursor_x, cursor_y));
    }
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &ChatApp) {
    let status = if app.is_streaming {
        "Streaming... | Ctrl+C cancel"
    } else {
        "Enter send | Ctrl+C quit | \u{2191}\u{2193} scroll"
    };

    let conv_info = match &app.conversation_id {
        Some(id) => format!("conv: {}...", &id[..8.min(id.len())]),
        None => "new conversation".to_string(),
    };

    let bar = Paragraph::new(Line::from(vec![
        Span::styled(format!("  {} ", status), Style::default().fg(MUTED)),
        Span::styled(
            format!("  {} ", conv_info),
            Style::default().fg(MUTED),
        ),
    ]))
    .style(Style::default().bg(ratatui::style::Color::Rgb(20, 20, 36)));

    frame.render_widget(bar, area);
}
