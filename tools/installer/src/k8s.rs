use anyhow::{bail, Context, Result};
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
/// Files are provided as key-value pairs (filename -> content), fetched at runtime.
pub async fn create_os_configmap(
    client: &Client,
    namespace: &str,
    files: &BTreeMap<String, String>,
) -> Result<()> {
    let cm = ConfigMap {
        metadata: kube::api::ObjectMeta {
            name: Some("bakerst-os".into()),
            namespace: Some(namespace.into()),
            ..Default::default()
        },
        data: Some(files.clone()),
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

/// Get the current image for a deployment's first container.
/// Returns `None` if the deployment doesn't exist (e.g., first-time install).
pub async fn get_deployment_image(
    client: &Client,
    namespace: &str,
    deployment: &str,
) -> Result<Option<String>> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    match api.get_opt(deployment).await? {
        Some(dep) => {
            let image = dep
                .spec
                .and_then(|s| s.template.spec)
                .and_then(|s| s.containers.first().cloned())
                .and_then(|c| c.image);
            Ok(image)
        }
        None => Ok(None),
    }
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
                "app": "brain",
                "slot": slot
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
    let slot = selector.get("slot").cloned().unwrap_or_else(|| "blue".into());
    Ok(slot)
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

// ---------------------------------------------------------------------------
// Context detection and selection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct K8sContext {
    pub name: String,
    pub cluster_type: ClusterType,
}

#[derive(Debug, Clone)]
pub enum ClusterType {
    DockerDesktop,
    OrbStack,
    Minikube,
    Kind,
    RancherDesktop,
    Other,
}

impl std::fmt::Display for ClusterType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DockerDesktop => write!(f, "Docker Desktop"),
            Self::OrbStack => write!(f, "OrbStack"),
            Self::Minikube => write!(f, "Minikube"),
            Self::Kind => write!(f, "kind"),
            Self::RancherDesktop => write!(f, "Rancher Desktop"),
            Self::Other => write!(f, "Other"),
        }
    }
}

/// Detect all available kubectl contexts and classify their cluster type.
pub async fn detect_contexts() -> Result<Vec<K8sContext>> {
    let output = tokio::process::Command::new("kubectl")
        .args(["config", "get-contexts", "-o", "name"])
        .output()
        .await?;

    if !output.status.success() {
        bail!("kubectl not found or not configured. Install kubectl and configure a Kubernetes cluster.");
    }

    let contexts: Vec<K8sContext> = String::from_utf8(output.stdout)?
        .lines()
        .filter(|l| !l.is_empty())
        .map(|name| K8sContext {
            name: name.to_string(),
            cluster_type: classify_context(name),
        })
        .collect();

    Ok(contexts)
}

fn classify_context(name: &str) -> ClusterType {
    let lower = name.to_lowercase();
    if lower.contains("docker-desktop") {
        ClusterType::DockerDesktop
    } else if lower.contains("orbstack") || lower.contains("orb") {
        ClusterType::OrbStack
    } else if lower.contains("minikube") {
        ClusterType::Minikube
    } else if lower.contains("kind") {
        ClusterType::Kind
    } else if lower.contains("rancher") {
        ClusterType::RancherDesktop
    } else {
        ClusterType::Other
    }
}

/// Switch the active kubectl context.
pub async fn use_context(name: &str) -> Result<()> {
    let status = tokio::process::Command::new("kubectl")
        .args(["config", "use-context", name])
        .status()
        .await?;
    if !status.success() {
        bail!("Failed to switch to context: {}", name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_docker_desktop() {
        assert!(matches!(
            classify_context("docker-desktop"),
            ClusterType::DockerDesktop
        ));
    }

    #[test]
    fn classify_orbstack() {
        assert!(matches!(
            classify_context("orbstack"),
            ClusterType::OrbStack
        ));
    }

    #[test]
    fn classify_minikube() {
        assert!(matches!(
            classify_context("minikube"),
            ClusterType::Minikube
        ));
    }

    #[test]
    fn classify_kind() {
        assert!(matches!(
            classify_context("kind-kind"),
            ClusterType::Kind
        ));
    }

    #[test]
    fn classify_rancher() {
        assert!(matches!(
            classify_context("rancher-desktop"),
            ClusterType::RancherDesktop
        ));
    }

    #[test]
    fn classify_unknown() {
        assert!(matches!(
            classify_context("my-prod-cluster"),
            ClusterType::Other
        ));
    }

    #[test]
    fn cluster_type_display() {
        assert_eq!(format!("{}", ClusterType::DockerDesktop), "Docker Desktop");
        assert_eq!(format!("{}", ClusterType::OrbStack), "OrbStack");
        assert_eq!(format!("{}", ClusterType::Kind), "kind");
        assert_eq!(format!("{}", ClusterType::Other), "Other");
    }
}
