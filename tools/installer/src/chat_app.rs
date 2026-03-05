use crate::brain_client::StreamEvent;

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    User,
    Assistant,
    System,
}

#[derive(Debug, PartialEq)]
pub enum ConnectionStatus {
    Connecting,
    Connected { agent_name: String },
    Error(String),
}

pub struct ChatApp {
    pub input: String,
    pub cursor_pos: usize,
    pub messages: Vec<ChatMessage>,
    pub scroll_offset: u16,
    pub connection: ConnectionStatus,
    pub conversation_id: Option<String>,
    pub is_streaming: bool,
    pub should_quit: bool,
}

impl ChatApp {
    pub fn new() -> Self {
        Self {
            input: String::new(),
            cursor_pos: 0,
            messages: Vec::new(),
            scroll_offset: 0,
            connection: ConnectionStatus::Connecting,
            conversation_id: None,
            is_streaming: false,
            should_quit: false,
        }
    }

    pub fn add_system_message(&mut self, content: &str) {
        self.messages.push(ChatMessage {
            role: Role::System,
            content: content.to_string(),
        });
    }

    pub fn add_user_message(&mut self, content: &str) {
        self.messages.push(ChatMessage {
            role: Role::User,
            content: content.to_string(),
        });
    }

    pub fn start_assistant_message(&mut self) {
        self.messages.push(ChatMessage {
            role: Role::Assistant,
            content: String::new(),
        });
        self.is_streaming = true;
    }

    pub fn append_to_last(&mut self, text: &str) {
        if let Some(last) = self.messages.last_mut() {
            last.content.push_str(text);
        }
    }

    pub fn handle_stream_event(&mut self, event: StreamEvent) {
        match event {
            StreamEvent::Delta { text } => {
                self.append_to_last(&text);
            }
            StreamEvent::Thinking { tool } => {
                self.append_to_last(&format!("\n[using {}...]\n", tool));
            }
            StreamEvent::ToolResult { tool, summary } => {
                self.append_to_last(&format!("[{}: {}]\n", tool, summary));
            }
            StreamEvent::Done { conversation_id } => {
                self.conversation_id = Some(conversation_id);
                self.is_streaming = false;
            }
            StreamEvent::Error { message } => {
                self.append_to_last(&format!("\n[Error: {}]", message));
                self.is_streaming = false;
            }
        }
        // Auto-scroll to bottom
        self.scroll_offset = 0;
    }

    pub fn insert_char(&mut self, c: char) {
        self.input.insert(self.cursor_pos, c);
        self.cursor_pos += c.len_utf8();
    }

    pub fn delete_char(&mut self) {
        if self.cursor_pos > 0 {
            let prev = self.input[..self.cursor_pos]
                .chars()
                .last()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.input.drain(self.cursor_pos - prev..self.cursor_pos);
            self.cursor_pos -= prev;
        }
    }

    pub fn take_input(&mut self) -> String {
        let input = self.input.clone();
        self.input.clear();
        self.cursor_pos = 0;
        input
    }

    pub fn move_cursor_left(&mut self) {
        if self.cursor_pos > 0 {
            let prev = self.input[..self.cursor_pos]
                .chars()
                .last()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.cursor_pos -= prev;
        }
    }

    pub fn move_cursor_right(&mut self) {
        if self.cursor_pos < self.input.len() {
            let next = self.input[self.cursor_pos..]
                .chars()
                .next()
                .map(|c| c.len_utf8())
                .unwrap_or(0);
            self.cursor_pos += next;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_app_starts_empty() {
        let app = ChatApp::new();
        assert_eq!(app.messages.len(), 0);
        assert_eq!(app.input, "");
        assert_eq!(app.cursor_pos, 0);
        assert!(!app.is_streaming);
        assert!(app.conversation_id.is_none());
    }

    #[test]
    fn insert_and_delete_chars() {
        let mut app = ChatApp::new();
        app.insert_char('H');
        app.insert_char('i');
        assert_eq!(app.input, "Hi");
        assert_eq!(app.cursor_pos, 2);

        app.delete_char();
        assert_eq!(app.input, "H");
        assert_eq!(app.cursor_pos, 1);
    }

    #[test]
    fn cursor_movement() {
        let mut app = ChatApp::new();
        app.insert_char('a');
        app.insert_char('b');
        app.insert_char('c');
        assert_eq!(app.cursor_pos, 3);

        app.move_cursor_left();
        assert_eq!(app.cursor_pos, 2);

        app.move_cursor_left();
        assert_eq!(app.cursor_pos, 1);

        // Can't go past 0
        app.move_cursor_left();
        app.move_cursor_left();
        assert_eq!(app.cursor_pos, 0);

        app.move_cursor_right();
        assert_eq!(app.cursor_pos, 1);
    }

    #[test]
    fn take_input_clears_buffer() {
        let mut app = ChatApp::new();
        app.insert_char('t');
        app.insert_char('e');
        app.insert_char('s');
        app.insert_char('t');

        let taken = app.take_input();
        assert_eq!(taken, "test");
        assert_eq!(app.input, "");
        assert_eq!(app.cursor_pos, 0);
    }

    #[test]
    fn handle_delta_event_appends_text() {
        let mut app = ChatApp::new();
        app.start_assistant_message();
        app.handle_stream_event(StreamEvent::Delta { text: "Hello".to_string() });
        app.handle_stream_event(StreamEvent::Delta { text: " world".to_string() });

        assert_eq!(app.messages.last().unwrap().content, "Hello world");
        assert!(app.is_streaming); // Not done yet
    }

    #[test]
    fn handle_done_event_sets_conversation_id() {
        let mut app = ChatApp::new();
        app.start_assistant_message();
        assert!(app.is_streaming);

        app.handle_stream_event(StreamEvent::Done {
            conversation_id: "conv-123".to_string(),
        });

        assert!(!app.is_streaming);
        assert_eq!(app.conversation_id, Some("conv-123".to_string()));
    }

    #[test]
    fn handle_error_event_stops_streaming() {
        let mut app = ChatApp::new();
        app.start_assistant_message();
        app.handle_stream_event(StreamEvent::Error {
            message: "Rate limited".to_string(),
        });

        assert!(!app.is_streaming);
        assert!(app.messages.last().unwrap().content.contains("Rate limited"));
    }

    #[test]
    fn handle_thinking_and_tool_result() {
        let mut app = ChatApp::new();
        app.start_assistant_message();
        app.handle_stream_event(StreamEvent::Thinking {
            tool: "memory_search".to_string(),
        });
        app.handle_stream_event(StreamEvent::ToolResult {
            tool: "memory_search".to_string(),
            summary: "Found 3".to_string(),
        });

        let content = &app.messages.last().unwrap().content;
        assert!(content.contains("[using memory_search...]"));
        assert!(content.contains("[memory_search: Found 3]"));
    }

    #[test]
    fn unicode_cursor_handling() {
        let mut app = ChatApp::new();
        app.insert_char('\u{00e9}');  // 2-byte UTF-8
        app.insert_char('\u{1f3af}'); // 4-byte UTF-8
        assert_eq!(app.cursor_pos, 6); // 2 + 4

        app.delete_char();
        assert_eq!(app.cursor_pos, 2);
        assert_eq!(app.input, "\u{00e9}");
    }
}
