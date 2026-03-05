use anyhow::{anyhow, Context, Result};
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

const MAX_SSE_LINE_LENGTH: usize = 1_048_576; // 1 MB — prevent memory exhaustion from malformed streams

#[derive(Clone)]
pub struct BrainClient {
    client: Client,
    base_url: String,
    token: String,
}

#[derive(Debug, Deserialize)]
pub struct PingResponse {
    pub status: String,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    message: String,
    #[serde(rename = "conversationId", skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    #[serde(rename = "delta")]
    Delta { text: String },
    #[serde(rename = "thinking")]
    Thinking { tool: String },
    #[serde(rename = "tool_result")]
    ToolResult { tool: String, summary: String },
    #[serde(rename = "done")]
    Done {
        #[serde(rename = "conversationId")]
        conversation_id: String,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

impl BrainClient {
    pub fn new(base_url: &str, token: &str) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
        }
    }

    /// Check connection and get agent name
    pub async fn ping(&self) -> Result<PingResponse> {
        let resp = self
            .client
            .get(format!("{}/api/ping", self.base_url))
            .send()
            .await
            .context("Failed to connect to Brain API")?;
        if !resp.status().is_success() {
            return Err(anyhow!("Brain API returned {}", resp.status()));
        }
        resp.json().await.context("Invalid ping response")
    }

    /// Validate auth token
    pub async fn validate_token(&self) -> Result<bool> {
        let resp = self
            .client
            .get(format!("{}/api/conversations", self.base_url))
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .context("Failed to connect to Brain API")?;
        Ok(resp.status() != reqwest::StatusCode::UNAUTHORIZED)
    }

    /// List recent conversations
    pub async fn list_conversations(&self) -> Result<Vec<Conversation>> {
        let resp = self
            .client
            .get(format!("{}/api/conversations", self.base_url))
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(anyhow!("Failed to list conversations: {}", resp.status()));
        }
        resp.json().await.context("Invalid conversations response")
    }

    /// Send a chat message and stream the response via SSE.
    /// Events are sent through the provided channel.
    pub async fn chat_stream(
        &self,
        message: &str,
        conversation_id: Option<&str>,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<()> {
        let body = ChatRequest {
            message: message.to_string(),
            conversation_id: conversation_id.map(|s| s.to_string()),
        };

        let resp = self
            .client
            .post(format!("{}/api/chat/stream", self.base_url))
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .context("Failed to send chat request")?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(anyhow!("Invalid auth token"));
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("Chat request failed ({}): {}", status, body));
        }

        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("Stream read error")?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // Guard against unbounded buffer growth
            if buffer.len() > MAX_SSE_LINE_LENGTH {
                return Err(anyhow!("SSE line exceeded {} bytes — aborting", MAX_SSE_LINE_LENGTH));
            }

            // Parse SSE lines
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if let Some(data) = line.strip_prefix("data: ") {
                    if let Ok(event) = serde_json::from_str::<StreamEvent>(data) {
                        // If receiver is dropped, stop streaming
                        if tx.send(event).is_err() {
                            return Ok(());
                        }
                    }
                }
            }
        }

        Ok(())
    }
}

/// Parse SSE lines from raw text — used by tests and the streaming client.
pub fn parse_sse_events(raw: &str) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    for line in raw.lines() {
        if let Some(data) = line.strip_prefix("data: ") {
            if let Ok(event) = serde_json::from_str::<StreamEvent>(data) {
                events.push(event);
            }
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_delta_event() {
        let raw = r#"data: {"type":"delta","text":"Hello"}"#;
        let events = parse_sse_events(raw);
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::Delta { text } => assert_eq!(text, "Hello"),
            _ => panic!("Expected Delta event"),
        }
    }

    #[test]
    fn parse_done_event() {
        let raw = r#"data: {"type":"done","conversationId":"abc-123","jobIds":[],"toolCallCount":0}"#;
        let events = parse_sse_events(raw);
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::Done { conversation_id } => assert_eq!(conversation_id, "abc-123"),
            _ => panic!("Expected Done event"),
        }
    }

    #[test]
    fn parse_thinking_event() {
        let raw = r#"data: {"type":"thinking","tool":"memory_search","input":{}}"#;
        let events = parse_sse_events(raw);
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::Thinking { tool } => assert_eq!(tool, "memory_search"),
            _ => panic!("Expected Thinking event"),
        }
    }

    #[test]
    fn parse_multiple_events() {
        let raw = "data: {\"type\":\"delta\",\"text\":\"Hi\"}\ndata: {\"type\":\"delta\",\"text\":\" there\"}\ndata: {\"type\":\"done\",\"conversationId\":\"xyz\",\"jobIds\":[],\"toolCallCount\":0}\n";
        let events = parse_sse_events(raw);
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn skip_malformed_lines() {
        let raw = "data: not-json\ndata: {\"type\":\"delta\",\"text\":\"ok\"}\n: comment line\n\n";
        let events = parse_sse_events(raw);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn parse_error_event() {
        let raw = r#"data: {"type":"error","message":"Rate limited"}"#;
        let events = parse_sse_events(raw);
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::Error { message } => assert_eq!(message, "Rate limited"),
            _ => panic!("Expected Error event"),
        }
    }

    #[test]
    fn parse_tool_result_event() {
        let raw = r#"data: {"type":"tool_result","tool":"memory_search","summary":"Found 3 results"}"#;
        let events = parse_sse_events(raw);
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::ToolResult { tool, summary } => {
                assert_eq!(tool, "memory_search");
                assert_eq!(summary, "Found 3 results");
            }
            _ => panic!("Expected ToolResult event"),
        }
    }
}
