//! Tests for the validation module.
//! Note: tests that hit real APIs are #[ignore] — run with `cargo test -- --ignored`

use bakerst_install::validation;

#[test]
fn rewrite_localhost_to_docker_internal() {
    assert_eq!(
        validation::rewrite_localhost("localhost:11434"),
        "host.docker.internal:11434"
    );
    assert_eq!(
        validation::rewrite_localhost("127.0.0.1:8085"),
        "host.docker.internal:8085"
    );
    assert_eq!(
        validation::rewrite_localhost("http://localhost:11434"),
        "http://host.docker.internal:11434"
    );
}

#[test]
fn rewrite_preserves_non_localhost() {
    assert_eq!(
        validation::rewrite_localhost("192.168.4.42:8085"),
        "192.168.4.42:8085"
    );
    assert_eq!(
        validation::rewrite_localhost("host.docker.internal:11434"),
        "host.docker.internal:11434"
    );
}

#[test]
fn rewrite_multiple_endpoints() {
    let result = validation::rewrite_endpoints("localhost:11434,192.168.4.42:8085");
    assert_eq!(result, "host.docker.internal:11434,192.168.4.42:8085");
}

#[test]
fn parse_ollama_models_response() {
    let json = r#"{
        "models": [
            {"name": "qwen2.5-coder:32b", "size": 19326139392},
            {"name": "llama3.1:8b", "size": 4661224448},
            {"name": "qwen3.5:9b", "size": 5764801536}
        ]
    }"#;
    let models = validation::parse_ollama_models(json).unwrap();
    assert_eq!(models.len(), 3);
    // Should be sorted by size descending
    assert_eq!(models[0].name, "qwen2.5-coder:32b");
    assert_eq!(models[2].name, "llama3.1:8b");
}

#[test]
fn recommend_models_for_roles() {
    let json = r#"{
        "models": [
            {"name": "qwen2.5-coder:32b", "size": 19326139392},
            {"name": "qwen3.5:9b", "size": 5764801536},
            {"name": "llama3.1:8b", "size": 4661224448},
            {"name": "granite3-dense:8b", "size": 4900000000}
        ]
    }"#;
    let models = validation::parse_ollama_models(json).unwrap();
    let recs = validation::recommend_ollama_models(&models);
    // Largest → agent/reflector, smallest viable → worker/observer
    assert_eq!(recs.agent, "qwen2.5-coder:32b");
    assert!(["qwen3.5:9b", "llama3.1:8b", "granite3-dense:8b"].contains(&recs.worker.as_str()));
}

#[test]
fn reject_invalid_endpoint_formats() {
    // SSRF prevention: only host:port allowed, no paths/schemes/queries
    assert!(validation::validate_endpoint_format("http://evil.com/api").is_err());
    assert!(validation::validate_endpoint_format("169.254.169.254/metadata").is_err());
    assert!(validation::validate_endpoint_format("localhost:11434/../../etc/passwd").is_err());
    assert!(validation::validate_endpoint_format("host:port:extra").is_err());
    // Valid formats
    assert!(validation::validate_endpoint_format("localhost:11434").is_ok());
    assert!(validation::validate_endpoint_format("host.docker.internal:8085").is_ok());
    assert!(validation::validate_endpoint_format("192.168.4.42:11434").is_ok());
}

#[tokio::test]
#[ignore] // Requires real Anthropic API key
async fn validate_anthropic_key_real() {
    let key = std::env::var("ANTHROPIC_API_KEY").unwrap();
    assert!(validation::validate_anthropic_key(&key).await.is_ok());
}

#[tokio::test]
async fn validate_anthropic_key_bad() {
    let result = validation::validate_anthropic_key("sk-bad-key-12345").await;
    assert!(result.is_err());
}

#[tokio::test]
#[ignore] // Requires Ollama running
async fn validate_ollama_endpoint_real() {
    let result = validation::validate_ollama_endpoint("localhost:11434").await;
    assert!(result.is_ok());
}
