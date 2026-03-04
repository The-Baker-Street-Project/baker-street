use anyhow::Result;

use crate::cli::{Cli, UninstallArgs};
use crate::k8s;

/// Entry point for the `uninstall` subcommand.
pub async fn run(cli: &Cli, args: &UninstallArgs) -> Result<()> {
    println!(
        "Uninstalling Baker Street from namespace '{}'",
        cli.namespace
    );

    if !args.non_interactive {
        print!("Are you sure? This will delete ALL resources. [y/N] ");
        std::io::Write::flush(&mut std::io::stdout())?;
        let mut input = String::new();
        std::io::stdin().read_line(&mut input)?;
        if !input.trim().eq_ignore_ascii_case("y") {
            println!("Cancelled.");
            return Ok(());
        }
    }

    let client = kube::Client::try_default().await?;

    println!("Deleting namespace '{}'...", cli.namespace);
    k8s::delete_namespace(&client, &cli.namespace).await?;

    println!("Deleting namespace 'bakerst-telemetry'...");
    k8s::delete_namespace(&client, "bakerst-telemetry").await?;

    println!("Uninstall complete.");
    Ok(())
}
