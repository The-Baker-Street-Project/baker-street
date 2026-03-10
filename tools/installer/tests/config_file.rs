//! Config file tests — covers parsing, env var resolution, and new fields.

use std::io::Write;
use tempfile::NamedTempFile;

#[test]
fn parse_minimal_config() {
    let yaml = r#"
namespace: bakerst
secrets:
  ANTHROPIC_API_KEY: "sk-ant-test-key"
features:
  telegram: false
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();

    let config = bakerst_install::config_file::load_config(f.path()).unwrap();
    assert_eq!(
        config.secrets.get("ANTHROPIC_API_KEY").unwrap(),
        "sk-ant-test-key"
    );
    assert_eq!(config.namespace, Some("bakerst".to_string()));
}

#[test]
fn parse_config_with_features() {
    let yaml = r#"
secrets:
  ANTHROPIC_API_KEY: "sk-ant-test-key"
features:
  telegram: true
  github: false
  voice: false
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();

    let config = bakerst_install::config_file::load_config(f.path()).unwrap();
    assert_eq!(config.features.get("telegram"), Some(&true));
    assert_eq!(config.features.get("github"), Some(&false));
}

#[test]
fn empty_config_parses_with_defaults() {
    let yaml = "{}";
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();

    let config = bakerst_install::config_file::load_config(f.path()).unwrap();
    assert!(config.secrets.is_empty());
    assert!(config.features.is_empty());
    assert!(config.namespace.is_none());
}

#[test]
fn parse_agent_name() {
    let yaml = r#"
agentName: Sherlock
namespace: bakerst
secrets: {}
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();

    let config = bakerst_install::config_file::load_config(f.path()).unwrap();
    assert_eq!(config.agent_name, Some("Sherlock".to_string()));
}

#[test]
fn parse_verify_config() {
    let yaml = r#"
secrets:
  ANTHROPIC_API_KEY: "test"
verify:
  expectedPods:
    - brain-blue
    - worker
    - nats
  chatPrompt: "Say hello"
  timeoutSeconds: 120
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();

    let config = bakerst_install::config_file::load_config(f.path()).unwrap();
    let verify = config.verify.unwrap();
    assert_eq!(verify.expected_pods, vec!["brain-blue", "worker", "nats"]);
    assert_eq!(verify.chat_prompt.unwrap(), "Say hello");
    assert_eq!(verify.timeout_seconds.unwrap(), 120);
}

#[test]
fn env_var_resolution_in_secrets() {
    std::env::set_var("BAKERST_TEST_API_KEY", "sk-resolved-key");
    let yaml = r#"
secrets:
  ANTHROPIC_API_KEY: "${BAKERST_TEST_API_KEY}"
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();

    let config = bakerst_install::config_file::load_config(f.path()).unwrap();
    assert_eq!(
        config.secrets.get("ANTHROPIC_API_KEY").unwrap(),
        "sk-resolved-key"
    );
    std::env::remove_var("BAKERST_TEST_API_KEY");
}

#[test]
fn env_var_missing_resolves_to_empty() {
    std::env::remove_var("BAKERST_MISSING_VAR_XYZ");
    let yaml = r#"
secrets:
  SOME_KEY: "${BAKERST_MISSING_VAR_XYZ}"
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();

    let config = bakerst_install::config_file::load_config(f.path()).unwrap();
    assert_eq!(config.secrets.get("SOME_KEY").unwrap(), "");
}

#[test]
fn nonexistent_file_returns_error() {
    let result =
        bakerst_install::config_file::load_config(std::path::Path::new("/nonexistent/path.yaml"));
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Failed to read config file"));
}

#[test]
fn invalid_yaml_returns_error() {
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{{{{not valid yaml").unwrap();

    let result = bakerst_install::config_file::load_config(f.path());
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Failed to parse config YAML"));
}

#[test]
fn full_config_round_trip() {
    let yaml = r#"
version: "0.6.0"
namespace: bakerst
agentName: Baker
secrets:
  ANTHROPIC_API_KEY: "sk-ant-key"
  AUTH_TOKEN: auto
  AGENT_NAME: Baker
features:
  telegram: false
  discord: false
  github: true
verify:
  expectedPods:
    - brain-blue
    - worker
    - ui
    - nats
  chatPrompt: "Respond with exactly: ACCEPTANCE_TEST_PASSED"
  timeoutSeconds: 180
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();

    let config = bakerst_install::config_file::load_config(f.path()).unwrap();
    assert_eq!(config.version, Some("0.6.0".to_string()));
    assert_eq!(config.namespace, Some("bakerst".to_string()));
    assert_eq!(config.agent_name, Some("Baker".to_string()));
    assert_eq!(config.secrets.len(), 3);
    assert_eq!(config.features.get("github"), Some(&true));
    assert_eq!(config.features.get("telegram"), Some(&false));
    let verify = config.verify.unwrap();
    assert_eq!(verify.expected_pods.len(), 4);
    assert_eq!(verify.timeout_seconds, Some(180));
}
