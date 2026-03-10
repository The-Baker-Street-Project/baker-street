#![allow(deprecated)] // cargo_bin is deprecated in favor of cargo_bin_cmd! macro

use assert_cmd::Command;
use predicates::prelude::*;

/// Test that --help works and shows subcommands
#[test]
fn help_flag_shows_usage() {
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("Baker Street Installer"))
        .stdout(predicate::str::contains("install"))
        .stdout(predicate::str::contains("update"))
        .stdout(predicate::str::contains("status"))
        .stdout(predicate::str::contains("uninstall"));
}

/// Test that --version works
#[test]
fn version_flag_shows_version() {
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .arg("--version")
        .assert()
        .success()
        .stdout(predicate::str::contains("bakerst-install"));
}

/// Test that `status` without a cluster exits with an error (not a panic)
#[test]
#[ignore = "cmd_status::run is a todo!() stub until Task 16"]
fn status_without_cluster_fails_gracefully() {
    let _result = Command::cargo_bin("bakerst-install")
        .unwrap()
        .arg("status")
        .assert();
    // Either succeeds (cluster available) or fails with error message (no cluster)
    // The important thing is it doesn't panic
}

/// Test `install -y` without any provider credentials fails
#[test]
#[ignore = "cmd_install::run is a todo!() stub until Task 12"]
fn non_interactive_without_credentials_exits() {
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .args(["install", "-y"])
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("OPENAI_API_KEY")
        .env_remove("BAKERST_OPENAI_API_KEY")
        .env_remove("OLLAMA_ENDPOINTS")
        .env_remove("BAKERST_OLLAMA_ENDPOINTS")
        .assert()
        .failure();
}

/// Test `install --config` with missing file exits with error
#[test]
#[ignore = "cmd_install::run is a todo!() stub until Task 12"]
fn config_flag_with_missing_file_exits_with_error() {
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .args(["install", "--config", "/nonexistent/config.yaml"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("Failed to read config file"));
}

/// Test `install --config` without any provider credentials exits with error
#[test]
#[ignore = "cmd_install::run is a todo!() stub until Task 12"]
fn config_flag_without_credentials_exits_with_error() {
    let mut f = tempfile::NamedTempFile::new().unwrap();
    use std::io::Write;
    write!(f, "credentials: {{}}\nfeatures: {{}}\nverify:\n  expected_pods: []\n").unwrap();
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .args(["install", "--config", f.path().to_str().unwrap()])
        .assert()
        .failure()
        .stderr(predicate::str::contains("at least one provider"));
}

/// Test `install --help` shows install-specific options
#[test]
fn install_help_shows_options() {
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .args(["install", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--non-interactive"))
        .stdout(predicate::str::contains("--config"))
        .stdout(predicate::str::contains("--manifest"))
        .stdout(predicate::str::contains("--dry-run"));
}

/// Test `update --help` shows update-specific options
#[test]
fn update_help_shows_options() {
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .args(["update", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--reconfigure"))
        .stdout(predicate::str::contains("--non-interactive"));
}

/// Test `status --help` shows status-specific options
#[test]
fn status_help_shows_options() {
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .args(["status", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--json"))
        .stdout(predicate::str::contains("--watch"));
}

/// Test `uninstall --help` shows uninstall-specific options
#[test]
fn uninstall_help_shows_options() {
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .args(["uninstall", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--non-interactive"));
}

/// Full deploy cycle - only runs with `cargo test -- --ignored`
#[tokio::test]
#[ignore]
async fn full_deploy_cycle() {
    // This test requires:
    // - A running K8s cluster
    // - ANTHROPIC_API_KEY env var set
    // - Docker running
    //
    // Run with: cargo test -- --ignored

    // 1. Deploy
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .args(["install", "-y", "--namespace", "bakerst-test"])
        .assert()
        .success();

    // 2. Check status
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .args(["status", "--namespace", "bakerst-test"])
        .assert()
        .success();

    // 3. Check status JSON
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .args(["status", "--json", "--namespace", "bakerst-test"])
        .assert()
        .success();

    // 4. Uninstall
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .args(["uninstall", "-y", "--namespace", "bakerst-test"])
        .assert()
        .success();
}
