/**
 * @bakerst/core — Reusable K8s/extension infrastructure interfaces.
 *
 * This package defines the abstract contracts that both the consumer (open-source)
 * and enterprise deployments implement. It contains:
 *
 * - TaskExecutor: spawning isolated task workloads (K8s Jobs, Docker, etc.)
 * - ExtensionDiscovery: extension lifecycle and tool discovery
 * - GuardrailHook / AuditSink: security middleware seams
 * - K8sSecretClient: Kubernetes secret operations
 */

// Task execution
export type { TaskConfig, TaskResult, TaskExecutor } from './task-executor.js';

// Extension lifecycle
export type { ExtensionInfo, ExtensionDiscovery } from './extension-lifecycle.js';

// Guardrails and audit
export type {
  GuardrailContext,
  GuardrailResult,
  GuardrailHook,
  AuditEvent,
  AuditSink,
} from './guardrails.js';
export { noopGuardrailHook, noopAuditSink } from './guardrails.js';

// K8s secret client
export type { SecretData, K8sSecretClient } from './k8s-secret-client.js';
export { createK8sSecretClient } from './k8s-secret-client-impl.js';
