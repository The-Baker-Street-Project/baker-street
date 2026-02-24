/**
 * TaskExecutor — abstract contract for spawning isolated task workloads.
 *
 * The default implementation (K8sTaskExecutor) creates Kubernetes Jobs,
 * but consumers can provide alternative implementations (Docker, local process, etc.)
 */

export interface TaskConfig {
  /** Container image to run */
  image: string;
  /** Command and arguments */
  command: string[];
  /** Environment variables */
  env: Record<string, string>;
  /** Timeout in seconds (default: implementation-specific) */
  timeout?: number;
  /** Secrets to inject as env vars (key = env var name, value = secret ref) */
  secrets?: Record<string, string>;
  /** Labels for tracking/filtering */
  labels?: Record<string, string>;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs?: number;
}

export interface TaskExecutor {
  /** Spawn a new task workload. Returns when the task is created (not completed). */
  spawn(taskId: string, config: TaskConfig): Promise<void>;
  /** Cancel a running task. */
  cancel(taskId: string): Promise<void>;
  /** Clean up resources for a completed/cancelled task. */
  cleanup(taskId: string): Promise<void>;
  /** Wait for a task result with optional timeout. */
  onResult(taskId: string, timeoutMs?: number): Promise<TaskResult>;
}
