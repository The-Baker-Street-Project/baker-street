use anyhow::Result;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, DeleteParams, ListParams, LogParams};
use kube::Client;
use std::time::Duration;
use tokio::sync::mpsc;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const POD_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RECOVERY_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone)]
pub struct PodHealth {
    pub name: String,
    pub deployment: String,
    pub ready: bool,
    pub phase: String,
    pub image: String,
    pub restarts: i32,
    pub error: Option<String>,
    pub logs_tail: Option<String>,
}

#[derive(Debug, Clone)]
pub enum HealthEvent {
    PodUpdate(PodHealth),
    RecoveryAttempt { deployment: String, attempt: u32 },
    AllHealthy,
    Failed { unhealthy: Vec<PodHealth> },
}

/// Wait for a single deployment to have all replicas ready.
pub async fn wait_for_rollout(
    client: &Client,
    namespace: &str,
    name: &str,
    timeout: Duration,
) -> Result<()> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let start = tokio::time::Instant::now();

    loop {
        if start.elapsed() > timeout {
            anyhow::bail!("timeout waiting for deployment {} rollout", name);
        }

        let deploy = api.get(name).await?;
        let status = deploy.status.as_ref();
        let desired = status
            .and_then(|s| s.replicas)
            .unwrap_or(1);
        let ready = status
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0);

        if ready >= desired && desired > 0 {
            return Ok(());
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Poll all deployments, send health events, auto-recover crashed pods.
pub async fn poll_health(
    client: &Client,
    namespace: &str,
    deployment_names: &[&str],
    tx: mpsc::UnboundedSender<HealthEvent>,
) -> Result<()> {
    let pod_api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let mut recovery_attempts: std::collections::HashMap<String, u32> = Default::default();

    let start = tokio::time::Instant::now();

    loop {
        let mut all_healthy = true;
        let mut unhealthy = Vec::new();

        for deploy_name in deployment_names {
            let lp = ListParams::default().labels(&format!("app={}", deploy_name));
            let pods = pod_api.list(&lp).await?;

            for pod in &pods.items {
                let pod_name = pod.metadata.name.clone().unwrap_or_default();
                let status = pod.status.as_ref();
                let phase = status
                    .and_then(|s| s.phase.clone())
                    .unwrap_or_else(|| "Unknown".into());

                let container_statuses = status
                    .and_then(|s| s.container_statuses.clone())
                    .unwrap_or_default();

                let ready = container_statuses.iter().all(|cs| cs.ready);
                let restarts: i32 = container_statuses.iter().map(|cs| cs.restart_count).sum();
                let image = container_statuses
                    .first()
                    .map(|cs| cs.image.clone())
                    .unwrap_or_default();

                // Check for CrashLoopBackOff
                let is_crash_loop = container_statuses.iter().any(|cs| {
                    cs.state.as_ref().map_or(false, |s| {
                        s.waiting.as_ref().map_or(false, |w| {
                            w.reason.as_deref() == Some("CrashLoopBackOff")
                        })
                    })
                });

                let mut error = None;
                if is_crash_loop {
                    error = Some("CrashLoopBackOff".into());
                    let attempts = recovery_attempts.entry(deploy_name.to_string()).or_insert(0);

                    if *attempts < MAX_RECOVERY_ATTEMPTS {
                        *attempts += 1;
                        tx.send(HealthEvent::RecoveryAttempt {
                            deployment: deploy_name.to_string(),
                            attempt: *attempts,
                        }).ok();

                        // Fetch logs before deleting
                        let _logs = pod_api.logs(&pod_name, &LogParams {
                            tail_lines: Some(50),
                            ..Default::default()
                        }).await.unwrap_or_default();

                        // Delete pod to trigger recreation
                        pod_api.delete(&pod_name, &DeleteParams::default()).await.ok();
                    }
                }

                let health = PodHealth {
                    name: pod_name,
                    deployment: deploy_name.to_string(),
                    ready,
                    phase,
                    image,
                    restarts,
                    error: error.clone(),
                    logs_tail: None,
                };

                if !ready {
                    all_healthy = false;
                    unhealthy.push(health.clone());
                }

                tx.send(HealthEvent::PodUpdate(health)).ok();
            }
        }

        if all_healthy && !deployment_names.is_empty() {
            tx.send(HealthEvent::AllHealthy).ok();
            return Ok(());
        }

        if start.elapsed() > POD_TIMEOUT {
            // Fetch logs for unhealthy pods
            for pod in &mut unhealthy {
                let logs = pod_api.logs(&pod.name, &LogParams {
                    tail_lines: Some(5),
                    ..Default::default()
                }).await.unwrap_or_default();
                pod.logs_tail = Some(logs);
            }
            tx.send(HealthEvent::Failed { unhealthy }).ok();
            return Ok(());
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
