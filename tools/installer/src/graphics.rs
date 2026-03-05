use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    Frame,
};

use ratatui_image::{picker::Picker, protocol::StatefulProtocol, StatefulImage};

use crate::theme::ACCENT;

// Embedded logo PNG (compile-time inclusion)
const LOGO_BYTES: &[u8] = include_bytes!("../assets/logo.png");

/// Try to create an image protocol for the current terminal.
/// MUST be called BEFORE enable_raw_mode() / EnterAlternateScreen
/// because Picker::from_query_stdio() sends terminal query escape sequences.
/// Returns None if the terminal doesn't support any image protocol.
pub fn create_image_protocol() -> Option<StatefulProtocol> {
    let img = image::load_from_memory(LOGO_BYTES).ok()?;
    let mut picker = Picker::from_query_stdio().ok()?;
    Some(picker.new_resize_protocol(img))
}

/// Render the logo using the image protocol (Kitty/Sixel/halfblock).
pub fn render_logo(frame: &mut Frame, area: Rect, protocol: &mut StatefulProtocol) {
    let image_widget = StatefulImage::new(None);
    frame.render_stateful_widget(image_widget, area, protocol);
}

/// Fallback: render the existing ASCII art "BS" logo.
pub fn render_ascii_logo() -> Vec<Line<'static>> {
    vec![
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
    ]
}
