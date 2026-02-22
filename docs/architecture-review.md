# Baker Street Architecture & Implementation Review

**Date:** 2026-02-15
**Reviewer:** Principal Engineer + Security Architect review via Claude

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Assessment](#2-architecture-assessment)
3. [Top 10 Prioritized Recommendations](#3-top-10-prioritized-recommendations)
4. [Deep Dives (A-H)](#4-deep-dives)
5. [Proposed Target Architecture](#5-proposed-target-architecture)
6. [Example Snippets](#6-example-snippets)
7. [Clarifying Questions](#7-clarifying-questions)

---

## 1) Executive Summary

### What's Good

- **Clean separation of concerns.** Brain (reasoning), Worker (execution), Gateway (adapters), UI (management) — each has a clear, bounded role.
- **NATS as the messaging backbone** is a strong choice — lightweight, fast, queue groups give you free load balancing, and it supports JetStream if you need durability later.
- **Plugin interface is simple and well-documented.** `BakerstPlugin` maps cleanly to Anthropic's tool-use schema, and the `PLUGINS.md` documentation is thorough.
- **Streaming SSE** works end-to-end from Claude API through brain to the React UI.
- **Observational memory** with Qdrant + Voyage embeddings is a differentiator — most personal AI systems don't have persistent semantic memory.
- **ConfigMap-based personality system** is elegant — SOUL.md/BRAIN.md as mounted files is easy to iterate on.

### What's Risky

- **Zero authentication** on the brain API and web console. Anyone with network access can read all conversations, manage secrets, restart services, and chat as you. This is the #1 security risk.
- **Plugins run in-process with the brain** — a misbehaving plugin can crash the entire system, leak secrets, or monopolize resources. There is no sandboxing.
- **Worker executes shell commands** with only an allowlist check — no namespace isolation, no seccomp, no resource limits on subprocesses.
- **Secrets management through the UI** (`GET /secrets`, `PUT /secrets`) exposes a secret-reading API with no auth. The masking is cosmetic (the raw values are in the JSON response body).
- **No network policies** — every pod can talk to every other pod and to the internet.
- **No tests visible** in the codebase — no unit tests, integration tests, or e2e tests.

### What's Missing

- MCP (Model Context Protocol) support with tiered hosting — the plugin system is bespoke and incompatible with the broader ecosystem.
- Model routing abstraction — hardcoded to `claude-sonnet-4-20250514` everywhere.
- Ephemeral privileged execution for elevated tasks.
- Ingress/gateway for proper external access (currently port-forward only).
- Observability — no metrics, no distributed tracing, no structured alerting.
- CI/CD pipeline — no GitHub Actions, no automated testing, no image registry.
- Self-update mechanism.
- Skill marketplace / registry for third-party skills.

---

## 2) Architecture Assessment

### Current Architecture (Inferred)

```
                     [Telegram/Discord]
                           │
                     ┌─────▼─────┐
                     │  Gateway   │── HTTP ──► Brain :3000
                     └───────────┘

    [User Browser]
         │ port-forward
    ┌────▼────┐
    │ UI :8080│── nginx /api ──► Brain :3000
    └─────────┘

    ┌────────────────────────────────────────────┐
    │              Brain :3000                    │
    │                                            │
    │  Agent (Claude) ◄──► Plugin Registry        │
    │       │                (in-process)         │
    │  Dispatcher ──NATS──► Worker(s)             │
    │       │                                    │
    │  StatusTracker ◄──NATS── Worker(s)          │
    │       │                                    │
    │  MemoryService ──► Qdrant :6333             │
    │  DB (SQLite)    ──► hostPath /data          │
    └────────────────────────────────────────────┘

    ┌───────────┐  ┌──────────────┐
    │ NATS :4222│  │ Browser :9222│
    └───────────┘  └──────────────┘
```

### Pain Points

| # | Pain Point | Impact |
|---|-----------|--------|
| 1 | No auth on any endpoint | Critical — secrets, conversations, and cluster control exposed |
| 2 | In-process plugins | Crash/leak risk; can't safely run untrusted code |
| 3 | Hardcoded model (`claude-sonnet-4-20250514`) | Can't use cheaper models for simple tasks, can't failover |
| 4 | No MCP compatibility | Locked out of the broader tool/skill ecosystem; three-tier hosting model needed to avoid pod sprawl |
| 5 | hostPath volumes with absolute Mac paths | Not portable, no backup strategy |
| 6 | `PluginContext` uses `unknown` types | Plugins must cast blindly; no compile-time safety |
| 7 | No tests | Regressions invisible until production |
| 8 | Worker command allowlist is the only sandboxing | Insufficient for untrusted workloads |
| 9 | Single replicas everywhere | Any pod failure takes out that component |
| 10 | No CI/CD | Manual build/deploy is error-prone and non-reproducible |

---

## 3) Top 10 Prioritized Recommendations

### 1. Add Authentication to Brain API & Web Console

**Impact: Critical | Effort: Low-Medium**

**What:** Add a simple auth layer — at minimum, a shared secret / API key for the brain API, and basic auth or OAuth for the web console.

**Why:** Right now, `GET /secrets` returns all your API keys to anyone with network access. `POST /secrets/restart` can restart your entire system. This is the single most dangerous issue.

**Trade-offs:** Full OAuth is complex for a personal system. A simple bearer token (shared secret in env) for the API + cookie-based session for the UI is sufficient.

**Next steps:**
1. Add `AUTH_TOKEN` to `bakerst-secrets`
2. Add Express middleware that checks `Authorization: Bearer <token>` on all routes except `/ping`
3. For the UI, add a login page that sets an httpOnly cookie with the token
4. For the gateway, configure the token in its env (it's a trusted internal caller)

```typescript
// brain middleware — minimal auth
function authMiddleware(req, res, next) {
  if (req.path === '/ping') return next();
  const token = process.env.AUTH_TOKEN;
  if (!token) return next(); // no token configured = open (dev)
  const provided = req.headers.authorization?.replace('Bearer ', '');
  if (provided !== token) return res.status(401).json({ error: 'unauthorized' });
  next();
}
```

---

### 2. Adopt MCP with Three-Tier Skill Hosting

**Impact: High | Effort: Medium**

**What:** Replace the bespoke `BakerstPlugin` interface with MCP (Model Context Protocol), using a three-tier hosting model that avoids pod sprawl while preserving isolation where it matters.

**Why:**
- MCP is the Anthropic-backed standard for tool integration in the AI ecosystem
- The awesome-agent-skills repo and most Claude Code skills assume MCP
- Your existing `PluginToolDefinition` already maps almost 1:1 to MCP's tool schema
- MCP supports stdio, HTTP+SSE, and Streamable HTTP transports — the brain can connect to skills at any tier without code changes

**How it maps:**

| Current BakerstPlugin | MCP Equivalent |
|---------------------|----------------|
| `tools[]` | `tools/list` response |
| `input_schema` | MCP tool `inputSchema` (identical JSON Schema) |
| `execute(name, input)` | `tools/call` request/response |
| `onTrigger()` | MCP notifications / resources |
| `PluginContext` | Not needed — MCP servers are independent processes |

**Three-Tier Hosting Model:**

| Tier | Transport | What It Is | Overhead | Use When |
|------|-----------|-----------|----------|----------|
| **Tier 0** | N/A | Instruction skills — markdown injected into system prompt | Zero | Behavior/style guidance, awesome-agent-skills imports |
| **Tier 1** | stdio | Brain spawns MCP server as a child process | ~5MB per process, zero pods | Simple tools, stateless utilities, most third-party skills |
| **Tier 2** | HTTP (localhost) | Sidecar container in the brain pod | Container overhead, zero extra pods | Skills needing isolated deps, credentials, or persistent state (e.g., Gmail/gog) |
| **Tier 3** | HTTP (ClusterIP) | Separate Deployment/Service | Full pod overhead | Heavy resources (browser/Chrome ~1GB), independent scaling, hard isolation |

**Why NOT an MCP Broker/Ingress:**
A single MCP reverse-proxy that fans out to skill backends is tempting but wrong for this system:
- The brain already IS the fan-out point — it connects to each skill as an MCP client
- A broker adds a single point of failure between brain and skills
- No existing MCP reverse-proxy exists in the ecosystem — you'd build custom infrastructure
- The three-tier model eliminates the pod-sprawl problem that motivates a broker in the first place

**Trade-offs:** Tier 1 (stdio) skills share the brain's process group, so a misbehaving one could consume CPU/memory. Mitigate with Node.js `child_process` resource limits and watchdog monitoring. For anything untrusted, promote to Tier 2 or Tier 3.

**Next steps:**
1. Create an `McpClientManager` in the brain that handles all three transports (stdio/HTTP/Streamable HTTP)
2. Wrap existing plugins (gmail, browser) as MCP servers — their tool schemas are already compatible
3. Add a skill registry to the brain config with `tier` and `transport` fields (replaces `PLUGINS.json`)
4. Keep backward compatibility with `BakerstPlugin` during transition via a thin bridge adapter
5. Define the promotion criteria (Tier 1 → 2 → 3) based on resource usage and isolation needs

---

### 3. Build a Model Provider Abstraction Layer

**Impact: High | Effort: Medium**

**What:** Create a `ModelRouter` service that abstracts model selection, supports multiple providers, and enables per-task model routing.

**Why:** Currently hardcoded to `claude-sonnet-4-20250514`. You want Claude OAuth as default, OpenRouter as fallback, local models for TTS/STT, and cheaper models for simple tasks.

**Architecture:**

```typescript
// packages/shared/src/model-router.ts
interface ModelRouterConfig {
  providers: {
    anthropic: { authToken?: string; apiKey?: string };
    openrouter?: { apiKey: string };
    local?: { baseUrl: string; format: 'openai' | 'ollama' };
  };
  defaultModel: string;           // e.g., "claude-sonnet-4-20250514"
  authorizedModels: string[];     // whitelist
  skillModelOverrides: Record<string, string>; // skill -> model
  fallbackChain: string[];        // try in order
  costLimits?: { dailyUsd: number; perRequestMaxTokens: number };
}

interface ModelRouter {
  chat(params: ChatParams): Promise<ChatResponse>;
  chatStream(params: ChatParams): AsyncGenerator<StreamEvent>;
}
```

**Provider support pattern:**
- Anthropic: use `@anthropic-ai/sdk` directly (current behavior)
- OpenRouter: Anthropic SDK with `baseURL: 'https://openrouter.ai/api/v1'`
- Local (OpenAI-compatible): use `openai` SDK with custom `baseURL`
- Local (Ollama): use Ollama's OpenAI-compatible endpoint (`/v1/chat/completions`)
- MLX: same as OpenAI-compatible (MLX servers expose OpenAI-format endpoints)

**Next steps:**
1. Define `ModelRouterConfig` in shared package
2. Create provider adapters with a common interface
3. Add model selection to skill/agent config
4. Add `models` page to web console for managing the authorized list
5. Wire `ModelRouter` into `createAgent()` replacing the direct Anthropic client

---

### 4. Tier-Based Skill Isolation (Replaces In-Process Plugins)

**Impact: High | Effort: Medium**

**What:** Move plugins out of the brain process using the three-tier hosting model from Recommendation #2. Each skill runs at the tier appropriate to its resource and isolation needs.

**Why:** In-process plugins can crash the brain, leak memory, access all brain-process secrets, and can't be independently scaled or updated. The tiered model fixes this without creating a pod for every simple tool.

**Tier Decision Matrix:**

| Question | If Yes → | If No → |
|----------|----------|---------|
| Is it just instructions/behavior? | Tier 0 | Continue |
| Does it need < 50MB and no special deps? | Tier 1 (stdio) | Continue |
| Does it need isolated deps or credentials? | Tier 2 (sidecar) | Continue |
| Does it need > 256MB, GPU, or hard isolation? | Tier 3 (separate pod) | Tier 2 |

**Tier promotion path:** A skill always starts at the lowest viable tier and promotes only when needed. This is a one-line config change (update `tier` and `transport` in the skill registry) — no code changes required.

**Current skills mapped to tiers:**

| Skill | Current | Target Tier | Rationale |
|-------|---------|------------|-----------|
| Gmail | In-process plugin | Tier 2 (sidecar) | Needs `gog` binary + Google credentials |
| Browser | Separate pod | Tier 3 (separate pod) | Chrome needs ~1GB RAM |
| awesome-agent-skills imports | N/A | Tier 0 (instruction) | Markdown files, zero overhead |
| Future simple tools | N/A | Tier 1 (stdio) | Most MCP servers are lightweight |

```yaml
# Example: Brain pod with Tier 2 Gmail sidecar
apiVersion: apps/v1
kind: Deployment
metadata:
  name: brain
spec:
  template:
    spec:
      containers:
        - name: brain
          image: bakerst-brain:latest
          # Brain connects to sidecar at localhost:3100
        - name: mcp-gmail        # Tier 2: sidecar
          image: bakerst-mcp-gmail:latest
          ports:
            - containerPort: 3100
          resources:
            limits: { memory: 128Mi, cpu: 200m }
          env:
            - name: GOG_CREDENTIALS_JSON
              valueFrom:
                secretKeyRef:
                  name: bakerst-secrets
                  key: GOG_CREDENTIALS_JSON
```

**Trade-offs:** Tier 1 skills share the brain's process group (risk if misbehaving), but resource limits and process watchdogs mitigate this. Tier 2 sidecars share the pod's network namespace, so communication is `localhost:PORT` — fast and simple, zero extra Services needed.

---

### 5. Add Network Policies

**Impact: High | Effort: Low**

**What:** Restrict which pods can talk to which.

**Why:** Currently every pod can reach every other pod and the internet. A compromised plugin container could attack NATS, read Qdrant, or exfiltrate data.

```yaml
# k8s/network-policies.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: brain-policy
  namespace: bakerst
spec:
  podSelector:
    matchLabels:
      app: brain
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: ui
        - podSelector:
            matchLabels:
              app: gateway
      ports:
        - port: 3000
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: nats
      ports:
        - port: 4222
    - to:
        - podSelector:
            matchLabels:
              app: qdrant
      ports:
        - port: 6333
    - to: # Anthropic API + Voyage AI
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - port: 443
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: worker-policy
  namespace: bakerst
spec:
  podSelector:
    matchLabels:
      app: worker
  policyTypes: [Ingress, Egress]
  ingress: [] # workers receive via NATS subscription, not direct ingress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: nats
      ports:
        - port: 4222
    - to: # Anthropic API for agent-type jobs
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - port: 443
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: bakerst
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```

**Note:** Docker Desktop's built-in CNI may not enforce NetworkPolicies. You'd need Calico or Cilium. For local dev, this is a "design now, enforce when moving to real k8s" item.

---

### 6. Design Ephemeral Privileged Execution

**Impact: High | Effort: Medium-High**

**What:** A mechanism for the brain to spawn short-lived K8s Jobs with scoped, time-bounded permissions for tasks that exceed the base worker's capabilities.

**Design:**

```
User: "Reorganize my Documents folder"
  │
  ▼
Brain detects elevated permission needed
  │
  ▼
Brain creates EphemeralTaskRequest:
  {
    task: "reorganize-documents",
    permissions: ["filesystem:/Users/gary/Documents:rw"],
    ttlSeconds: 300,
    approvalRequired: true
  }
  │
  ▼
[If approvalRequired] → UI notification → User approves
  │
  ▼
Brain creates K8s Job via API:
  - Unique ServiceAccount (created per-job, deleted after)
  - Volume mount for /Users/gary/Documents
  - activeDeadlineSeconds: 300
  - ttlSecondsAfterFinished: 60
  - Pod Security: restricted profile + gVisor if available
  │
  ▼
Job runs, writes results to NATS or a ConfigMap
  │
  ▼
Brain reads results, deletes Job + ServiceAccount
  │
  ▼
Audit log entry written
```

```yaml
# Example ephemeral job template
apiVersion: batch/v1
kind: Job
metadata:
  name: ephemeral-task-${TASK_ID}
  namespace: bakerst
  labels:
    app: bakerst-ephemeral
    task-id: ${TASK_ID}
  annotations:
    bakerst.io/requester: brain
    bakerst.io/approved-by: user
    bakerst.io/permission-scope: "filesystem:/Users/gary/Documents:rw"
spec:
  activeDeadlineSeconds: 300
  ttlSecondsAfterFinished: 60
  backoffLimit: 0
  template:
    spec:
      serviceAccountName: ephemeral-${TASK_ID}
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: task
          image: bakerst-ephemeral-runner:latest
          resources:
            limits:
              memory: 512Mi
              cpu: "1"
          volumeMounts:
            - name: target
              mountPath: /workspace
          env:
            - name: TASK_DESCRIPTION
              value: "${TASK_DESCRIPTION}"
            - name: NATS_URL
              value: "nats://nats.bakerst.svc.cluster.local:4222"
            - name: RESULT_SUBJECT
              value: "bakerst.ephemeral.result.${TASK_ID}"
      volumes:
        - name: target
          hostPath:
            path: /Users/gary/Documents
            type: Directory
```

**Policy controls:**
- Brain's RBAC role needs `create` for `jobs` and `serviceaccounts` (but only in bakerst namespace)
- Kyverno policy to enforce: `activeDeadlineSeconds <= 600`, `ttlSecondsAfterFinished` is set, securityContext is restricted, only allowed volume paths
- User approval required for any filesystem mount outside `/tmp`
- All ephemeral job logs collected and stored in audit table

**Should you keep a privileged worker around?** No. The threat model for a personal system is that a plugin compromise or prompt injection could escalate through a standing privileged pod. On-demand jobs with TTLs are safer — the attack window is bounded. The only exception would be the browser pod, which is already standing because Chrome startup is slow (~5s), making it justified for interactive use.

---

### 7. Add Ingress with TLS (Caddy or Traefik)

**Impact: Medium | Effort: Low-Medium**

**What:** Proper ingress for external access, replacing port-forward.

**Recommendation: Caddy** for this use case.

**Why Caddy over alternatives:**

| Feature | Caddy | Traefik | NGINX Ingress |
|---------|-------|---------|---------------|
| Automatic TLS (ACME) | Built-in, zero-config | Supported | Requires cert-manager |
| Config complexity | Caddyfile (simple) | YAML (moderate) | Annotations (complex) |
| WebSocket/SSE | Native | Native | Requires annotations |
| Auth middleware | basicauth/forward_auth built-in | ForwardAuth | External auth |
| Resource usage | ~20MB | ~50MB | ~100MB |
| K8s integration | Ingress controller available | Native | Native |

For a **personal system on Mac**, Caddy's simplicity wins. You don't need the enterprise features of Traefik or NGINX.

**However**, since you already have nginx inside the UI container, the simplest migration is:

1. **Phase 1 (now):** Replace the UI's nginx with Caddy in the UI Dockerfile — get automatic HTTPS for free
2. **Phase 2 (later):** If you want K8s-native ingress, deploy Caddy as a standalone ingress controller

```
# Caddyfile (replaces nginx.conf in the UI container)
:8080 {
  handle /api/* {
    reverse_proxy brain.bakerst.svc.cluster.local:3000 {
      header_up X-Real-IP {remote_host}
      flush_interval -1  # disable buffering for SSE
    }
  }
  handle {
    root * /srv
    try_files {path} /index.html
    file_server
    header /assets/* Cache-Control "public, max-age=31536000, immutable"
  }
}
```

For **external access with TLS** on Docker Desktop, the practical approach is:
- Option A: **Tailscale** (recommended for personal use) — install on the Mac, expose port 30080 via Tailscale, automatic TLS via Tailscale certificates. No Caddy needed for TLS.
- Option B: **Caddy on host** — run Caddy outside k8s, reverse proxy to NodePort, automatic ACME TLS with a domain name.
- Option C: **Cloudflare Tunnel** — no exposed ports, no TLS setup needed.

For all options, add auth middleware (see Recommendation #1).

---

### 8. Add Observability (OpenTelemetry)

**Impact: Medium | Effort: Medium**

**What:** Instrument all services with OpenTelemetry for traces, metrics, and structured logs.

**Why:** When tool calls fail, take too long, or produce wrong results, you currently have only `pino` logs to debug. With tracing, you'd see the full path: `user message → brain → Claude API → tool call → plugin → worker → result`.

**Next steps:**
1. Add `@opentelemetry/auto-instrumentations-node` to brain and worker
2. Deploy a lightweight collector (Grafana Alloy or OpenTelemetry Collector) as a DaemonSet
3. For storage, use Grafana Cloud free tier (50GB logs, 10k metrics, 50GB traces) or self-hosted Grafana + Loki + Tempo
4. Add correlation IDs to NATS messages (already have `jobId` — use it as the trace/span ID)
5. Add `traceId` to all API responses and SSE events so the UI can link to traces

```typescript
// brain/src/tracing.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  serviceName: 'bakerst-brain',
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://otel-collector:4318/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
```

---

### 9. Add CI/CD with GitHub Actions

**Impact: Medium | Effort: Low**

**What:** Automated lint, type-check, test, build, and (optionally) deploy on push/PR.

```yaml
# .github/workflows/ci.yaml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - run: pnpm -r lint   # add eslint to each workspace
      - run: pnpm -r test   # add vitest to each workspace
  docker:
    needs: check
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          docker build -t bakerst-brain:${{ github.sha }} -f services/brain/Dockerfile .
          docker build -t bakerst-worker:${{ github.sha }} -f services/worker/Dockerfile .
          docker build -t bakerst-ui:${{ github.sha }} -f services/ui/Dockerfile .
          docker build -t bakerst-gateway:${{ github.sha }} -f services/gateway/Dockerfile .
```

---

### 10. Self-Update Mechanism (Future)

**Impact: Medium | Effort: Medium-High**

**What:** An "updater" pod/CronJob that checks for merged PRs, pulls changes, rebuilds, deploys, tests, and rolls back if health checks fail.

**Design:**

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: bakerst-updater
  namespace: bakerst
spec:
  schedule: "0 */6 * * *"  # every 6 hours
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: updater
          containers:
            - name: updater
              image: bakerst-updater:latest
              env:
                - name: GITHUB_TOKEN
                  valueFrom:
                    secretKeyRef:
                      name: bakerst-secrets
                      key: GITHUB_TOKEN
                - name: WATERMARK_FILE
                  value: /data/updater/last-update.json
              volumeMounts:
                - name: data
                  mountPath: /data/updater
          restartPolicy: OnFailure
```

The updater script would:
1. `gh api repos/garyld1962/Baker Street/pulls?state=closed&sort=updated&direction=desc` — check for merges since watermark
2. If new merges found: `git pull`, `pnpm install && pnpm -r build`, `scripts/build.sh`
3. Roll out with `kubectl rollout restart` for each deployment
4. Wait for rollout to complete, run health checks
5. If health checks fail: `kubectl rollout undo` for each deployment
6. Update watermark, log results

**Trade-off:** This gives Baker Street write access to her own deployments, which is a privileged operation. Mitigate with: separate namespace for updater, separate ServiceAccount, audit logging, and a "last known good" rollback target.

---

## 4) Deep Dives

### A) Inter-pod Communication & Orchestration

**Assessment:** NATS is already a good choice and you should keep it. The current implementation is functional but lacks several reliability features.

**Current state:**
- Brain → Worker: NATS pub/sub with queue groups (good)
- Worker → Brain: NATS pub for status updates (good)
- UI → Brain: HTTP/SSE (good)
- Gateway → Brain: HTTP (good, but no streaming)

**Recommendations:**

**1. Upgrade to NATS JetStream** for durable delivery. Currently, if the brain crashes while a worker is publishing a status update, that status is lost. JetStream adds at-least-once delivery with acknowledgment.

```typescript
// Upgrade: Use JetStream for job dispatch
const js = nc.jetstream();
const jsm = await nc.jetstreamManager();

// Create stream (once, at startup)
await jsm.streams.add({
  name: 'BAKERST_JOBS',
  subjects: ['bakerst.jobs.dispatch', 'bakerst.jobs.status.>'],
  retention: RetentionPolicy.Limits,
  max_msgs: 10000,
  max_age: 24 * 60 * 60 * 1_000_000_000, // 24h in nanoseconds
});

// Publish with ack
await js.publish('bakerst.jobs.dispatch', codec.encode(job));

// Consume with explicit ack
const consumer = await js.consumers.get('BAKERST_JOBS', 'workers');
for await (const msg of consumer.consume()) {
  const job = codec.decode(msg.data);
  await handleJob(job);
  msg.ack();
}
```

**2. Add correlation IDs.** You already have `jobId` — propagate it as a tracing context through all NATS messages and HTTP headers.

**3. Add idempotency.** Workers should check if a job was already processed before executing (deduplicate by `jobId` in SQLite). This protects against JetStream redelivery.

**4. Backpressure.** Add a max concurrent jobs limit to the worker. Currently it processes all incoming jobs concurrently without bound:

```typescript
// worker/src/index.ts — add semaphore
const MAX_CONCURRENT = 3;
let running = 0;

sub.callback = async (err, msg) => {
  if (running >= MAX_CONCURRENT) {
    msg.nak(5000); // redeliver after 5s
    return;
  }
  running++;
  try {
    await handleJob(codec.decode(msg.data));
    msg.ack();
  } finally {
    running--;
  }
};
```

**5. Gateway should use streaming.** Currently the gateway calls `POST /chat` (blocking). It should call `POST /chat/stream` and progressively send typing indicators + chunked responses. This would reduce the perceived latency on Telegram/Discord significantly.

**6. Contract versioning.** Add a `version` field to `JobDispatch` and `JobStatus`. When you make breaking changes to the schema, workers can check the version and handle migrations or reject incompatible jobs.

**Verdict:** Keep NATS. Upgrade to JetStream. Add the reliability features above. This is already 80% of a solid communication layer.

---

### B) Agent/Skill Architecture ("Anthropic-compatible") — Three-Tier Model

**Recommendation: Adopt MCP as the primary skill interface, using a three-tier hosting model that eliminates pod sprawl while preserving isolation where it matters.**

**Rationale:**
- MCP is the Anthropic-backed standard for tool integration
- The awesome-agent-skills repo's skills are mostly Claude Code skills (markdown instruction files)
- Your `PluginToolDefinition` is structurally identical to MCP's tool schema
- MCP gives you process isolation without custom IPC
- The three-tier model ensures you don't create pods for every simple MCP skill

#### Tier 0: Instruction Skills (Zero Overhead)

Markdown files injected into the system prompt. No process, no container, no network call.

**When to use:** Behavior guidance, style rules, Claude Code skills from awesome-agent-skills.

```typescript
// brain/src/skill-loader.ts
interface InstructionSkill {
  name: string;
  version: string;
  description: string;
  instructions: string;  // markdown content
  source: 'local' | 'github';
  repo?: string;         // e.g., "anthropics/claude-code/tree/main/.claude/skills/docx"
}

// At chat time, instruction skills are appended to the system prompt
function buildSystemPromptWithSkills(
  basePrompt: string,
  enabledSkills: InstructionSkill[]
): string {
  const skillBlocks = enabledSkills.map(s =>
    `\n\n---\n\n## Skill: ${s.name}\n\n${s.instructions}`
  );
  return basePrompt + skillBlocks.join('');
}
```

**Limit:** ~10-15 instruction skills before system prompt gets unwieldy. Beyond that, use dynamic selection (semantic similarity to the user's query).

#### Tier 1: stdio MCP Servers (Zero Extra Pods)

The brain spawns the MCP server as a child process via `StdioClientTransport`. The skill runs as a subprocess of the brain — same pod, same node, zero network overhead.

**When to use:** Simple tools, stateless utilities, lightweight third-party MCP servers, any skill that needs < 50MB and no special OS dependencies.

```
┌────────────────────────────────────────┐
│              Brain Pod                  │
│                                        │
│  brain process (PID 1)                 │
│    ├── MCP Client (stdio) ──┐          │
│    │                        ▼          │
│    │                 skill-a (PID 42)  │
│    │                 stdin/stdout      │
│    │                                   │
│    ├── MCP Client (stdio) ──┐          │
│    │                        ▼          │
│    │                 skill-b (PID 43)  │
│    │                 stdin/stdout      │
│    │                                   │
│    └── [brain logic, Claude API, etc]  │
└────────────────────────────────────────┘
```

**Advantages:** Zero network latency. Zero extra containers. Process dies → brain respawns it. Simple.

**Risks & mitigations:**
- Risk: Runaway CPU/memory from child process → Mitigation: Set `ulimit` via spawn options, watchdog timer kills processes exceeding thresholds
- Risk: Child process crash → Mitigation: Brain catches exit event, restarts, logs to audit
- Risk: Shared filesystem → Mitigation: Child inherits brain's read-only rootfs; no host mounts unless explicitly configured

#### Tier 2: Sidecar MCP Servers (Container Isolation, Zero Extra Pods)

The MCP server runs as a sidecar container within the brain pod. Communication is `localhost:PORT` — no K8s Service needed.

**When to use:** Skills that need isolated dependencies (binaries like `gog`, Python runtimes), separate credentials, or persistent local state.

```
┌────────────────────────────────────────────────┐
│                    Brain Pod                    │
│                                                │
│  ┌──────────────┐    ┌──────────────────────┐  │
│  │    brain      │    │  mcp-gmail (sidecar) │  │
│  │    :3000      │    │  :3100               │  │
│  │               │    │                      │  │
│  │  MCP Client ──┼──► │  gog binary          │  │
│  │  (HTTP)       │    │  Google creds         │  │
│  │               │    │  Streamable HTTP      │  │
│  └──────────────┘    └──────────────────────┘  │
│                                                │
│  Shared: network namespace (localhost),         │
│          pod lifecycle, node affinity           │
│  Isolated: filesystem, env vars, secrets,       │
│            resource limits, process space        │
└────────────────────────────────────────────────┘
```

**Advantages:** Full container isolation (separate filesystem, process space, resource limits). No extra pods or Services. Skills can have their own base image (Python, Go, etc.).

**Key pattern:** Each sidecar gets only the secrets it needs via explicit `secretKeyRef`, not `envFrom`. The brain communicates via `http://localhost:<port>`.

#### Tier 3: Separate Pod MCP Servers (Full Isolation)

The MCP server runs as its own Deployment + Service. The brain connects via `http://<service>.bakerst.svc.cluster.local:<port>`.

**When to use:** Heavy resource consumers (browser/Chrome needs ~1GB), skills that need independent scaling, skills requiring hard security isolation (network policies, seccomp profiles).

```
┌──────────────┐         ┌───────────────────────┐
│  Brain Pod   │  HTTP   │  Browser Pod           │
│              │────────►│                        │
│  MCP Client  │         │  chromedp/headless     │
│              │         │  MCP server :3200      │
│              │         │  ~1GB RAM              │
└──────────────┘         └───────────────────────┘
       K8s Service: browser.bakerst.svc.cluster.local:3200
```

**Advantages:** Independent resource limits, independent scaling (can run 0 replicas when idle), network policies can restrict what the skill can reach, can use different security contexts.

**When Tier 3 is justified:**
- Resource usage > 256MB (e.g., Chrome, GPU workloads)
- Needs to scale independently (e.g., multiple browser sessions)
- Hard security boundary required (untrusted code, external network access)
- Startup time makes on-demand impractical (Chrome ~5s startup → keep running)

#### Tier Decision Matrix

```
Is it just instructions/behavior? ──yes──► Tier 0 (instruction)
              │ no
              ▼
Needs < 50MB, no special deps? ──yes──► Tier 1 (stdio)
              │ no
              ▼
Needs isolated deps/creds,
but < 256MB? ──yes──► Tier 2 (sidecar)
              │ no
              ▼
              Tier 3 (separate pod)
```

**Promotion path:** A skill starts at the lowest viable tier and promotes up only when needed. Promotion is a config-only change — update the `tier` and `transport` fields in the skill registry. The brain's `McpClientManager` handles all transports identically from the tool-call perspective.

#### Why NOT an MCP Broker/Ingress

A single MCP reverse-proxy that fans out to skill backends seems appealing (one URL, many skills behind it). **Don't build this:**

1. **The brain already IS the fan-out point.** It connects to each MCP server independently. A broker would just duplicate this role.
2. **Single point of failure.** Every tool call would route through the broker. If it goes down, ALL skills are unavailable.
3. **No ecosystem support.** There is no MCP reverse-proxy in the MCP SDK, community, or spec. You'd be building custom infrastructure with zero reuse.
4. **The three-tier model eliminates the motivation.** The broker idea arises from wanting to avoid per-skill pods. But Tier 1 (stdio) and Tier 2 (sidecar) already avoid extra pods — so there's no pod sprawl to broker around.
5. **Protocol complexity.** MCP supports server-initiated notifications and bidirectional communication. A transparent broker would need to handle connection lifecycle, capability negotiation, and streaming — far more complex than an HTTP reverse proxy.

#### Skill Discovery and Installation Flow

```
Web Console → "Install Skill" button
  │
  ├── Upload .md file → Tier 0 (instruction skill)
  ├── Enter npm/GitHub URL → Tier 1 (stdio MCP server)
  ├── Enter MCP server URL → Tier 2/3 (HTTP MCP server)
  └── Browse registry (future)
  │
  ▼
Validate:
  - Tier 0: Lint instruction content (no prompt injection patterns)
  - Tier 1: Test stdio spawn, verify tool schemas, check resource usage
  - Tier 2/3: Test HTTP connection, verify tool schemas, scan container image (Trivy)
  │
  ▼
Store in skill registry (SQLite) with tier assignment
  │
  ▼
Enable/disable without restart (hot-reload for Tier 0/1, pod restart for Tier 2)
```

#### Sandboxed Execution by Tier

| Tier | Filesystem | Network | Secrets | Resources |
|------|-----------|---------|---------|-----------|
| 0 | N/A (text only) | N/A | N/A | System prompt token budget |
| 1 | Inherits brain's read-only rootfs | Inherits brain's network | Inherits brain env (use sparingly) | `ulimit` via spawn options |
| 2 | Own container filesystem | localhost only (pod network) | Explicit `secretKeyRef` per sidecar | Container `resources.limits` |
| 3 | Own container filesystem | NetworkPolicy restricted | Explicit `secretKeyRef` | Pod `resources.limits` + PDB |

For instruction-based skills (Tier 0), the "sandbox" is the simplest — they're just text injected into the system prompt. The risk is prompt injection, which you mitigate with content scanning before installation.

---

### C) Ephemeral Privileged Execution

Covered in Recommendation #6 above. Additional details:

**Permission taxonomy:**

```typescript
interface EphemeralPermission {
  type: 'filesystem' | 'network' | 'secret' | 'k8s-api';

  // For filesystem
  path?: string;
  accessMode?: 'ro' | 'rw';

  // For network
  cidr?: string;
  ports?: number[];

  // For secret
  secretName?: string;
  keys?: string[];

  // For k8s-api
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
}

interface EphemeralTaskRequest {
  taskId: string;
  description: string;
  permissions: EphemeralPermission[];
  ttlSeconds: number;
  image?: string;           // default: bakerst-ephemeral-runner
  approvalRequired: boolean;
  requestedBy: string;      // 'brain' | 'user' | skill name
}
```

**Approval workflow:**

| Permission Type | Auto-Approve | Requires User Approval |
|----------------|-------------|----------------------|
| Read filesystem under `/tmp` | Yes | No |
| Read/write user directories | No | Yes |
| Network access to new CIDRs | No | Yes |
| Access to secrets | No | Yes |
| K8s API access | No | Yes |

For this personal system, the approval mechanism is simple: the brain sends a WebSocket/SSE event to the UI asking for confirmation. The UI shows a modal with the permission details. User clicks approve or deny.

**Audit logging:**

```sql
CREATE TABLE ephemeral_audit (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  event TEXT NOT NULL,  -- 'requested', 'approved', 'denied', 'started', 'completed', 'failed', 'cleaned_up'
  permissions TEXT,      -- JSON
  requested_by TEXT,
  approved_by TEXT,
  timestamp TEXT NOT NULL,
  details TEXT           -- JSON: logs, exit code, artifacts
);
```

---

### D) Ingress / Gateway / Networking

**Recommendation: Caddy** (see Recommendation #7 above).

**Additional detail on migration:**

**Phase 1: Replace nginx with Caddy in UI container**
- Replace `services/ui/Dockerfile` FROM nginx:1.27-alpine → caddy:2-alpine
- Replace `nginx.conf` with `Caddyfile`
- Same port (8080), same behavior, but with better SSE support and simpler config
- Zero risk — functionally identical

**Phase 2: External access with TLS**

For a personal system on Docker Desktop Mac:
- Option A: **Tailscale** (recommended for personal use) — install on the Mac, expose port 30080 via Tailscale, automatic TLS via Tailscale certificates. No Caddy needed for TLS.
- Option B: **Caddy on host** — run Caddy outside k8s, reverse proxy to NodePort, automatic ACME TLS with a domain name.
- Option C: **Cloudflare Tunnel** — no exposed ports, no TLS setup needed.

For all options, add auth middleware (see Recommendation #1).

---

### E) Configuration Model & Consistency

**Current state:** Configuration is fragmented:
- `PLUGINS.json` / `CRONS.json` / `TRIGGERS.json` → ConfigMap
- Secrets → K8s Secret
- Personality files → ConfigMap
- Service endpoints → hardcoded env vars in manifests
- Model selection → hardcoded in source code

**Proposed unified config model:**

```yaml
# operating_system/bakerst-config.yaml (single source of truth)
apiVersion: bakerst.io/v1alpha1
kind: Baker StreetConfig
metadata:
  name: bakerst
spec:
  brain:
    model: claude-sonnet-4-20250514
    maxToolIterations: 10
    maxTokens: 4096
    systemPromptFiles: [SOUL.md, BRAIN.md]

  skills:
    # Tier 0: Instruction skills — injected into system prompt
    - name: docx-converter
      tier: 0
      type: instruction
      source: github:anthropics/claude-code/.claude/skills/docx
      enabled: true

    # Tier 1: stdio MCP — brain spawns as child process
    - name: filesystem-tools
      tier: 1
      type: mcp-server
      transport: stdio
      command: npx
      args: ["-y", "@anthropic/mcp-server-filesystem", "/workspace"]
      enabled: true

    # Tier 2: Sidecar MCP — container in brain pod, localhost
    - name: gmail
      tier: 2
      type: mcp-server
      transport: http
      url: http://localhost:3100  # sidecar in brain pod
      enabled: true
      model: null  # use default
      secrets: [GOG_CREDENTIALS_JSON, GOG_TOKEN_JSON]
      config:
        account: gary.davidson@gmail.com

    # Tier 3: Separate pod MCP — own Deployment + Service
    - name: browser
      tier: 3
      type: mcp-server
      transport: http
      url: http://browser.bakerst.svc.cluster.local:3200
      enabled: true

  models:
    default: claude-sonnet-4-20250514
    authorized:
      - claude-sonnet-4-20250514
      - claude-haiku-4-5-20251001
      - claude-opus-4-6
    providers:
      anthropic:
        authType: oauth  # 'oauth' | 'api-key'
        secretRef: bakerst-secrets
      openrouter:
        secretRef: openrouter-secret
      local:
        url: http://host.docker.internal:11434/v1  # Ollama

  crons: []
  triggers: []
```

**Why this matters:** Right now, adding a new skill requires editing 3 files (PLUGINS.json, Dockerfile, package.json), rebuilding, and redeploying. With a unified config, you edit one file and the brain hot-reloads.

**Deployment tooling: Keep Kustomize**, but add overlays:

```
k8s/
├── base/                   # current manifests
│   ├── kustomization.yaml
│   └── ...
└── overlays/
    ├── dev/                # hostPath, Never pull, port-forward
    │   └── kustomization.yaml
    └── prod/               # PVCs, registry, ingress, TLS
        └── kustomization.yaml
```

---

### F) Web Console UX for Skills/Agents

**Extend the existing React UI.** It's React 19 + Vite + Tailwind — already a good stack. Add these pages:

| Page | Route | Purpose |
|------|-------|---------|
| **Skills** | `/skills` | List installed skills, enable/disable, install new |
| **Skill Detail** | `/skills/:id` | Configure, test, view logs for one skill |
| **Models** | `/models` | Manage authorized models, set defaults |
| **System** | `/system` | View system health, restart services, view audit logs |

**Skills page UX flow:**

```
/skills
├── [Installed Skills]
│   ├── gmail (MCP, enabled) ────── [Configure] [Disable] [Logs]
│   ├── browser (MCP, enabled) ──── [Configure] [Disable] [Logs]
│   └── docx (Instruction, enabled) [Configure] [Disable]
│
├── [Install New Skill]
│   ├── [Upload .md file]           → validates, stores, enables
│   ├── [From GitHub URL]           → clones, validates, registers
│   ├── [From MCP Server URL]       → connects, lists tools, registers
│   └── [Browse Registry] (future)
│
└── [Skill Detail: gmail]
    ├── Status: Connected
    ├── Tools: gmail_search, gmail_read, gmail_send, gmail_list_labels
    ├── Model: (default: claude-sonnet-4-20250514)
    ├── Config: { account: "gary.davidson@gmail.com", ... }
    ├── Permissions: [GOG_CREDENTIALS_JSON, GOG_TOKEN_JSON]
    ├── [Test] → sandbox run with sample input
    └── [Logs] → tail recent tool call logs for this skill
```

**Backend services needed:**

```
Brain API additions:
  GET  /skills                    → list all skills with status
  POST /skills                    → install new skill
  PUT  /skills/:id                → update config/enable/disable
  DELETE /skills/:id              → uninstall
  POST /skills/:id/test           → sandbox test run
  GET  /skills/:id/logs           → recent tool calls for this skill

  GET  /models                    → list authorized models
  PUT  /models                    → update model config

  GET  /system/health             → component health status
  GET  /system/audit              → audit log entries
```

**Preventing malicious plugins:**
1. **Instruction skills:** Scan for prompt injection patterns before storing. Run a "canary" test (send to Claude with a test prompt, check the response isn't harmful).
2. **MCP servers:** Run in isolated containers with resource limits and network policies. Monitor tool call latency and error rates. Auto-disable skills that exceed error thresholds.
3. **Container images:** Scan with Trivy before deploying. Pin to specific digests, not tags.
4. **All skills:** Rate-limit tool calls per skill. Log all tool inputs/outputs for audit.

---

### G) Model Provider Abstraction & Routing

**Design a `ModelRouter` class** that the brain uses instead of directly creating an Anthropic client.

```typescript
// packages/shared/src/model-router.ts

interface ChatRequest {
  model?: string;          // override default
  messages: Message[];
  system?: SystemBlock[];
  tools?: Tool[];
  maxTokens?: number;
  stream?: boolean;
}

interface ModelRouter {
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream(req: ChatRequest): AsyncGenerator<StreamEvent>;
  listModels(): ModelInfo[];
}

class ModelRouterImpl implements ModelRouter {
  private providers: Map<string, Provider>;
  private config: ModelRouterConfig;

  resolveProvider(model: string): Provider {
    // Claude models → anthropic provider
    if (model.startsWith('claude-')) return this.providers.get('anthropic')!;
    // OpenRouter models → openrouter provider
    if (model.includes('/')) return this.providers.get('openrouter')!;
    // Local models → local provider
    return this.providers.get('local')!;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model ?? this.config.defaultModel;
    const provider = this.resolveProvider(model);

    try {
      return await provider.chat({ ...req, model });
    } catch (err) {
      // Try fallback chain
      for (const fallback of this.config.fallbackChain) {
        if (fallback === model) continue;
        try {
          return await this.resolveProvider(fallback).chat({ ...req, model: fallback });
        } catch { continue; }
      }
      throw err;
    }
  }
}
```

**Provider adapters:**

| Provider | SDK | Notes |
|----------|-----|-------|
| Anthropic (OAuth) | `@anthropic-ai/sdk` with `authToken` | Current default |
| Anthropic (API key) | `@anthropic-ai/sdk` with `apiKey` | Fallback |
| OpenRouter | `@anthropic-ai/sdk` with `baseURL` override | Works because OpenRouter supports Anthropic format |
| OpenAI-compatible | `openai` SDK with custom `baseURL` | For local/MLX models |
| Ollama | `openai` SDK with Ollama's OpenAI endpoint | `http://host.docker.internal:11434/v1` |

**Tool-use compatibility consideration:** Not all models support tool use the same way. The router should:
- For models without native tool use: fall back to "tools in system prompt" format
- For models with limited tool use: filter tools to the model's max tool count
- Track which models support streaming tool use vs batch

**Cost controls:**

```typescript
interface CostTracker {
  recordUsage(model: string, inputTokens: number, outputTokens: number): void;
  getDailySpend(): number;
  isWithinBudget(): boolean;
}
```

---

### H) Non-Functional: Security, Reliability, Observability, Maintainability

#### Threat Model Summary

| Attack Surface | Threat | Current Mitigation | Risk |
|---------------|--------|-------------------|------|
| Brain API | Unauthorized access to secrets, conversations, cluster control | None | **Critical** |
| Plugin uploads | Malicious code execution in brain process | None (in-process) | **High** |
| Worker shell execution | Command injection beyond allowlist | Allowlist check (bypassable via shell features) | **High** |
| NATS | Unauthorized pub/sub | No auth configured | **Medium** |
| Plugin CLI tools (gog, agent-browser) | Supply chain compromise | Pinned versions | **Low-Medium** |
| Prompt injection | User input manipulates tool calls | None (relies on Claude's built-in safety) | **Medium** |
| Container images | No scanning, `latest` tags | None | **Medium** |
| Network | No policies, no TLS | None | **Medium** |

#### Concrete Controls

**RBAC improvements:**
```yaml
# Tighten brain's role — currently can patch ANY deployment
- apiGroups: ["apps"]
  resources: ["deployments"]
  resourceNames: ["brain", "worker", "gateway"]  # ADD: restrict to named deployments
  verbs: ["get", "patch"]
```

**Secret management improvements:**
- Move from `envFrom` (all secrets in all pods) to specific `env.valueFrom.secretKeyRef` per pod
- Brain needs: `ANTHROPIC_*`, `VOYAGE_API_KEY`, `GOG_*`
- Gateway needs: `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`
- Worker needs: `ANTHROPIC_*` only

**Pod security context (add to all pods):**
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: [ALL]
  seccompProfile:
    type: RuntimeDefault
```

#### Observability

| Layer | Tool | Purpose |
|-------|------|---------|
| Logs | Pino (existing) + Grafana Loki | Structured JSON logs, already good |
| Metrics | OpenTelemetry → Prometheus/Grafana | Request latency, tool call counts, error rates |
| Traces | OpenTelemetry → Grafana Tempo | End-to-end request tracing |
| Dashboards | Grafana | SLOs, cost tracking, skill health |

**Key SLOs to define:**
- Chat response time p95 < 30s
- Tool call success rate > 95%
- Worker job completion rate > 99%
- Memory service availability > 99.5%

#### Reliability

**Current gaps and fixes:**

| Gap | Fix |
|-----|-----|
| No retry on Claude API failures | Add exponential backoff in `createAgent` |
| StatusTracker 120s timeout is hardcoded | Make configurable, add escalation (notify user on timeout) |
| Brain is single point of failure | For a personal system, 1 replica is fine — but add PodDisruptionBudget and graceful shutdown (already done) |
| SQLite on hostPath | For local dev this is fine. For production, consider PostgreSQL or keep SQLite with proper backups (cron job to copy the DB file) |
| No circuit breaker on external APIs | Add circuit breaker pattern for Anthropic/Voyage API calls |

#### Developer Experience

**Testing strategy:**
```
packages/shared/   → unit tests (vitest)
services/brain/    → unit tests for agent logic, integration tests for API
services/worker/   → unit tests for action handlers
services/gateway/  → integration tests with mock brain
services/ui/       → component tests (vitest + testing-library)
e2e/               → playwright tests against running cluster
```

Add to each workspace's `package.json`:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  }
}
```

**Local dev story improvements:**
- Add `docker-compose.yaml` for running NATS + Qdrant without k8s (faster iteration)
- Add `scripts/dev.sh` that starts brain + worker in watch mode
- Keep k8s for integration/staging

---

## 5) Proposed Target Architecture (North Star)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         External Access                              │
│                                                                      │
│  Tailscale / Caddy → TLS termination + auth                         │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
                    ┌───────▼───────┐
                    │    UI :8080   │
                    │  (Caddy SPA)  │
                    │  + Admin Panel│
                    │  + Chat       │
                    │  + Skills Mgmt│
                    │  + Models Mgmt│
                    └───────┬───────┘
                            │ /api/*
┌───────────────────────────▼───────────────────────────────────────────┐
│                         Brain Pod                                     │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                    brain container :3000                         │  │
│  │                                                                 │  │
│  │  ┌────────────┐  ┌──────────────┐  ┌────────────────────────┐  │  │
│  │  │ ModelRouter │  │ McpClient    │  │ Skill Registry         │  │  │
│  │  │            │  │ Manager      │  │ (SQLite + ConfigMap)    │  │  │
│  │  │ Anthropic  │  │              │  │                        │  │  │
│  │  │ OpenRouter │  │ stdio → T1   │  │ - tier per skill       │  │  │
│  │  │ Local/MLX  │  │ http  → T2/3 │  │ - enabled/disabled     │  │  │
│  │  └────────────┘  └──────┬───────┘  │ - model assignments    │  │  │
│  │                         │          └────────────────────────┘  │  │
│  │  Tier 0: instruction skills injected into system prompt        │  │
│  │  Tier 1: stdio child processes (skill-a PID, skill-b PID)     │  │
│  │                                                                 │  │
│  │  Auth | Tracing | Audit | Cost Tracking                        │  │
│  └─────────────────────────┬───────────────────────────────────────┘  │
│                             │ localhost                                │
│  ┌──────────────────────────▼──────────────────────────────────────┐  │
│  │  Tier 2: Sidecar Containers                                     │  │
│  │  ┌──────────────┐  ┌──────────────┐                             │  │
│  │  │ mcp-gmail    │  │ mcp-calendar │  (future sidecars)          │  │
│  │  │ :3100        │  │ :3101        │                             │  │
│  │  │ gog binary   │  │              │                             │  │
│  │  └──────────────┘  └──────────────┘                             │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
         │                                │
         │ NATS                           │ HTTP (ClusterIP)
         ▼                                ▼
┌────────────┐  ┌────────┐  ┌────────┐  ┌───────────────────────┐
│  NATS JS   │  │ Qdrant │  │ SQLite │  │ Tier 3: Separate Pods │
│  :4222     │  │ :6333  │  │ /data  │  │                       │
└────┬───────┘  └────────┘  └────────┘  │ ┌───────────────────┐ │
     │                                  │ │ Browser :3200     │ │
     ▼                                  │ │ chromedp + MCP    │ │
┌──────────┐                            │ │ ~1GB RAM          │ │
│ Worker   │                            │ └───────────────────┘ │
│ (NATS)   │                            └───────────────────────┘
└──────────┘

  [Ephemeral Jobs: K8s Jobs with TTL, scoped permissions]
  [Updater CronJob: auto-pull, build, deploy, rollback]
  [OTel Collector: traces/metrics → Grafana Cloud]
```

### Phased Migration Plan

| Phase | Focus | Duration | Key Deliverables |
|-------|-------|----------|-----------------|
| **1** | Security Basics | 1 week | Auth middleware, network policies, tighter RBAC, secrets per-pod, pod security contexts |
| **2** | MCP + Three-Tier Migration | 2 weeks | McpClientManager (stdio+HTTP), wrap gmail as Tier 2 sidecar, browser stays Tier 3, skill registry with tier field in SQLite, deprecate BakerstPlugin |
| **3** | Model Router | 1 week | ModelRouter abstraction, OpenRouter support, model config in DB, Models page in UI |
| **4** | Web Console Expansion | 2 weeks | Skills management page, model management, system health, audit log viewer |
| **5** | Observability | 1 week | OpenTelemetry integration, Grafana dashboards, structured audit logging |
| **6** | CI/CD | 1 week | GitHub Actions, automated tests (vitest), Docker build on merge |
| **7** | Ephemeral Execution | 2 weeks | K8s Job spawner, permission request/approval flow, cleanup automation |
| **8** | Tier 0 + Tier 1 Skills | 1 week | awesome-agent-skills import (Tier 0), stdio MCP skill loader (Tier 1), skill testing sandbox |
| **9** | Self-Update | 1 week | Updater CronJob, watermark tracking, rollback on failure |
| **10** | Ingress + TLS | 1 week | Caddy migration, Tailscale or ACME TLS, external access |

---

## 6) Example Snippets

### MCP Client Adapter (Brain) — Three-Tier Transport Support

```typescript
// brain/src/mcp-client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

interface McpSkillConfig {
  name: string;
  tier: 0 | 1 | 2 | 3;
  transport: 'stdio' | 'http';
  command?: string;         // for stdio (Tier 1)
  args?: string[];
  url?: string;             // for http (Tier 2 = localhost, Tier 3 = ClusterIP)
  enabled: boolean;
}

export class McpClientManager {
  private clients = new Map<string, Client>();
  private log: Logger;

  constructor(logger: Logger) {
    this.log = logger.child({ component: 'mcp-client' });
  }

  async connect(config: McpSkillConfig): Promise<void> {
    if (!config.enabled) return;
    if (config.tier === 0) return; // Tier 0 = instruction skills, no MCP connection

    const client = new Client({ name: 'bakerst-brain', version: '1.0.0' });

    let transport;
    if (config.transport === 'stdio') {
      // Tier 1: stdio — brain spawns skill as child process
      transport = new StdioClientTransport({
        command: config.command!,
        args: config.args ?? [],
      });
      this.log.info({ skill: config.name, tier: 1 }, 'Connecting via stdio');
    } else {
      // Tier 2: sidecar (http://localhost:<port>)
      // Tier 3: separate pod (http://<service>.bakerst.svc.cluster.local:<port>)
      transport = new StreamableHTTPClientTransport(new URL(config.url!));
      this.log.info({ skill: config.name, tier: config.tier, url: config.url }, 'Connecting via HTTP');
    }

    await client.connect(transport);
    this.clients.set(config.name, client);
    this.log.info({ skill: config.name, tier: config.tier }, 'MCP skill connected');
  }

  async connectAll(configs: McpSkillConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      configs.filter(c => c.enabled && c.tier > 0).map(c => this.connect(c))
    );
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        const config = configs.filter(c => c.enabled && c.tier > 0)[i];
        this.log.error({ skill: config.name, error: result.reason }, 'Failed to connect MCP skill');
      }
    }
  }

  async listAllTools(): Promise<Anthropic.Messages.Tool[]> {
    const allTools: Anthropic.Messages.Tool[] = [];
    for (const [skillName, client] of this.clients) {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        allTools.push({
          name: `${skillName}__${tool.name}`,  // namespace to avoid collisions
          description: tool.description ?? '',
          input_schema: tool.inputSchema as any,
        });
      }
    }
    return allTools;
  }

  async callTool(namespacedName: string, args: Record<string, unknown>): Promise<string> {
    const [skillName, toolName] = namespacedName.split('__', 2);
    const client = this.clients.get(skillName);
    if (!client) throw new Error(`MCP skill not connected: ${skillName}`);

    const result = await client.callTool({ name: toolName, arguments: args });
    // MCP returns content blocks — extract text
    return result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
  }
}
```

**Key design point:** The `McpClientManager` treats all tiers identically after connection. The brain doesn't care whether a tool came from a stdio child process (Tier 1), a sidecar (Tier 2), or a separate pod (Tier 3). This is what makes tier promotion a config-only change — the brain code never changes.

### Skill Registry Schema

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  tier INTEGER NOT NULL CHECK (tier IN (0, 1, 2, 3)),  -- hosting tier
  type TEXT NOT NULL CHECK (type IN ('mcp-server', 'instruction', 'legacy-plugin')),
  version TEXT,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  transport TEXT,          -- 'stdio' (tier 1) | 'http' (tier 2/3) | null (tier 0)
  url TEXT,                -- for http MCP servers (tier 2: localhost, tier 3: ClusterIP)
  command TEXT,            -- for stdio MCP servers (tier 1)
  args TEXT,               -- JSON array of args for stdio command
  instruction_content TEXT, -- for instruction skills (tier 0)
  config TEXT DEFAULT '{}', -- JSON: plugin-specific config
  model_override TEXT,     -- null = use default
  permissions TEXT DEFAULT '[]', -- JSON array of required secret keys
  source TEXT,             -- 'local' | 'github:org/repo/path' | 'npm:@scope/package'
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE skill_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  tool_name TEXT,
  action TEXT NOT NULL,    -- 'installed', 'enabled', 'disabled', 'called', 'error', 'uninstalled'
  input TEXT,              -- JSON (redacted)
  output TEXT,             -- JSON (truncated)
  duration_ms INTEGER,
  timestamp TEXT NOT NULL
);
```

---

## 7) Clarifying Questions

These don't block any recommendations above but would refine priority:

1. **Multi-user or single-user?** Assumed single-user (personal system). If multi-user is planned, auth and data isolation become significantly more complex.

2. **Where will this run long-term?** Docker Desktop on Mac vs. a dedicated Mac Mini vs. a cloud VM? This affects:
   - Storage strategy (hostPath is fine for local Mac, needs PVCs for cloud)
   - Ingress approach (Tailscale for Mac at home vs. cloud ingress)
   - Resource sizing (Mac hardware constraints)

3. **Budget sensitivity for Claude API costs?** This determines:
   - How aggressively to route to cheaper models (Haiku for simple tasks)
   - Whether to set hard cost limits
   - Whether local models are a "nice to have" or a requirement

4. **Are there specific awesome-agent-skills you want to import first?** This would help prioritize the instruction skill loader vs. the MCP infrastructure.

5. **Do you want the self-update mechanism to be fully autonomous or require approval?** The recommended design includes approval, but if you want Baker Street to auto-update without confirmation, the design simplifies.
