# Plan: Baker Street Framework Extraction & Enterprise Distribution

**Date:** 2026-02-24
**Status:** Approved
**Depends on:** Refactoring plan evaluation (`docs/plans/2026-02-24-refactoring-plan-evaluation.md`)

## Context

Baker Street is a Kubernetes-native AI agent system that currently combines framework infrastructure and application logic in a single monorepo. The goal is to:

1. **Extract `@bakerst/core`** — separate reusable K8s/extension infrastructure from the assistant application
2. **Create `baker-street-hardened`** — a separate enterprise distribution repo with security hardening
3. **Keep the consumer experience simple** — average user clones one repo, runs one script

This follows **Option C**: framework + consumer app in the main repo, enterprise distribution in a separate repo. The assistant serves as a reference application demonstrating the framework in both consumer and enterprise configurations.

### Sequencing

- **Phase 0 (sequential):** Complete observational memory Phases 3 & 4 — finish the assistant's core feature set before restructuring
- **Phase 1 (sequential):** Extract `@bakerst/core` in the main repo — both streams depend on this
- **Phase 2 (parallel):** Gary continues assistant feature development while a separate Claude session builds the enterprise repo against stable core interfaces

---

## Phase 0: Complete Observational Memory (Phases 3 & 4)

**Why first:** The reflector and prompt caching touch `agent.ts`, `context-builder.ts`, and `api.ts` — the same files that Phase 1 will refactor for guardrail hooks and audit sinks. Completing the memory system first means we refactor stable code, not code that's about to change. It also means the reference app is feature-complete when we showcase it.

Full spec: `docs/observational-memory-implementation.md`

### Step 0a: Reflector Worker (Memory Phase 3)

**Create:** `services/brain/src/reflector.ts`

Compacts the observation log when it exceeds 40k tokens (min 1hr between runs). Uses Sonnet (needs judgment about what to keep vs. merge).

Key implementation points:
- Check `memState.last_reflector_run` against `MEMORY_CONFIG.reflectMinIntervalMinutes` (60min)
- Load active observation log via `getActiveObservationLog(conversationId)`
- Call Claude Sonnet with compaction instructions targeting ~60% reduction
- Write new observation log version via `upsertObservationLog()`
- Update `memory_state` with new token count and `last_reflector_run` timestamp
- Uses separate Anthropic client instance (not the main agent's OAuth client)
- Use `ModelRouter` if available (respect configured provider), fall back to direct Anthropic client

**Modify:** `services/brain/src/agent.ts`
- Replace the placeholder log at `triggerMemoryWorkers()` with actual reflector call
- Sequence observer before reflector when both thresholds crossed

**Files:**
| File | Change |
|---|---|
| `services/brain/src/reflector.ts` | **New** — `runReflector()` |
| `services/brain/src/agent.ts` | Replace placeholder with reflector trigger, sequence observer → reflector |

### Step 0b: Prompt Caching (Memory Phase 4)

**Modify:** `services/brain/src/context-builder.ts`
- Add `cache_control: { type: "ephemeral" }` to the last stable system block
- Block ordering (cacheable prefix first, per-turn tail after):
  1. Claude Code identity (if OAuth) — stable across all conversations
  2. SOUL.md + BRAIN.md system prompt — stable across all conversations
  3. Observation log — stable within conversation ← **cache_control breakpoint here**
  4. Long-term memories (Qdrant) — changes per turn (uncached tail)
  5. Channel hint — changes per request (uncached tail)

**Modify:** `services/brain/src/agent.ts`
- Log cache hit/miss stats from API response `usage` field

**Modify:** `services/brain/src/api.ts`
- Add `GET /conversations/:id/memory` diagnostics endpoint

**Files:**
| File | Change |
|---|---|
| `services/brain/src/context-builder.ts` | Add `cache_control`, reorder system blocks |
| `services/brain/src/agent.ts` | Log cache hit/miss stats from API response |
| `services/brain/src/api.ts` | Add `GET /conversations/:id/memory` endpoint |

### Step 0c: Verification (Memory Phases 3 & 4)

1. `pnpm -r build` — compiles
2. Deploy and send enough messages to trigger observer (>30k unobserved tokens)
3. Manually set `observation_token_count > 40000` to trigger reflector
4. Verify reflector produces condensed log with fewer tokens
5. Verify consecutive turns show `cache_read_input_tokens > 0` in logs
6. Verify `GET /conversations/:id/memory` returns correct stats
7. `pnpm -r test` — all existing tests pass

---

## Phase 1: Extract `@bakerst/core` Package

**Scope:** K8s abstractions + extension lifecycle only. NATS helpers and ModelRouter stay in `@bakerst/shared` where they already work well.

### Step 1: Create `packages/core/` scaffold

Create `packages/core/` with:
- `package.json` (`@bakerst/core`, ESM, depends on `@bakerst/shared`)
- `tsconfig.json` (extends root config)
- `src/index.ts` (barrel export)

Add to `pnpm-workspace.yaml` (already covered by `packages/*` glob).

**Files to create:**
- `packages/core/package.json`
- `packages/core/tsconfig.json`
- `packages/core/src/index.ts`

### Step 2: Define `TaskExecutor` interface

Extract from `services/brain/src/task-pod-manager.ts` the abstract contract for task execution. The current `TaskPodManager` does: spawn, cancel, cleanup, result retrieval, timeout handling.

**Create:** `packages/core/src/task-executor.ts`
```typescript
export interface TaskConfig {
  image: string;
  command: string[];
  env: Record<string, string>;
  timeout?: number;
  secrets?: Record<string, string>;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  output: string;
  error?: string;
}

export interface TaskExecutor {
  spawn(taskId: string, config: TaskConfig): Promise<void>;
  cancel(taskId: string): Promise<void>;
  cleanup(taskId: string): Promise<void>;
  onResult(taskId: string, timeoutMs?: number): Promise<TaskResult>;
}
```

### Step 3: Define extension lifecycle interfaces

Extract from `services/brain/src/extension-manager.ts` the abstract contract for extension discovery and lifecycle.

**Create:** `packages/core/src/extension-lifecycle.ts`
```typescript
export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  url: string;
  tools: string[];
  status: 'online' | 'offline';
}

export interface ExtensionDiscovery {
  onAnnounce(handler: (ext: ExtensionInfo) => void): void;
  onOffline(handler: (extId: string) => void): void;
  getOnlineExtensions(): ExtensionInfo[];
}
```

### Step 4: Define guardrail hook points

These interfaces are the seams where the enterprise repo will inject security middleware. They don't move existing code — they define where hardening plugs in.

**Create:** `packages/core/src/guardrails.ts`
```typescript
export interface GuardrailContext {
  conversationId: string;
  userId?: string;
  toolName: string;
  toolInput: unknown;
}

export interface GuardrailHook {
  /** Called before tool execution. Return false to block. */
  beforeToolExecution(ctx: GuardrailContext): Promise<{ allow: boolean; reason?: string }>;
  /** Called after tool execution with the result. */
  afterToolExecution(ctx: GuardrailContext, result: unknown): Promise<unknown>;
}

export interface AuditSink {
  /** Emit a structured audit event */
  emit(event: AuditEvent): void;
}

export interface AuditEvent {
  timestamp: string;
  category: 'auth' | 'tool' | 'secret' | 'admin' | 'llm';
  action: string;
  actor: string;
  detail: Record<string, unknown>;
}
```

### Step 5: Extract K8s client abstraction

Move the K8s-specific code behind the `TaskExecutor` interface.

**Create:** `packages/core/src/k8s-task-executor.ts`
- Move the core logic from `services/brain/src/task-pod-manager.ts` into this file
- It implements `TaskExecutor` using `@kubernetes/client-node`
- The brain service imports `K8sTaskExecutor` from `@bakerst/core` instead of using `TaskPodManager` directly

**Refactor:** `services/brain/src/task-pod-manager.ts`
- Becomes a thin wrapper that instantiates `K8sTaskExecutor` from core
- Or is replaced entirely by importing from core (preferred if no brain-specific logic remains)

**Refactor:** `services/brain/src/k8s-client.ts`
- Extract interface `K8sSecretClient` to `packages/core/src/k8s-secret-client.ts`
- Keep the implementation in core (it's pure infrastructure)

### Step 6: Wire guardrail hooks into agent loop

Add optional guardrail hook points in the brain's agent loop without requiring them.

**Modify:** `services/brain/src/agent.ts`
- Before tool execution (around line 365-507 where tools are dispatched), check if a `GuardrailHook` is registered
- If no hook registered, execute as today (zero overhead for consumer)
- If hook registered (enterprise), call `beforeToolExecution` / `afterToolExecution`

**Modify:** `services/brain/src/plugin-bridge.ts`
- Accept optional `GuardrailHook` in `UnifiedToolRegistry`
- Apply it transparently to all tool executions

### Step 7: Wire audit sink into brain

Add optional audit event emission.

**Modify:** `services/brain/src/index.ts`
- Accept optional `AuditSink` at startup
- Default: no-op sink (consumer)
- Pass to agent, api, and other subsystems

**Modify:** `services/brain/src/api.ts`
- Emit audit events for auth failures, API calls (supplement existing SQLite logging)

### Step 8: Update brain's dependencies

**Modify:** `services/brain/package.json`
- Add dependency on `@bakerst/core`
- Remove direct dependency on `@kubernetes/client-node` (now transitive via core)

### Step 9: Update build and tests

- Ensure `pnpm -r build` builds core before brain/worker
- Add unit tests for core interfaces (mock implementations)
- Verify existing brain tests still pass with the refactored imports

---

## Phase 2: Enterprise Repo (Parallel — separate Claude session)

**Prerequisite:** Phase 1 complete, `@bakerst/core` interfaces stable.

This phase is executed by a separate Claude session while Gary continues feature development on the main repo.

### Scope for the enterprise repo (`baker-street-hardened`):

1. **Hardened K8s overlays**
   - Separate `bakerst-tasks` namespace for task pods
   - `restricted` Pod Security Standard enforcement
   - Resource quotas on task namespace
   - Narrowed brain RBAC (remove unnecessary secret permissions)
   - External Secrets Operator manifests (Vault/AWS SM integration)

2. **Guardrail implementation**
   - `packages/guardrails/` — implements `GuardrailHook` from `@bakerst/core`
   - Prompt injection detection (input scanning)
   - Output sanitization (before tool execution)
   - Tool argument validation (schema enforcement)
   - Human-in-the-loop gate for high-risk tools

3. **Audit logging service**
   - `packages/audit/` — implements `AuditSink` from `@bakerst/core`
   - Ships structured events to Loki/Splunk/external SIEM
   - Event taxonomy: `auth.*`, `tool.*`, `secret.*`, `admin.*`, `llm.*`
   - Tamper-evident (write-only to external system)

4. **Supply chain security**
   - `scripts/build-enterprise.sh` — adds trivy scanning, SBOM generation (syft)
   - Image signing with cosign
   - Admission controller manifests (Kyverno policies)

5. **Rate limiting & cost controls**
   - Rate limiting middleware for brain API
   - Cost budget enforcement in ModelRouter wrapper
   - Usage alerting configuration

6. **Compliance documentation**
   - `docs/compliance/` — security controls inventory
   - Threat model document
   - SOC2/ISO27001 control mapping (where applicable)

7. **Enterprise deploy script**
   - `deploy-enterprise.sh` — runs compliance checks, image scanning, then deploys with enterprise overlays

---

## Key Files Modified (Phase 1)

| File | Action |
|---|---|
| `packages/core/` (new directory) | Create package scaffold |
| `packages/core/src/task-executor.ts` | New — TaskExecutor interface |
| `packages/core/src/k8s-task-executor.ts` | New — K8s implementation (extracted from brain) |
| `packages/core/src/extension-lifecycle.ts` | New — Extension discovery interface |
| `packages/core/src/guardrails.ts` | New — GuardrailHook and AuditSink interfaces |
| `packages/core/src/k8s-secret-client.ts` | New — K8s secret client interface + impl |
| `services/brain/src/task-pod-manager.ts` | Refactor — use TaskExecutor from core |
| `services/brain/src/k8s-client.ts` | Refactor — extract interface to core |
| `services/brain/src/agent.ts` | Modify — add optional guardrail hook points |
| `services/brain/src/plugin-bridge.ts` | Modify — accept optional GuardrailHook |
| `services/brain/src/index.ts` | Modify — accept optional AuditSink |
| `services/brain/src/api.ts` | Modify — emit audit events |
| `services/brain/package.json` | Modify — add @bakerst/core dependency |

---

## Verification

### Phase 1 verification:
1. `pnpm install && pnpm -r build` — all packages compile
2. `pnpm -r test` — all existing tests pass
3. `services/brain` no longer directly imports `@kubernetes/client-node`
4. `packages/core` exports clean interfaces importable by external consumers
5. Consumer deploy (`./deploy.sh`) works identically — no behavior change
6. GuardrailHook and AuditSink are optional — consumer path has zero overhead

### Phase 2 verification (enterprise repo):
1. Enterprise repo builds against published/linked `@bakerst/core` packages
2. `deploy-enterprise.sh` runs image scanning, deploys hardened overlays
3. Guardrail hook blocks a test prompt injection attempt
4. Audit events appear in configured sink
5. Task pods run in isolated namespace with restricted PSS
