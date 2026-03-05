use anyhow::Result;
use crate::cli::{Cli, ChatArgs};

pub async fn run(_cli: &Cli, args: &ChatArgs) -> Result<()> {
    println!("Baker Street Chat");
    println!("Server: {}", args.server);
    println!("Token: {}", if args.token.is_some() { "provided" } else { "not set (use AUTH_TOKEN env or .env-secrets)" });
    println!("(Chat TUI coming in next tasks...)");
    Ok(())
}
