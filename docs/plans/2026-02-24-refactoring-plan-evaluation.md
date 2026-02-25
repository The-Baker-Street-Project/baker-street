# Evaluation: Refactoring Plan — Decoupling OpenClaw from Infrastructure

**Date:** 2026-02-24
**Evaluating:** `docs/plans/refactoring-plan.md`

## Context

This evaluation assesses the refactoring plan that proposes creating a `@bakerst/core` package to separate infrastructure (K8s, NATS) from AI business logic. The motivation is making Baker Street a credible enterprise-grade, SecOps-friendly platform for secure LLM applications on Kubernetes. This document assesses accuracy against the current codebase, identifies what's already done, what's still needed, and proposes additions with a security lens.

---

## 1. Accuracy Assessment — The Plan vs. Reality

The refactoring plan appears to describe an **older or hypothetical** version of the codebase. Several problems it identifies are already solved:

### Already Solved (plan is outdated here)

| Plan Claims | Actual State |
|---|---|
| "NATS subject parsing mixed with domain logic" | Subjects centralized in `packages/shared/src/subjects.ts` — all code uses `Subjects.CONSTANT` |
| "Model hardcoded to specific versions like `claude-3-opus`" | `ModelRouter` in `packages/shared/src/model-router.ts` supports multi-provider routing (Anthropic, OpenRouter, Ollama, OpenAI-compatible), configurable via JSON file + env vars + DB persistence |
| "`ANTHROPIC_API_KEY` accessed via `process.env` deep in logic" | Centralized in `model-router.ts` with OAuth token priority, API key fallback |
| "`NATS_URL` hardcoded defaults" | Set via env var in K8s deployment manifests, `connectNats()` helper in shared |
| "System prompts hardcoded strings" | Already externalized to `operating_system/SOUL.md`, `BRAIN.md`, `WORKER.md`, mounted as ConfigMap |
| "Tool definitions should move to config" | Three-tier system exists: MCP Skills (DB-driven), Legacy Plugins (`PLUGINS.json`), Extensions (pod-based auto-discovery) |
| References to "OpenClaw" throughout | Zero "OpenClaw" references exist in the codebase. The plan's framing is confusing. |

### Still Valid (genuine coupling that exists)

| Plan Concern | Where It Lives | Severity |
|---|---|---|
| K8s Job manifest generation in brain | `services/brain/src/task-pod-manager.ts` — imports `@kubernetes/client-node`, builds `batch/v1` Job specs inline | Medium |
| K8s API calls for secrets/deployments | `services/brain/src/k8s-client.ts` — custom fetch client against K8s API | Low (already isolated to one file) |
| Hardcoded worker job types | `services/worker/src/actions.ts` — 3-way switch: `agent`, `command`, `http` | Medium |
| 11 core tools hardcoded in agent.ts | `services/brain/src/agent.ts:129-360` — tool definitions inline | Low-Medium |

---

## 2. Evaluation of the `@bakerst/core` Proposal

### `JobSpawner` Interface — Verdict: Worthwhile, but scope it correctly

The plan proposes abstracting container orchestration behind a `JobSpawner` interface. This has merit:

**Current state:** `TaskPodManager` directly constructs K8s Job manifests with hardcoded security contexts, volume mounts, resource limits, and service account references. This makes it impossible to run task pods on anything other than K8s, and it makes testing require a live cluster or extensive mocking.

**However**, the proposed interface is too thin:
```typescript
// Plan's proposal — too simple
interface JobSpawner {
  spawn(jobId: string, config: JobConfig): Promise<void>;
}
```

A real `JobSpawner` needs: status polling, log streaming, cleanup/cancellation, timeout handling, and result retrieval — all of which `TaskPodManager` already does. The interface should match the actual lifecycle:

```typescript
interface TaskExecutor {
  spawn(taskId: string, config: TaskConfig): Promise<void>;
  cancel(taskId: string): Promise<void>;
  cleanup(taskId: string): Promise<void>;
  onResult(taskId: string): Promise<TaskResult>;  // or event-based
}
```

### `BusAdapter` Interface — Verdict: Low value

NATS integration is already well-abstracted:
- `packages/shared/src/nats.ts` provides `connectNats()`, codec, JetStream helpers
- Subjects are centralized constants
- The brain doesn't parse raw NATS messages inline

Creating a generic `BusAdapter` would add indirection without clear benefit. NATS is a deliberate architectural choice, not an accident. Abstracting it away suggests you might swap it — but NATS JetStream's exactly-once delivery, consumer groups, and stream persistence are load-bearing features that a generic pub/sub interface can't capture.

**Exception:** If the goal is **testability** (injecting a mock bus in tests), a thin interface scoped to that purpose is fine. But don't pretend it's provider-agnostic.

---

## 3. What the Plan Misses — Enterprise SecOps Additions

This is where the real opportunity lies. The existing architecture already has strong foundations (network policies, pod security, scoped secrets, RBAC). But for enterprise SecOps credibility, several gaps remain:

### 3a. Secret Management — Move Beyond .env Files

**Current:** `.env-secrets` flat file → `scripts/secrets.sh` → K8s Secrets (base64, not encrypted at rest by default).

**Enterprise gap:**
- No secret rotation mechanism
- No audit trail for secret access
- K8s Secrets are base64-encoded, not encrypted (unless etcd encryption is configured)
- `k8s-client.ts` in the brain can read/write secrets via K8s API — broad RBAC

**Recommendations:**
- Support external secret providers (Vault, AWS Secrets Manager, Azure Key Vault) via External Secrets Operator or CSI Secret Store Driver
- Narrow brain's RBAC: it currently has `create`, `delete`, `get`, `update`, `patch` on secrets — pare down to minimum needed
- Add secret rotation support (rotate AUTH_TOKEN without downtime using the blue-green deployment)

### 3b. Supply Chain Security — Container Image Provenance

**Current:** Images built locally, `imagePullPolicy: Never`, no signing or scanning.

**Enterprise gap:**
- No image vulnerability scanning
- No image signing (cosign/Notary)
- No SBOM generation
- No admission controller to enforce signed images

**Recommendations:**
- Add `trivy` or `grype` scanning to `scripts/build.sh`
- Sign images with `cosign` (even for local dev, establishes the pattern)
- Generate SBOMs with `syft` during build
- Document the path to an admission controller (Kyverno or OPA Gatekeeper) for production

### 3c. LLM-Specific Security — Prompt Injection & Output Sanitization

**Current:** Extensions docs mention "each extension must implement its own input validation, authorization, and output sanitization" — this is a policy statement, not enforcement.

**Enterprise gap:**
- No centralized prompt injection detection
- No output sanitization layer between LLM responses and tool execution
- Tool execution in `agent.ts` trusts LLM output directly
- Worker executes shell commands from `executeCommand()` with only an allowlist check

**Recommendations:**
- Add an input/output guardrail layer in the agent loop (between LLM response and tool dispatch)
- Implement tool argument validation at the `UnifiedToolRegistry` level, not per-tool
- Add structured audit logging for all tool invocations (who requested, what was executed, what was returned)
- Consider a "human-in-the-loop" gate for high-risk tools (shell execution, secret access, K8s operations)

### 3d. Audit Logging & Compliance

**Current:** API audit logging exists (`db.ts` stores API calls), but it's SQLite-based and local to the brain pod.

**Enterprise gap:**
- Audit logs disappear if the pod restarts (SQLite on ephemeral or hostPath storage)
- No centralized, tamper-evident audit trail
- No structured logging of security-relevant events (auth failures, tool executions, secret access)

**Recommendations:**
- Ship audit events to Loki (already deployed in telemetry stack) with structured fields
- Define audit event taxonomy: `auth.*`, `tool.*`, `secret.*`, `admin.*`
- Add auth failure rate limiting / alerting
- Ensure audit logs can't be modified by the application (write-only to external system)

### 3e. Network Segmentation — Task Pod Isolation

**Current:** Network policies exist and are good. Task pods can only reach NATS. But:

**Enterprise gap:**
- Task pods share the `bakerst` namespace with the brain — a compromised task pod is one RBAC misconfiguration away from accessing brain secrets
- Task pod RBAC (`k8s/task/rbac.yaml`) has no permissions, which is correct, but there's no `PodSecurityStandard` or `RuntimeClass` enforcement

**Recommendations:**
- Consider running task pods in a separate namespace (`bakerst-tasks`) with even stricter network policies
- Apply `restricted` Pod Security Standard at the namespace level
- Add `RuntimeClass` for task pods (gVisor/Kata if available) for defense-in-depth
- Set resource quotas on the task namespace to prevent resource exhaustion attacks

### 3f. Rate Limiting & Cost Controls

**Current:** No rate limiting on API endpoints. No cost tracking beyond API audit log.

**Enterprise gap:**
- A compromised gateway or stolen AUTH_TOKEN could run unlimited LLM calls
- No per-user or per-conversation cost budgets
- ModelRouter tracks costs but doesn't enforce limits

**Recommendations:**
- Add rate limiting middleware to `api.ts` (per-token, per-IP)
- Add cost budget enforcement in ModelRouter (configurable per-conversation and global limits)
- Alert on unusual usage patterns (spike detection)

---

## 4. Revised Refactoring Priorities

Given the codebase's actual state, here's a re-prioritized roadmap:

### Priority 1: Security Hardening (High value, low-medium effort)
1. **Centralized tool argument validation** in `UnifiedToolRegistry`
2. **Structured audit logging** to Loki for all tool invocations and auth events
3. **Narrow brain RBAC** to minimum necessary permissions
4. **Rate limiting** on brain API endpoints

### Priority 2: Task Pod Isolation (High value, medium effort)
1. **Separate namespace** for task pods (`bakerst-tasks`)
2. **Resource quotas** on task namespace
3. **Extract `TaskPodManager` interface** (the valid part of the `JobSpawner` proposal)
4. Pod Security Standards enforcement

### Priority 3: Worker Extensibility (Medium value, medium effort)
1. **Job handler registry** in worker — replace the 3-way switch in `actions.ts` with a plugin pattern
2. Allow new job types without modifying worker source

### Priority 4: Supply Chain (Medium value, low effort to start)
1. **Image scanning** in build pipeline
2. **SBOM generation**
3. Document path to image signing and admission control

### Priority 5: Secret Management Upgrade (High value, higher effort)
1. **External Secrets Operator** integration
2. **Secret rotation** support
3. Encrypted etcd or external KMS

### Deprioritized
- **`BusAdapter` abstraction** — low ROI given current NATS integration quality
- **`@bakerst/core` as a separate package** — the shared package already serves this role; adding another layer of indirection isn't justified yet
- **Moving core tool definitions to config** — the 11 built-in tools are stable and tightly coupled to brain internals (job dispatch, memory, skills). Externalizing them adds complexity without flexibility gain.

---

## 5. Key Files Referenced

| File | Role |
|---|---|
| `services/brain/src/task-pod-manager.ts` | K8s Job creation — extraction candidate |
| `services/brain/src/k8s-client.ts` | K8s API client for secrets/deployments |
| `services/brain/src/agent.ts` | Core agent loop, 11 hardcoded tools |
| `services/brain/src/plugin-bridge.ts` | Unified tool registry |
| `services/worker/src/actions.ts` | Hardcoded 3-way job type switch |
| `packages/shared/src/subjects.ts` | Centralized NATS subjects |
| `packages/shared/src/model-router.ts` | Multi-provider LLM routing |
| `packages/shared/src/model-config.ts` | Model configuration |
| `k8s/brain/rbac.yaml` | Brain RBAC — overly broad |
| `k8s/network-policies.yaml` | Network segmentation |
| `k8s/task/rbac.yaml` | Task pod RBAC |
| `operating_system/` | Externalized system prompts |

---

## 6. Next Steps

This is an evaluation document, not an implementation plan. Recommended path forward:
- Review and discuss priorities
- Each priority item gets its own implementation plan when selected
- Security hardening items (Priority 1) can be tackled incrementally without major refactoring
- The original refactoring plan should be updated or superseded by this evaluation
