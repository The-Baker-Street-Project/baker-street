# @bakerst/core

Framework interfaces for the [Baker Street](https://github.com/The-Baker-Street-Project/baker-street) Kubernetes-native AI agent system.

This package defines the abstract contracts that both consumer (open-source) and enterprise deployments implement. It has **zero runtime dependencies**.

## Install

```bash
npm install @bakerst/core
```

## Interfaces

### GuardrailHook

Security middleware for tool execution. Called before and after every tool call in the agent loop.

```typescript
import type { GuardrailHook, GuardrailContext, GuardrailResult } from '@bakerst/core';

const myGuardrail: GuardrailHook = {
  async beforeToolExecution(ctx: GuardrailContext): Promise<GuardrailResult> {
    if (ctx.toolName === 'dangerous_tool') {
      return { allow: false, reason: 'Blocked by policy' };
    }
    return { allow: true };
  },
  async afterToolExecution(ctx, result) {
    // Sanitize output before it reaches the LLM
    return result;
  },
};
```

The consumer deployment uses the built-in no-op default (zero overhead):

```typescript
import { noopGuardrailHook } from '@bakerst/core';
// { allow: true } for everything, no async calls, no network I/O
```

### AuditSink

Structured event emission for compliance logging and SIEM integration.

```typescript
import type { AuditSink, AuditEvent } from '@bakerst/core';

const myAuditSink: AuditSink = {
  emit(event: AuditEvent) {
    // Ship to Loki, Splunk, Datadog, etc.
    console.log(JSON.stringify(event));
  },
};
```

Events have five categories: `auth`, `tool`, `secret`, `admin`, `llm`.

### TaskExecutor

Abstract contract for spawning isolated task workloads (K8s Jobs, Docker containers, local processes).

```typescript
import type { TaskExecutor, TaskConfig, TaskResult } from '@bakerst/core';

const executor: TaskExecutor = {
  async spawn(taskId: string, config: TaskConfig) { /* ... */ },
  async cancel(taskId: string) { /* ... */ },
  async cleanup(taskId: string) { /* ... */ },
  async onResult(taskId: string, timeoutMs?: number): Promise<TaskResult> { /* ... */ },
};
```

### K8sSecretClient

Kubernetes secret operations. The default implementation uses the K8s API directly from within a pod:

```typescript
import { createK8sSecretClient } from '@bakerst/core';

const client = createK8sSecretClient('my-secret-name');
const secrets = await client.getSecrets();
await client.updateSecrets({ API_KEY: 'new-value' });
await client.restartDeployment('my-app');
```

Enterprise deployments can replace this with Vault, AWS Secrets Manager, or Azure Key Vault backends.

### ExtensionDiscovery

Extension lifecycle and discovery for pod-based tool plugins.

```typescript
import type { ExtensionDiscovery, ExtensionInfo } from '@bakerst/core';

const discovery: ExtensionDiscovery = {
  onAnnounce(handler: (ext: ExtensionInfo) => void) { /* ... */ },
  onOffline(handler: (extId: string) => void) { /* ... */ },
  getOnlineExtensions(): ExtensionInfo[] { /* ... */ },
};
```

## Enterprise Distribution

The [`baker-street-hardened`](https://github.com/The-Baker-Street-Project/baker-street-hardened) repo provides production implementations of these interfaces:

- **`@bakerst/guardrails`** — Composable `GuardrailHook` with injection detection, schema validation, risk assessment, human-in-the-loop approval, and output sanitization
- **`@bakerst/audit`** — Buffered `AuditSink` with HMAC chain tamper evidence and pluggable backends (Loki, Splunk, file)

## License

MIT
