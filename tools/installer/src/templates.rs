use std::collections::HashMap;

/// Simple mustache-style template rendering: replaces `{{KEY}}` with values.
pub fn render(template: &str, vars: &HashMap<String, String>) -> String {
    let mut out = template.to_string();
    for (key, val) in vars {
        out = out.replace(&format!("{{{{{}}}}}", key), val);
    }
    out
}

/// Mask a secret value showing only the last 4 characters.
pub fn mask_secret(value: &str) -> String {
    if value.len() <= 4 {
        return "****".to_string();
    }
    format!("****{}", &value[value.len() - 4..])
}

/// Generate a random 32-byte hex auth token.
pub fn generate_auth_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

// --- Embedded templates ---
pub const NAMESPACE_YAML: &str = include_str!("templates/namespace.yaml");
pub const PVCS_YAML: &str = include_str!("templates/pvcs.yaml");
pub const NATS_YAML: &str = include_str!("templates/nats.yaml");
pub const QDRANT_YAML: &str = include_str!("templates/qdrant.yaml");
pub const BRAIN_YAML: &str = include_str!("templates/brain.yaml");
pub const WORKER_YAML: &str = include_str!("templates/worker.yaml");
pub const GATEWAY_YAML: &str = include_str!("templates/gateway.yaml");
pub const UI_YAML: &str = include_str!("templates/ui.yaml");
pub const VOICE_YAML: &str = include_str!("templates/voice.yaml");
pub const SYSADMIN_YAML: &str = include_str!("templates/sysadmin.yaml");
pub const TOOLBOX_YAML: &str = include_str!("templates/toolbox.yaml");
pub const BROWSER_YAML: &str = include_str!("templates/browser.yaml");
pub const NETWORK_POLICIES_YAML: &str = include_str!("templates/network-policies.yaml");
pub const RBAC_YAML: &str = include_str!("templates/rbac.yaml");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_replaces_variables() {
        let vars = HashMap::from([("NAME".into(), "bakerst".into()), ("IMAGE".into(), "brain:1.0".into())]);
        let result = render("namespace: {{NAME}}, image: {{IMAGE}}", &vars);
        assert_eq!(result, "namespace: bakerst, image: brain:1.0");
    }

    #[test]
    fn render_leaves_unknown_variables() {
        let vars = HashMap::from([("NAME".into(), "bakerst".into())]);
        let result = render("{{NAME}} and {{OTHER}}", &vars);
        assert_eq!(result, "bakerst and {{OTHER}}");
    }

    #[test]
    fn mask_secret_shows_last_4() {
        assert_eq!(mask_secret("sk-ant-oat01-abcdefXYZ"), "****fXYZ");
    }

    #[test]
    fn mask_secret_short_value() {
        assert_eq!(mask_secret("abc"), "****");
    }

    #[test]
    fn generate_auth_token_is_64_hex_chars() {
        let token = generate_auth_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
