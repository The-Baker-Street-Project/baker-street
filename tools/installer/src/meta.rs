use anyhow::{Context, Result};
use k8s_openapi::api::core::v1::ConfigMap;
use kube::api::{Api, PatchParams, Patch};
use kube::Client;
use std::collections::BTreeMap;

const CONFIGMAP_NAME: &str = "bakerst-meta";
const PATCH_PARAMS: &str = "bakerst-install";

/// Metadata about the current Baker Street deployment.
#[derive(Debug, Clone)]
pub struct DeployMeta {
    pub version: String,
    pub active_slot: String,
    pub deploy_timestamp: String,
    pub features: String,
    pub components: String,
}

impl Default for DeployMeta {
    fn default() -> Self {
        Self {
            version: String::new(),
            active_slot: "blue".into(),
            deploy_timestamp: String::new(),
            features: String::new(),
            components: String::new(),
        }
    }
}

/// Read the bakerst-meta ConfigMap. Returns None if it doesn't exist.
pub async fn read_meta(client: &Client, namespace: &str) -> Result<Option<DeployMeta>> {
    let api: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
    match api.get_opt(CONFIGMAP_NAME).await? {
        Some(cm) => {
            let data = cm.data.unwrap_or_default();
            Ok(Some(DeployMeta {
                version: data.get("version").cloned().unwrap_or_default(),
                active_slot: data.get("activeSlot").cloned().unwrap_or_else(|| "blue".into()),
                deploy_timestamp: data.get("deployTimestamp").cloned().unwrap_or_default(),
                features: data.get("features").cloned().unwrap_or_default(),
                components: data.get("components").cloned().unwrap_or_default(),
            }))
        }
        None => Ok(None),
    }
}

/// Write (create or update) the bakerst-meta ConfigMap.
pub async fn write_meta(client: &Client, namespace: &str, meta: &DeployMeta) -> Result<()> {
    let mut data = BTreeMap::new();
    data.insert("version".into(), meta.version.clone());
    data.insert("activeSlot".into(), meta.active_slot.clone());
    data.insert("deployTimestamp".into(), meta.deploy_timestamp.clone());
    data.insert("features".into(), meta.features.clone());
    data.insert("components".into(), meta.components.clone());

    let cm = ConfigMap {
        metadata: kube::api::ObjectMeta {
            name: Some(CONFIGMAP_NAME.into()),
            namespace: Some(namespace.into()),
            ..Default::default()
        },
        data: Some(data),
        ..Default::default()
    };

    let api: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
    api.patch(
        CONFIGMAP_NAME,
        &PatchParams::apply(PATCH_PARAMS).force(),
        &Patch::Apply(&cm),
    )
    .await
    .context("write bakerst-meta configmap")?;
    Ok(())
}

/// Build a DeployMeta from current install state.
pub fn build_meta(
    version: &str,
    active_slot: &str,
    features: &[String],
    components: &[String],
) -> DeployMeta {
    let now = chrono_now();
    DeployMeta {
        version: version.into(),
        active_slot: active_slot.into(),
        deploy_timestamp: now,
        features: features.join(","),
        components: components.join(","),
    }
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // Simple ISO-8601-ish timestamp without pulling in chrono
    format!("{}Z", secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_meta_populates_fields() {
        let meta = build_meta("0.2.0", "blue", &["telegram".into()], &["brain".into(), "worker".into()]);
        assert_eq!(meta.version, "0.2.0");
        assert_eq!(meta.active_slot, "blue");
        assert_eq!(meta.features, "telegram");
        assert_eq!(meta.components, "brain,worker");
        assert!(!meta.deploy_timestamp.is_empty());
    }

    #[test]
    fn default_meta_has_blue_slot() {
        let meta = DeployMeta::default();
        assert_eq!(meta.active_slot, "blue");
    }
}
