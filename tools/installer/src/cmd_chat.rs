use anyhow::{anyhow, Result};
use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::{backend::CrosstermBackend, Terminal};
use std::io::stdout;
use tokio::sync::mpsc;

use crate::brain_client::{BrainClient, StreamEvent};
use crate::chat_app::ChatApp;
use crate::chat_tui;
use crate::cli::{Cli, ChatArgs};

enum AsyncMsg {
    StreamEvent(StreamEvent),
    StreamDone,
    StreamError(String),
    Connected { agent_name: String },
    ConnectError(String),
}

/// Resolve auth token from known locations (in priority order).
fn resolve_token(args: &ChatArgs) -> Result<String> {
    // 1. --token flag or AUTH_TOKEN env var (handled by clap)
    if let Some(t) = &args.token {
        return Ok(t.clone());
    }

    // 2. $HOME/.env-secrets
    if let Ok(home) = std::env::var("HOME") {
        let home_path = std::path::Path::new(&home).join(".env-secrets");
        if let Some(token) = read_token_from_file(&home_path) {
            eprintln!("Using token from {}", home_path.display());
            return Ok(token);
        }
    }

    // 3. ./.env-secrets (current directory — last resort)
    let cwd_path = std::path::Path::new(".env-secrets");
    if let Some(token) = read_token_from_file(cwd_path) {
        eprintln!("Using token from ./.env-secrets");
        return Ok(token);
    }

    Err(anyhow!(
        "No auth token found. Provide via:\n  \
         - AUTH_TOKEN environment variable\n  \
         - --token flag (dev only — visible in process list)\n  \
         - $HOME/.env-secrets file\n  \
         - ./.env-secrets file"
    ))
}

fn read_token_from_file(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path).ok().and_then(|contents| {
        contents.lines().find_map(|line| {
            let line = line.trim();
            if line.starts_with("AUTH_TOKEN=") {
                let val = line.trim_start_matches("AUTH_TOKEN=").trim().to_string();
                if !val.is_empty() { Some(val) } else { None }
            } else {
                None
            }
        })
    })
}

pub async fn run(_cli: &Cli, args: &ChatArgs) -> Result<()> {
    let token = resolve_token(args)?;

    // Warn if connecting to non-localhost over HTTP
    if !args.server.contains("localhost") && !args.server.contains("127.0.0.1") && args.server.starts_with("http://") {
        eprintln!("WARNING: Sending auth token over unencrypted HTTP to {}. Consider using HTTPS.", args.server);
    }

    let client = BrainClient::new(&args.server, &token);

    // Initialize TUI
    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout());
    let mut terminal = Terminal::new(backend)?;

    let mut app = ChatApp::new();

    // Async message channel
    let (tx, mut rx) = mpsc::unbounded_channel::<AsyncMsg>();

    // Connect to brain in background
    let connect_client = client.clone();
    let connect_tx = tx.clone();
    tokio::spawn(async move {
        match connect_client.ping().await {
            Ok(ping) => {
                let name = ping.name.unwrap_or_else(|| "Baker".to_string());
                match connect_client.validate_token().await {
                    Ok(true) => {
                        let _ = connect_tx.send(AsyncMsg::Connected { agent_name: name });
                    }
                    Ok(false) => {
                        let _ = connect_tx.send(AsyncMsg::ConnectError(
                            "Invalid auth token".to_string(),
                        ));
                    }
                    Err(e) => {
                        let _ = connect_tx.send(AsyncMsg::ConnectError(format!("{}", e)));
                    }
                }
            }
            Err(e) => {
                let _ = connect_tx.send(AsyncMsg::ConnectError(format!("{}", e)));
            }
        }
    });

    // Set initial conversation if provided
    if let Some(conv_id) = &args.conversation {
        app.conversation_id = Some(conv_id.clone());
        app.add_system_message(&format!("Continuing conversation {}...", &conv_id[..8.min(conv_id.len())]));
    }

    // Main event loop
    let result = run_event_loop(&mut terminal, &mut app, &client, &tx, &mut rx).await;

    // Cleanup (always runs)
    disable_raw_mode()?;
    stdout().execute(LeaveAlternateScreen)?;

    result
}

async fn run_event_loop(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    app: &mut ChatApp,
    client: &BrainClient,
    tx: &mpsc::UnboundedSender<AsyncMsg>,
    rx: &mut mpsc::UnboundedReceiver<AsyncMsg>,
) -> Result<()> {
    loop {
        // Draw
        terminal.draw(|frame| chat_tui::render(frame, app))?;

        // Drain async messages
        while let Ok(msg) = rx.try_recv() {
            match msg {
                AsyncMsg::Connected { agent_name } => {
                    app.connection = crate::chat_app::ConnectionStatus::Connected {
                        agent_name: agent_name.clone(),
                    };
                    app.add_system_message(&format!("Connected to {}. Type a message to begin.", agent_name));
                }
                AsyncMsg::ConnectError(e) => {
                    app.connection = crate::chat_app::ConnectionStatus::Error(e.clone());
                    app.add_system_message(&format!("Connection failed: {}", e));
                }
                AsyncMsg::StreamEvent(event) => {
                    app.handle_stream_event(event);
                }
                AsyncMsg::StreamDone => {
                    app.is_streaming = false;
                }
                AsyncMsg::StreamError(e) => {
                    app.is_streaming = false;
                    app.add_system_message(&format!("Error: {}", e));
                }
            }
        }

        if app.should_quit {
            break;
        }

        // Poll for keyboard input (50ms timeout)
        if event::poll(std::time::Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                match (key.code, key.modifiers) {
                    // Ctrl+C: quit (or cancel stream)
                    (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                        if app.is_streaming {
                            app.is_streaming = false;
                            app.add_system_message("Stream cancelled.");
                        } else {
                            app.should_quit = true;
                        }
                    }
                    // Enter: send message
                    (KeyCode::Enter, _) if !app.is_streaming => {
                        let input = app.take_input();
                        let trimmed = input.trim().to_string();
                        if trimmed.is_empty() {
                            continue;
                        }

                        // Handle /quit command
                        if trimmed == "/quit" || trimmed == "/exit" {
                            app.should_quit = true;
                            continue;
                        }

                        // Handle /new command
                        if trimmed == "/new" {
                            app.conversation_id = None;
                            app.messages.clear();
                            app.add_system_message("Started new conversation.");
                            continue;
                        }

                        app.add_user_message(&trimmed);
                        app.start_assistant_message();

                        // Send to brain in background — uses channel (Send-safe)
                        let stream_client = client.clone();
                        let conv_id = app.conversation_id.clone();
                        let event_tx = tx.clone();
                        let (stream_tx, mut stream_rx) = mpsc::unbounded_channel::<StreamEvent>();
                        let done_tx = event_tx.clone();

                        // Spawn the HTTP stream
                        let msg = trimmed.clone();
                        tokio::spawn(async move {
                            let result = stream_client
                                .chat_stream(&msg, conv_id.as_deref(), stream_tx)
                                .await;
                            match result {
                                Ok(()) => { let _ = done_tx.send(AsyncMsg::StreamDone); }
                                Err(e) => {
                                    let _ = done_tx.send(AsyncMsg::StreamError(format!("{}", e)));
                                }
                            }
                        });

                        // Spawn a forwarder that relays StreamEvents to the main AsyncMsg channel
                        let forward_tx = tx.clone();
                        tokio::spawn(async move {
                            while let Some(event) = stream_rx.recv().await {
                                if forward_tx.send(AsyncMsg::StreamEvent(event)).is_err() {
                                    break;
                                }
                            }
                        });
                    }
                    // Text input
                    (KeyCode::Char(c), _) if !app.is_streaming => {
                        app.insert_char(c);
                    }
                    (KeyCode::Backspace, _) if !app.is_streaming => {
                        app.delete_char();
                    }
                    (KeyCode::Left, _) => {
                        app.move_cursor_left();
                    }
                    (KeyCode::Right, _) => {
                        app.move_cursor_right();
                    }
                    // Scroll
                    (KeyCode::Up, _) if !app.is_streaming => {
                        app.scroll_offset = app.scroll_offset.saturating_add(1);
                    }
                    (KeyCode::Down, _) if !app.is_streaming => {
                        app.scroll_offset = app.scroll_offset.saturating_sub(1);
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(())
}
