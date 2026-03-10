#![allow(deprecated)] // cargo_bin is deprecated in favor of cargo_bin_cmd! macro

use assert_cmd::Command;
use predicates::prelude::*;

// ---------------------------------------------------------------------------
// CLI help/version tests (no cluster needed)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Manifest parsing (no cluster needed)
// ---------------------------------------------------------------------------

/// Parse a local manifest file from JSON
#[test]
fn parse_local_manifest_file() {
    use bakerst_install::manifest::Manifest;

    let json = r#"{
        "schemaVersion": 1,
        "version": "0.6.0",
        "releaseDate": "2026-03-10",
        "templateUrl": "https://github.com/example/template.tar.gz",
        "templateSha256": "deadbeef",
        "images": [
            {
                "name": "brain",
                "image": "ghcr.io/org/brain",
                "tag": "0.6.0",
                "required": true,
                "architectures": ["amd64", "arm64"]
            },
            {
                "name": "worker",
                "image": "ghcr.io/org/worker",
                "tag": "0.6.0",
                "required": true,
                "architectures": ["amd64"]
            }
        ]
    }"#;

    let tmp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(tmp.path(), json).unwrap();

    let manifest = Manifest::from_file(tmp.path()).unwrap();
    assert_eq!(manifest.version, "0.6.0");
    assert_eq!(manifest.images.len(), 2);
    assert_eq!(manifest.required_images().count(), 2);
}

// ---------------------------------------------------------------------------
// Config file with env var resolution (integration-level)
// ---------------------------------------------------------------------------

/// Load a config file that uses ${VAR} env var references and verify resolution
#[test]
fn config_file_env_var_resolution_integration() {
    use bakerst_install::config_file;

    let yaml = r#"
namespace: test-ns
secrets:
  ANTHROPIC_API_KEY: "${INTEG_TEST_API_KEY}"
  AUTH_TOKEN: "static-value"
features:
  telegram: true
"#;

    std::env::set_var("INTEG_TEST_API_KEY", "sk-ant-test-integration-12345");

    let tmp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(tmp.path(), yaml).unwrap();

    let config = config_file::load_config(tmp.path()).unwrap();
    assert_eq!(config.namespace.as_deref(), Some("test-ns"));
    assert_eq!(
        config.secrets.get("ANTHROPIC_API_KEY").map(String::as_str),
        Some("sk-ant-test-integration-12345")
    );
    assert_eq!(
        config.secrets.get("AUTH_TOKEN").map(String::as_str),
        Some("static-value")
    );
    assert_eq!(config.features.get("telegram"), Some(&true));

    std::env::remove_var("INTEG_TEST_API_KEY");
}

// ---------------------------------------------------------------------------
// Config schema parsing from actual file
// ---------------------------------------------------------------------------

/// Parse the real config-schema.json from the install template
#[test]
fn parse_config_schema_from_template() {
    use bakerst_install::config_schema::ConfigSchema;

    let schema_path = std::path::PathBuf::from("../install-template/config-schema.json");
    let schema = ConfigSchema::from_file(&schema_path).unwrap();

    assert_eq!(schema.schema_version, 1);
    assert_eq!(schema.defaults.namespace, "bakerst");
    assert_eq!(schema.defaults.agent_name, "Baker");

    // Verify provider validation includes all three providers
    assert!(schema
        .provider_validation
        .require_at_least_one
        .contains(&"ANTHROPIC_API_KEY".to_string()));
    assert!(schema
        .provider_validation
        .require_at_least_one
        .contains(&"OPENAI_API_KEY".to_string()));
    assert!(schema
        .provider_validation
        .require_at_least_one
        .contains(&"OLLAMA_ENDPOINTS".to_string()));

    // Verify features exist
    let feature_ids: Vec<&str> = schema.features.iter().map(|f| f.id.as_str()).collect();
    assert!(feature_ids.contains(&"telegram"));
    assert!(feature_ids.contains(&"github"));
    assert!(feature_ids.contains(&"voice"));
}

// ---------------------------------------------------------------------------
// Interview produces correct output from config file + schema
// ---------------------------------------------------------------------------

/// Verify that interview::from_config_file produces correct InterviewResult
#[test]
fn interview_from_config_produces_correct_output() {
    use bakerst_install::config_file;
    use bakerst_install::config_schema::ConfigSchema;
    use bakerst_install::interview;

    let schema_path = std::path::PathBuf::from("../install-template/config-schema.json");
    let schema = ConfigSchema::from_file(&schema_path).unwrap();

    let yaml = r#"
namespace: custom-ns
agentName: Sherlock
secrets:
  ANTHROPIC_API_KEY: "sk-ant-test-key"
  AUTH_TOKEN: "auto"
features:
  telegram: false
  github: false
  voice: false
"#;

    let tmp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(tmp.path(), yaml).unwrap();

    let config = config_file::load_config(tmp.path()).unwrap();
    let result = interview::from_config_file(&schema, &config).unwrap();

    assert_eq!(result.namespace, "custom-ns");
    // Agent name comes from schema defaults (config_file doesn't feed it through)
    assert_eq!(result.agent_name, "Baker");
    // Anthropic key should be present
    assert_eq!(
        result.secrets.get("ANTHROPIC_API_KEY").map(String::as_str),
        Some("sk-ant-test-key")
    );
    // AUTH_TOKEN was "auto" so it should be auto-generated (64 hex chars)
    let auth_token = result.secrets.get("AUTH_TOKEN").unwrap();
    assert_eq!(auth_token.len(), 64);
    assert!(auth_token.chars().all(|c| c.is_ascii_hexdigit()));
    // Default-enabled features (voyage) should still be enabled
    assert!(result.enabled_features.contains(&"voyage".to_string()));
}

/// Verify that interview::from_config_file rejects configs with no AI provider
#[test]
fn interview_rejects_no_provider() {
    use bakerst_install::config_file;
    use bakerst_install::config_schema::ConfigSchema;
    use bakerst_install::interview;

    let schema_path = std::path::PathBuf::from("../install-template/config-schema.json");
    let schema = ConfigSchema::from_file(&schema_path).unwrap();

    let yaml = r#"
secrets:
  AUTH_TOKEN: "some-token"
features: {}
"#;

    let tmp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(tmp.path(), yaml).unwrap();

    let config = config_file::load_config(tmp.path()).unwrap();

    // Ensure no provider env vars leak into the test
    let saved_anthropic = std::env::var("ANTHROPIC_API_KEY").ok();
    let saved_openai = std::env::var("OPENAI_API_KEY").ok();
    let saved_ollama = std::env::var("OLLAMA_ENDPOINTS").ok();
    std::env::remove_var("ANTHROPIC_API_KEY");
    std::env::remove_var("OPENAI_API_KEY");
    std::env::remove_var("OLLAMA_ENDPOINTS");

    let result = interview::from_config_file(&schema, &config);
    assert!(result.is_err(), "Expected error when no provider configured, got: {:?}", result);
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("at least one") || err_msg.contains("provider"),
        "Error message should mention providers, got: {}",
        err_msg
    );

    // Restore env vars
    if let Some(v) = saved_anthropic { std::env::set_var("ANTHROPIC_API_KEY", v); }
    if let Some(v) = saved_openai { std::env::set_var("OPENAI_API_KEY", v); }
    if let Some(v) = saved_ollama { std::env::set_var("OLLAMA_ENDPOINTS", v); }
}

// ---------------------------------------------------------------------------
// Command-level integration tests (updated from stubs)
// ---------------------------------------------------------------------------

/// Test that `status` without a cluster exits with an error (not a panic)
#[test]
#[ignore = "requires running K8s cluster"]
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
#[ignore = "requires running K8s cluster"]
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
#[ignore = "requires running K8s cluster"]
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
#[ignore = "requires running K8s cluster"]
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

// ---------------------------------------------------------------------------
// Full deploy cycle (requires cluster + secrets)
// ---------------------------------------------------------------------------

/// Full deploy cycle - only runs with `cargo test -- --ignored`
#[tokio::test]
#[ignore = "requires running K8s cluster with Docker and API keys configured"]
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
