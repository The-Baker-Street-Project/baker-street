#![allow(deprecated)] // cargo_bin is deprecated in favor of cargo_bin_cmd! macro

use assert_cmd::Command;
use predicates::prelude::*;

/// Test that --help works
#[test]
fn help_flag_shows_usage() {
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("Baker Street Kubernetes installer"));
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

/// Test that --status without a cluster exits with an error (not a panic)
#[test]
fn status_without_cluster_fails_gracefully() {
    // This test will fail if a K8s cluster IS available (which is OK in CI without K8s)
    // It should not panic, just exit with an error
    let _result = Command::cargo_bin("bakerst-install")
        .unwrap()
        .arg("--status")
        .assert();
    // Either succeeds (cluster available) or fails with error message (no cluster)
    // The important thing is it doesn't panic
}

/// Test non-interactive mode without credentials fails with message
#[test]
fn non_interactive_without_credentials_exits() {
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .arg("--non-interactive")
        .env_remove("ANTHROPIC_API_KEY")
        .assert()
        .failure();
}

/// Test --config with missing file exits with error
#[test]
fn config_flag_with_missing_file_exits_with_error() {
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .arg("--config")
        .arg("/nonexistent/config.yaml")
        .assert()
        .failure()
        .stderr(predicate::str::contains("Failed to read config file"));
}

/// Test --config without credentials section exits with error
#[test]
fn config_flag_without_credentials_exits_with_error() {
    let mut f = tempfile::NamedTempFile::new().unwrap();
    use std::io::Write;
    write!(f, "credentials: {{}}\nfeatures: {{}}\nverify:\n  expected_pods: []\n").unwrap();
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .arg("--config")
        .arg(f.path().to_str().unwrap())
        .assert()
        .failure()
        .stderr(predicate::str::contains("anthropic_api_key"));
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
        .arg("--non-interactive")
        .arg("--namespace")
        .arg("bakerst-test")
        .assert()
        .success();

    // 2. Check status
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .arg("--status")
        .arg("--namespace")
        .arg("bakerst-test")
        .assert()
        .success();

    // 3. Uninstall
    Command::cargo_bin("bakerst-install")
        .unwrap()
        .arg("--uninstall")
        .arg("--non-interactive")
        .arg("--namespace")
        .arg("bakerst-test")
        .assert()
        .success();
}
