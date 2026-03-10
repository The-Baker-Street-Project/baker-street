//! Verification module — post-install checks to confirm the deployment is healthy.

use anyhow::Result;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::Serialize;
use std::path::Path;

use crate::interview::InterviewResult;

#[derive(Debug, Serialize)]
pub struct VerifyResult {
    pub checks: Vec<Check>,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct Check {
    pub name: String,
    pub passed: bool,
    pub message: String,
    pub duration_ms: u64,
}

impl VerifyResult {
    pub fn all_passed(&self) -> bool {
        self.checks.iter().all(|c| c.passed)
    }

    pub fn write_log(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(path, json)?;
        Ok(())
    }
}

/// Run post-install verification against the deployed cluster.
pub async fn run_checks(
    client: &Client,
    namespace: &str,
    config: &InterviewResult,
) -> Result<VerifyResult> {
    let start = std::time::Instant::now();
    let mut checks = Vec::new();

    // Check 1: All expected pods are Running
    checks.push(check_pods_running(client, namespace).await);

    // Check 2: Key deployments have desired replicas ready
    checks.push(check_deployments_ready(client, namespace).await);

    // Check 3: Brain health endpoint via kubectl exec
    checks.push(check_brain_health(namespace).await);

    // Check 4: NATS connectivity
    checks.push(check_nats_health(namespace).await);

    // Check 5: Send test prompt (if an AI provider key is configured)
    if config.secrets.contains_key("ANTHROPIC_API_KEY")
        || config.secrets.contains_key("OPENAI_API_KEY")
        || config.secrets.contains_key("OLLAMA_ENDPOINTS")
    {
        checks.push(check_test_prompt(namespace, config).await);
    }

    Ok(VerifyResult {
        checks,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

async fn check_pods_running(client: &Client, namespace: &str) -> Check {
    let start = std::time::Instant::now();
    match k8s_check_pods(client, namespace).await {
        Ok(msg) => Check {
            name: "pods_running".into(),
            passed: true,
            message: msg,
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Err(e) => Check {
            name: "pods_running".into(),
            passed: false,
            message: e.to_string(),
            duration_ms: start.elapsed().as_millis() as u64,
        },
    }
}

async fn k8s_check_pods(client: &Client, namespace: &str) -> Result<String> {
    let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pods = api.list(&ListParams::default()).await?;

    let total = pods.items.len();
    let non_running: Vec<String> = pods
        .items
        .iter()
        .filter_map(|pod| {
            let name = pod.metadata.name.clone().unwrap_or_default();
            let phase = pod
                .status
                .as_ref()
                .and_then(|s| s.phase.clone())
                .unwrap_or_else(|| "Unknown".into());
            if phase != "Running" && phase != "Succeeded" {
                Some(format!("{} ({})", name, phase))
            } else {
                None
            }
        })
        .collect();

    if non_running.is_empty() {
        Ok(format!("All pods running ({} pods)", total))
    } else {
        anyhow::bail!("Some pods not running: {}", non_running.join(", "))
    }
}

async fn check_deployments_ready(client: &Client, namespace: &str) -> Check {
    let start = std::time::Instant::now();
    match k8s_check_deployments(client, namespace).await {
        Ok(msg) => Check {
            name: "deployments_ready".into(),
            passed: true,
            message: msg,
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Err(e) => Check {
            name: "deployments_ready".into(),
            passed: false,
            message: e.to_string(),
            duration_ms: start.elapsed().as_millis() as u64,
        },
    }
}

async fn k8s_check_deployments(client: &Client, namespace: &str) -> Result<String> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let deployments = api.list(&ListParams::default()).await?;

    let total = deployments.items.len();
    let mut not_ready = Vec::new();

    for deploy in &deployments.items {
        let name = deploy.metadata.name.clone().unwrap_or_default();
        let status = deploy.status.as_ref();
        let desired = status.and_then(|s| s.replicas).unwrap_or(1);
        let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);
        if ready < desired {
            not_ready.push(format!("{} ({}/{})", name, ready, desired));
        }
    }

    if not_ready.is_empty() {
        Ok(format!("All deployments ready ({} deployments)", total))
    } else {
        anyhow::bail!(
            "Some deployments not ready: {}",
            not_ready.join(", ")
        )
    }
}

async fn check_brain_health(namespace: &str) -> Check {
    let start = std::time::Instant::now();
    // Use kubectl exec to check brain health from inside the cluster
    let result = tokio::process::Command::new("kubectl")
        .args([
            "exec",
            "-n",
            namespace,
            "deploy/brain-blue",
            "--",
            "wget",
            "-q",
            "-O-",
            "http://localhost:3000/ping",
        ])
        .output()
        .await;

    match result {
        Ok(output) if output.status.success() => Check {
            name: "brain_health".into(),
            passed: true,
            message: "Brain /ping responded OK".into(),
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Ok(output) => Check {
            name: "brain_health".into(),
            passed: false,
            message: format!(
                "Brain health check failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Err(e) => Check {
            name: "brain_health".into(),
            passed: false,
            message: format!("Failed to reach brain: {}", e),
            duration_ms: start.elapsed().as_millis() as u64,
        },
    }
}

async fn check_nats_health(namespace: &str) -> Check {
    let start = std::time::Instant::now();
    let result = tokio::process::Command::new("kubectl")
        .args([
            "exec",
            "-n",
            namespace,
            "deploy/nats",
            "--",
            "nats-server",
            "--help",
        ])
        .output()
        .await;

    // If we can exec into nats pod, it's running
    match result {
        Ok(output) if output.status.success() || !output.stdout.is_empty() => Check {
            name: "nats_health".into(),
            passed: true,
            message: "NATS server running".into(),
            duration_ms: start.elapsed().as_millis() as u64,
        },
        _ => Check {
            name: "nats_health".into(),
            passed: false,
            message: "NATS server not reachable".into(),
            duration_ms: start.elapsed().as_millis() as u64,
        },
    }
}

async fn check_test_prompt(namespace: &str, config: &InterviewResult) -> Check {
    let start = std::time::Instant::now();
    let auth_token = config
        .secrets
        .get("AUTH_TOKEN")
        .cloned()
        .unwrap_or_default();

    // Use kubectl exec to send a test prompt through the brain API
    let curl_cmd = format!(
        "wget -q -O- --header='Authorization: Bearer {}' --header='Content-Type: application/json' \
         --post-data='{{\"message\":\"Say hello in exactly 3 words\",\"conversationId\":\"acceptance-test\"}}' \
         http://localhost:3000/api/chat",
        auth_token
    );

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::process::Command::new("kubectl")
            .args([
                "exec",
                "-n",
                namespace,
                "deploy/brain-blue",
                "--",
                "sh",
                "-c",
                &curl_cmd,
            ])
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) if output.status.success() => {
            let body = String::from_utf8_lossy(&output.stdout);
            Check {
                name: "test_prompt".into(),
                passed: true,
                message: format!(
                    "Test prompt succeeded: {}",
                    body.chars().take(100).collect::<String>()
                ),
                duration_ms: start.elapsed().as_millis() as u64,
            }
        }
        Ok(Ok(output)) => Check {
            name: "test_prompt".into(),
            passed: false,
            message: format!(
                "Test prompt failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Ok(Err(e)) => Check {
            name: "test_prompt".into(),
            passed: false,
            message: format!("Test prompt error: {}", e),
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Err(_) => Check {
            name: "test_prompt".into(),
            passed: false,
            message: "Test prompt timed out (60s)".into(),
            duration_ms: start.elapsed().as_millis() as u64,
        },
    }
}
