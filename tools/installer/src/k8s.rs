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
        let doc = doc.trim();
        if doc.is_empty() || doc.starts_with('#') {
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
