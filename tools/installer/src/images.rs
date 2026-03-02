use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::mpsc;

const MAX_CONCURRENT: usize = 4;
const MAX_RETRIES: u32 = 3;

#[derive(Debug, Clone)]
pub enum PullEvent {
    Started { index: usize, image: String },
    Completed { index: usize, image: String, elapsed: Duration },
    Failed { index: usize, image: String, error: String, attempt: u32 },
    Retrying { index: usize, image: String, attempt: u32 },
}

/// Errors that indicate a local Docker configuration issue (not transient).
/// These should fail immediately without retrying.
fn is_local_docker_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("credential") || lower.contains("not found in PATH")
        || lower.contains("docker daemon is not running")
        || lower.contains("permission denied")
        || lower.contains("cannot connect to the docker daemon")
}

/// Pull a single image via `docker pull`, with retries.
/// Credential helper and docker-not-running errors fail immediately (no retry).
async fn pull_one(image: &str) -> Result<Duration, String> {
    for attempt in 1..=MAX_RETRIES {
        let start = Instant::now();
        let output = Command::new("docker")
            .args(["pull", image])
            .output()
            .await
            .map_err(|e| format!("failed to run docker: {}", e))?;

        if output.status.success() {
            return Ok(start.elapsed());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        // Don't retry local configuration errors — they won't self-heal
        if is_local_docker_error(&stderr) {
            return Err(format!("docker config error (skipping retries): {}", stderr.trim()));
        }

        if attempt < MAX_RETRIES {
            let backoff = Duration::from_secs(2u64.pow(attempt));
            tokio::time::sleep(backoff).await;
            continue;
        }
        return Err(stderr.trim().to_string());
    }
    unreachable!()
}

/// Pull all images in parallel (max MAX_CONCURRENT at once).
/// Sends PullEvent messages on the channel for TUI updates.
pub async fn pull_all(
    images: Vec<String>,
    tx: mpsc::UnboundedSender<PullEvent>,
) -> Vec<Result<Duration, String>> {
    use tokio::sync::Semaphore;
    use std::sync::Arc;

    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut handles = Vec::new();

    for (index, image) in images.into_iter().enumerate() {
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let tx = tx.clone();
        let img = image.clone();

        let handle = tokio::spawn(async move {
            tx.send(PullEvent::Started { index, image: img.clone() }).ok();

            let result = pull_one(&img).await;

            match &result {
                Ok(elapsed) => {
                    tx.send(PullEvent::Completed { index, image: img, elapsed: *elapsed }).ok();
                }
                Err(err) => {
                    tx.send(PullEvent::Failed { index, image: img, error: err.clone(), attempt: MAX_RETRIES }).ok();
                }
            }

            drop(permit);
            result
        });

        handles.push(handle);
    }

    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.unwrap());
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pull_nonexistent_image_fails() {
        let result = pull_one("ghcr.io/nonexistent/image:99.99.99").await;
        assert!(result.is_err());
    }
}
