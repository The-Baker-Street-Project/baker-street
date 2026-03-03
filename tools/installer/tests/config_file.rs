use std::io::Write;
use tempfile::NamedTempFile;

#[test]
fn parse_minimal_config() {
    let yaml = r#"
credentials:
  anthropic_api_key: "sk-ant-test-key"

features: {}

verify:
  expected_pods:
    - brain
    - worker
    - gateway
    - ui
    - nats
    - qdrant
  chat_prompt: "What are your capabilities?"
  expected_capabilities: []
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();
    let path = f.path().to_str().unwrap();

    let config = bakerst_install::config_file::load_config(path).unwrap();
    assert_eq!(
        config.credentials.anthropic_api_key,
        Some("sk-ant-test-key".into())
    );
    assert_eq!(config.verify.expected_pods.len(), 6);
}

#[test]
fn parse_full_config() {
    let yaml = r#"
credentials:
  anthropic_api_key: "sk-ant-test-key"
  voyage_api_key: "voyage-test-key"

features:
  telegram:
    enabled: true
    secrets:
      TELEGRAM_BOT_TOKEN: "123456:ABC"
  github:
    enabled: true
    secrets:
      GITHUB_TOKEN: "ghp_test123"
  perplexity:
    enabled: true
    secrets:
      PERPLEXITY_API_KEY: "pplx-test"
  browser:
    enabled: true

verify:
  expected_pods:
    - brain
    - worker
    - gateway
    - ui
    - nats
    - qdrant
    - ext-toolbox
    - ext-browser
  chat_prompt: "What tools and capabilities do you have?"
  expected_capabilities:
    - github
    - perplexity
    - browser
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();
    let config =
        bakerst_install::config_file::load_config(f.path().to_str().unwrap()).unwrap();
    assert!(config.features.get("telegram").unwrap().enabled);
    assert_eq!(
        config
            .features
            .get("github")
            .unwrap()
            .secrets
            .get("GITHUB_TOKEN")
            .unwrap(),
        "ghp_test123"
    );
    assert_eq!(config.verify.expected_capabilities.len(), 3);
}

#[test]
fn missing_credentials_section_errors() {
    let yaml = "features: {}\nverify:\n  expected_pods: []\n";
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();
    let result =
        bakerst_install::config_file::load_config(f.path().to_str().unwrap());
    assert!(result.is_err());
}

#[test]
fn openai_only_config_is_valid() {
    let yaml = r#"
credentials:
  openai_api_key: "sk-openai-test"
  default_model: "gpt-4o"

features: {}

verify:
  expected_pods: []
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();
    let config = bakerst_install::config_file::load_config(f.path().to_str().unwrap()).unwrap();
    assert_eq!(config.credentials.openai_api_key, Some("sk-openai-test".into()));
    assert!(config.credentials.anthropic_api_key.is_none());
}

#[test]
fn ollama_only_config_is_valid() {
    let yaml = r#"
credentials:
  ollama_endpoints: "localhost:11434"

features: {}

verify:
  expected_pods: []
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();
    let config = bakerst_install::config_file::load_config(f.path().to_str().unwrap()).unwrap();
    assert_eq!(config.credentials.ollama_endpoints, Some("localhost:11434".into()));
}

#[test]
fn empty_credentials_requires_at_least_one_provider() {
    let yaml = r#"
credentials: {}

features: {}

verify:
  expected_pods: []
"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", yaml).unwrap();
    let result = bakerst_install::config_file::load_config(f.path().to_str().unwrap());
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("at least one provider"), "Error was: {}", err);
}
