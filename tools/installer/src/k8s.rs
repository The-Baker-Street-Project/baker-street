use anyhow::{Context, Result};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{
    ConfigMap, Namespace, PersistentVolumeClaim, Secret, Service, ServiceAccount,
};
use k8s_openapi::api::networking::v1::NetworkPolicy;
use k8s_openapi::api::rbac::v1::{Role, RoleBinding};
use kube::api::{Api, DeleteParams, ListParams, Patch, PatchParams};
use kube::Client;
use std::collections::BTreeMap;

const PATCH_PARAMS: &str = "bakerst-install";

/// Check if the K8s cluster is reachable. Returns the server version string.
pub async fn check_cluster() -> Result<String> {
    let client = Client::try_default().await?;
    let ver = client.apiserver_version().await?;
    Ok(format!("{}.{}", ver.major, ver.minor))
}

/// Create a namespace (idempotent).
pub async fn create_namespace(client: &Client, name: &str) -> Result<()> {
    let api: Api<Namespace> = Api::all(client.clone());
    let ns: Namespace = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": { "name": name }
    }))?;
    api.patch(name, &PatchParams::apply(PATCH_PARAMS), &Patch::Apply(&ns))
        .await
        .context("create namespace")?;
    Ok(())
}

/// Apply a YAML document containing one or more K8s resources.
/// Parses multi-document YAML (separated by ---) and applies each.
pub async fn apply_yaml(client: &Client, namespace: &str, yaml: &str) -> Result<Vec<String>> {
    let mut applied = Vec::new();
    for doc in yaml.split("\n---") {
        // Strip leading comment lines (e.g. "# Brain ServiceAccount + Role")
        // but keep the YAML content that follows
        let doc: String = doc
            .lines()
            .skip_while(|line| {
                let trimmed = line.trim();
                trimmed.is_empty() || trimmed.starts_with('#')
            })
            .collect::<Vec<_>>()
            .join("\n");
        let doc = doc.trim();
        if doc.is_empty() {
            continue;
        }
        let resource: serde_json::Value =
            serde_yaml::from_str(doc).context("parse YAML document")?;
        let kind = resource["kind"].as_str().unwrap_or("Unknown");
        let name = resource["metadata"]["name"].as_str().unwrap_or("unnamed");
        let label = format!("{}/{}", kind, name);

        apply_resource(client, namespace, &resource)
            .await
            .with_context(|| format!("apply {}", label))?;
        applied.push(label);
    }
    Ok(applied)
}

/// Apply a single parsed K8s resource using server-side apply.
async fn apply_resource(
    client: &Client,
    namespace: &str,
    resource: &serde_json::Value,
) -> Result<()> {
    let kind = resource["kind"].as_str().unwrap_or("");
    let name = resource["metadata"]["name"].as_str().unwrap_or("");
    let pp = PatchParams::apply(PATCH_PARAMS).force();

    match kind {
        "Namespace" => {
            let api: Api<Namespace> = Api::all(client.clone());
            let obj: Namespace = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
            let obj: Deployment = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "Service" => {
            let api: Api<Service> = Api::namespaced(client.clone(), namespace);
            let obj: Service = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "ConfigMap" => {
            let api: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
            let obj: ConfigMap = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "Secret" => {
            let api: Api<Secret> = Api::namespaced(client.clone(), namespace);
            let obj: Secret = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "PersistentVolumeClaim" => {
            let api: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), namespace);
            let obj: PersistentVolumeClaim = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "ServiceAccount" => {
            let api: Api<ServiceAccount> = Api::namespaced(client.clone(), namespace);
            let obj: ServiceAccount = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "Role" => {
            let api: Api<Role> = Api::namespaced(client.clone(), namespace);
            let obj: Role = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "RoleBinding" => {
            let api: Api<RoleBinding> = Api::namespaced(client.clone(), namespace);
            let obj: RoleBinding = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        "NetworkPolicy" => {
            let api: Api<NetworkPolicy> = Api::namespaced(client.clone(), namespace);
            let obj: NetworkPolicy = serde_json::from_value(resource.clone())?;
            api.patch(name, &pp, &Patch::Apply(&obj)).await?;
        }
        _ => anyhow::bail!("unsupported resource kind: {}", kind),
    }
    Ok(())
}

/// Create a K8s Secret from key-value pairs (values are base64-encoded automatically).
pub async fn create_secret(
    client: &Client,
    namespace: &str,
    name: &str,
    data: &BTreeMap<String, String>,
) -> Result<()> {
    let encoded: BTreeMap<String, k8s_openapi::ByteString> = data
        .iter()
        .map(|(k, v)| (k.clone(), k8s_openapi::ByteString(v.as_bytes().to_vec())))
        .collect();

    let secret = Secret {
        metadata: kube::api::ObjectMeta {
            name: Some(name.into()),
            namespace: Some(namespace.into()),
            ..Default::default()
        },
        data: Some(encoded),
        ..Default::default()
    };

    let api: Api<Secret> = Api::namespaced(client.clone(), namespace);
    api.patch(
        name,
        &PatchParams::apply(PATCH_PARAMS).force(),
        &Patch::Apply(&secret),
    )
    .await
    .context("create secret")?;
    Ok(())
}

/// Create the bakerst-os ConfigMap from operating system files.
pub async fn create_os_configmap(client: &Client, namespace: &str) -> Result<()> {
    let mut data = BTreeMap::new();
    data.insert(
        "BRAIN.md".into(),
        include_str!("os_files/BRAIN.md").into(),
    );
    data.insert(
        "WORKER.md".into(),
        include_str!("os_files/WORKER.md").into(),
    );
    data.insert(
        "SOUL.md".into(),
        include_str!("os_files/SOUL.md").into(),
    );
    data.insert(
        "PLUGINS.json".into(),
        include_str!("os_files/PLUGINS.json").into(),
    );
    data.insert(
        "CRONS.json".into(),
        include_str!("os_files/CRONS.json").into(),
    );
    data.insert(
        "TRIGGERS.json".into(),
        include_str!("os_files/TRIGGERS.json").into(),
    );
    data.insert(
        "prompts.json".into(),
        include_str!("os_files/prompts.json").into(),
    );

    let cm = ConfigMap {
        metadata: kube::api::ObjectMeta {
            name: Some("bakerst-os".into()),
            namespace: Some(namespace.into()),
            ..Default::default()
        },
        data: Some(data),
        ..Default::default()
    };

    let api: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
    api.patch(
        "bakerst-os",
        &PatchParams::apply(PATCH_PARAMS).force(),
        &Patch::Apply(&cm),
    )
    .await
    .context("create bakerst-os configmap")?;
    Ok(())
}

/// Restart a deployment by patching the pod template annotation (equivalent to `kubectl rollout restart`).
pub async fn restart_deployment(client: &Client, namespace: &str, name: &str) -> Result<()> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();
    let patch = serde_json::json!({
        "spec": { "template": { "metadata": { "annotations": {
            "kubectl.kubernetes.io/restartedAt": now
        }}}}
    });
    api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .with_context(|| format!("restart deployment {}", name))?;
    Ok(())
}

/// Delete a single deployment (idempotent — ignores "not found").
pub async fn delete_deployment(client: &Client, namespace: &str, name: &str) -> Result<()> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    api.delete(name, &DeleteParams::default()).await.ok();
    Ok(())
}

/// Delete a namespace (cascades to all resources within).
pub async fn delete_namespace(client: &Client, name: &str) -> Result<()> {
    let api: Api<Namespace> = Api::all(client.clone());
    api.delete(name, &DeleteParams::default()).await.ok();
    Ok(())
}

/// Status of a single deployment (for --status output).
pub struct DeploymentStatus {
    pub name: String,
    pub desired: i32,
    pub ready: i32,
    pub image: String,
}

/// List all deployments in a namespace with their status.
pub async fn get_deployments_status(
    client: &Client,
    namespace: &str,
) -> Result<Vec<DeploymentStatus>> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let lp = ListParams::default();
    let deployments = api.list(&lp).await?;

    let mut statuses = Vec::new();
    for deploy in deployments.items {
        let name = deploy.metadata.name.unwrap_or_default();
        let status = deploy.status.as_ref();
        let desired = status.and_then(|s| s.replicas).unwrap_or(0);
        let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);
        let image = deploy
            .spec
            .and_then(|s| {
                s.template
                    .spec
                    .and_then(|s| s.containers.first().map(|c| c.image.clone().unwrap_or_default()))
            })
            .unwrap_or_default();

        statuses.push(DeploymentStatus {
            name,
            desired,
            ready,
            image,
        });
    }
    Ok(statuses)
}

/// Scale a deployment to N replicas.
pub async fn scale_deployment(
    client: &Client,
    namespace: &str,
    name: &str,
    replicas: i32,
) -> Result<()> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let patch = serde_json::json!({
        "spec": { "replicas": replicas }
    });
    api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .with_context(|| format!("scale deployment {} to {}", name, replicas))?;
    Ok(())
}

/// Patch brain Service selector to point to a slot ("blue" or "green").
pub async fn patch_brain_service_selector(
    client: &Client,
    namespace: &str,
    slot: &str,
) -> Result<()> {
    let api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let patch = serde_json::json!({
        "spec": {
            "selector": {
                "app": format!("brain-{}", slot)
            }
        }
    });
    api.patch("brain", &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .context("patch brain service selector")?;
    Ok(())
}

/// Read current brain Service selector slot (returns "blue" or "green").
pub async fn get_brain_service_selector(
    client: &Client,
    namespace: &str,
) -> Result<String> {
    let api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let svc = api.get("brain").await.context("get brain service")?;
    let selector = svc
        .spec
        .and_then(|s| s.selector)
        .unwrap_or_default();
    let app = selector.get("app").cloned().unwrap_or_else(|| "brain-blue".into());
    // Extract slot from "brain-blue" or "brain-green"
    let slot = app.strip_prefix("brain-").unwrap_or("blue");
    Ok(slot.to_string())
}

/// List known secrets with their key names (not values) for status display.
pub async fn get_secrets_info(
    client: &Client,
    namespace: &str,
) -> Result<Vec<(String, Vec<String>)>> {
    let api: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let lp = ListParams::default().labels(""); // all secrets
    let secrets = api.list(&lp).await?;

    let mut result = Vec::new();
    for secret in secrets.items {
        let name = secret.metadata.name.unwrap_or_default();
        // Only show bakerst-* secrets
        if !name.starts_with("bakerst-") {
            continue;
        }
        let keys: Vec<String> = secret
            .data
            .map(|d| d.keys().cloned().collect())
            .unwrap_or_default();
        result.push((name, keys));
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(result)
}

/// Read a secret's data (decoded from base64) for preserving config during update.
pub async fn read_secret(
    client: &Client,
    namespace: &str,
    name: &str,
) -> Result<Option<BTreeMap<String, String>>> {
    let api: Api<Secret> = Api::namespaced(client.clone(), namespace);
    match api.get_opt(name).await? {
        Some(secret) => {
            let data = secret.data.unwrap_or_default();
            let decoded: BTreeMap<String, String> = data
                .into_iter()
                .map(|(k, v)| (k, String::from_utf8_lossy(&v.0).to_string()))
                .collect();
            Ok(Some(decoded))
        }
        None => Ok(None),
    }
}
