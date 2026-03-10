//! Config file tests — will be fully implemented in Task 14.
//!
//! The old tests referenced the v1 ConfigFile API (credentials, features with secrets map,
//! provider validation). The new ConfigFile uses a flat secrets HashMap and feature toggles.
//! Tests for the new format will be added when Task 14 implements the full config_file module.

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
    assert_eq!(config.secrets.get("ANTHROPIC_API_KEY").unwrap(), "sk-ant-test-key");
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
