use bakerst_install::config_schema::ConfigSchema;

fn schema_path() -> std::path::PathBuf {
    // cargo test CWD = crate root (tools/installer)
    std::path::PathBuf::from("../install-template/config-schema.json")
}

#[test]
fn test_parse_actual_schema() {
    let schema = ConfigSchema::from_file(&schema_path()).unwrap();
    assert_eq!(schema.schema_version, 1);
    assert_eq!(schema.defaults.namespace, "bakerst");
    assert!(!schema.secrets.is_empty());
    assert!(!schema.features.is_empty());
}

#[test]
fn test_defaults() {
    let schema = ConfigSchema::from_file(&schema_path()).unwrap();
    assert_eq!(schema.defaults.agent_name, "Baker");
    assert_eq!(schema.defaults.resource_profile.as_deref(), Some("standard"));
}

#[test]
fn test_secrets_by_group() {
    let schema = ConfigSchema::from_file(&schema_path()).unwrap();
    let groups = schema.secrets_by_group();
    assert!(groups.contains_key("providers"), "missing 'providers' group");
    assert!(groups.contains_key("core"), "missing 'core' group");
    assert!(groups.contains_key("memory"), "missing 'memory' group");
}

#[test]
fn test_provider_validation() {
    let schema = ConfigSchema::from_file(&schema_path()).unwrap();
    assert_eq!(schema.provider_validation.require_at_least_one.len(), 3);
    assert!(schema.provider_validation.require_at_least_one.contains(&"ANTHROPIC_API_KEY".to_string()));
    assert!(schema.provider_validation.require_at_least_one.contains(&"OPENAI_API_KEY".to_string()));
    assert!(schema.provider_validation.require_at_least_one.contains(&"OLLAMA_ENDPOINTS".to_string()));
}

#[test]
fn test_feature_with_secrets() {
    let schema = ConfigSchema::from_file(&schema_path()).unwrap();
    let telegram = schema.features.iter().find(|f| f.id == "telegram").unwrap();
    assert_eq!(telegram.name, "Telegram");
    assert!(!telegram.default_enabled);
    assert!(!telegram.secrets.is_empty());
    assert!(telegram.feature_flags.is_some());
}

#[test]
fn test_feature_without_inline_secrets() {
    let schema = ConfigSchema::from_file(&schema_path()).unwrap();
    let voyage = schema.features.iter().find(|f| f.id == "voyage").unwrap();
    assert_eq!(voyage.name, "Long-Term Memory");
    assert!(voyage.default_enabled);
    assert!(voyage.secrets.is_empty());
    assert!(voyage.depends_on.is_some());
}

#[test]
fn test_secret_with_auto_generate() {
    let schema = ConfigSchema::from_file(&schema_path()).unwrap();
    let auth_token = schema.secrets.iter().find(|s| s.key == "AUTH_TOKEN").unwrap();
    assert_eq!(auth_token.auto_generate.as_deref(), Some("hex:32"));
}

#[test]
fn test_secret_with_choices() {
    let schema = ConfigSchema::from_file(&schema_path()).unwrap();
    let default_model = schema.secrets.iter().find(|s| s.key == "DEFAULT_MODEL").unwrap();
    assert!(default_model.choices.is_some());
    let choices = default_model.choices.as_ref().unwrap();
    assert!(choices.len() >= 3);
    assert!(choices.iter().any(|c| c.value.contains("sonnet")));
}

#[test]
fn test_secret_with_depends_on() {
    let schema = ConfigSchema::from_file(&schema_path()).unwrap();
    let default_model = schema.secrets.iter().find(|s| s.key == "DEFAULT_MODEL").unwrap();
    assert!(default_model.depends_on.is_some());
    let deps = default_model.depends_on.as_ref().unwrap();
    assert!(deps.contains(&"ANTHROPIC_API_KEY".to_string()));
}

#[test]
fn test_secret_key_mapping() {
    let schema = ConfigSchema::from_file(&schema_path()).unwrap();
    // Find GOOGLE_CREDENTIAL_FILE in the google-workspace feature
    let google_ws = schema.features.iter().find(|f| f.id == "google-workspace").unwrap();
    let cred_file = google_ws.secrets.iter().find(|s| s.key == "GOOGLE_CREDENTIAL_FILE").unwrap();
    assert!(cred_file.secret_key_mapping.is_some());
    assert_eq!(
        cred_file.secret_key_mapping.as_ref().unwrap().file_basename,
        "google-token.json"
    );
    assert!(cred_file.silent);
}
