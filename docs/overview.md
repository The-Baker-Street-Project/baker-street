# Baker Street: Kubernetes-Native Personal AI Agent

Baker Street is a self-hosted, security-first AI agent system built on Kubernetes. It orchestrates conversations with Claude, dispatches background tasks to a worker pool, launches isolated task pods for goal-oriented work, manages long-term memory through vector embeddings, and connects to your world through extensible plugins and multi-channel gateways — all running inside your own cluster with defense-in-depth security that no single-process deployment can match.

---

## Architecture

```mermaid
graph TB
    subgraph External["External Channels"]
        TG["Telegram"]
        DC["Discord"]
        WEB["Web Browser"]
    end

    subgraph K8s["Kubernetes Cluster — bakerst namespace"]
        direction TB

        subgraph Access["Access Layer"]
            UI["UI<br/><i>React + Caddy</i><br/>:30080"]
            GW["Gateway<br/><i>Multi-adapter bridge</i>"]
        end

        subgraph Core["Core Services"]
            BRAIN["Brain<br/><i>Agent orchestrator</i><br/>:30000"]
            WORKER["Worker Pool<br/><i>Task execution</i>"]
            NATS["NATS JetStream<br/><i>Message broker</i>"]
            TASK["Task Pods<br/><i>Ephemeral K8s Jobs</i>"]
        end

        subgraph Data["Data Layer"]
            QDRANT["Qdrant<br/><i>Vector DB</i>"]
            SQLITE[("SQLite<br/><i>Conversations, jobs,<br/>schedules, skills</i>")]
        end

        subgraph Skills["Skill Layer (MCP)"]
            FS["Filesystem<br/><i>Stdio (Tier 1)</i>"]
            MCP3["Custom Services<br/><i>HTTP (Tier 2/3)</i>"]
            EXT["Extensions<br/><i>Pod-based (Tier 3)</i>"]
        end
    end

    subgraph Telemetry["bakerst-telemetry namespace"]
        OTEL["OTel Collector"]
        TEMPO["Tempo<br/><i>Traces</i>"]
        LOKI["Loki<br/><i>Logs</i>"]
        GRAFANA["Grafana<br/><i>Dashboards</i>"]
        PROM["Prometheus<br/><i>Metrics</i>"]
        KSM["kube-state-metrics"]
    end

    subgraph Bare["Bare Metal / VMs"]
        IRR["Companions<br/><i>Distributed agents</i>"]
    end

    subgraph AI["AI Providers"]
        CLAUDE["Claude API<br/><i>Anthropic</i>"]
        VOYAGE["Voyage AI<br/><i>Embeddings</i>"]
    end

    TG -->|Bot API| GW
    DC -->|Bot API| GW
    WEB -->|HTTPS| UI
    UI -->|REST/SSE| BRAIN
    GW -->|REST/SSE| BRAIN

    BRAIN <-->|Pub/Sub| NATS
    NATS <-->|JetStream| WORKER
    TASK -->|Progress/Result| NATS
    IRR <-->|Announce/Heartbeat/Tasks| NATS

    BRAIN -->|Store/Search| QDRANT
    BRAIN -->|Embed| VOYAGE
    BRAIN -->|Chat| CLAUDE
    WORKER -->|Chat| CLAUDE

    BRAIN <-->|MCP Stdio| FS
    BRAIN <-->|MCP HTTP| MCP3
    BRAIN <-->|MCP HTTP| EXT
    EXT -->|Announce/Heartbeat| NATS

    BRAIN -.->|OTLP| OTEL
    WORKER -.->|OTLP| OTEL
    OTEL -.-> TEMPO
    OTEL -.-> LOKI
    PROM -.->|Scrape| OTEL
    PROM -.->|Scrape| KSM
    GRAFANA -.-> TEMPO
    GRAFANA -.-> LOKI
    GRAFANA -.-> PROM

    BRAIN --- SQLITE

    style K8s fill:#1a1a2e,stroke:#16213e,color:#eee
    style Core fill:#0f3460,stroke:#533483,color:#eee
    style Access fill:#16213e,stroke:#533483,color:#eee
    style Data fill:#1a1a2e,stroke:#e94560,color:#eee
    style Skills fill:#1a1a2e,stroke:#0f3460,color:#eee
    style Telemetry fill:#1a1a2e,stroke:#533483,color:#eee
    style Bare fill:#2d4059,stroke:#f07b3f,color:#eee
```

---

## Security Architecture

Running Baker Street on Kubernetes provides defense-in-depth that no single-process AI agent can match. Every layer — network, pod, container, application — enforces least privilege independently. A compromise of any single component is contained by all the others.

### Network Isolation

```mermaid
graph TB
    subgraph "Default: DENY ALL INGRESS"
        EXT["External Traffic"]

        UI["UI :8080"]
        GW["Gateway :3000"]
        BRAIN["Brain :3000"]
        WORKER["Worker"]
        NATS["NATS :4222"]
        QDRANT["Qdrant :6333"]
        TASK["Task Pod"]
        EXTPOD["Extension :8080"]
        OTEL["OTel Collector :4317/4318"]
        TEMPO["Tempo :3200/:4317"]
        LOKI["Loki :3100"]
        GRAFANA["Grafana :3001"]
        PROM["Prometheus :9090"]
        KSM["kube-state-metrics :8080"]
    end

    EXT -->|"allow"| UI
    EXT -->|"allow"| GW
    EXT -->|"allow"| GRAFANA

    UI -->|"allow"| BRAIN
    GW -->|"allow"| BRAIN
    WORKER -->|"allow"| BRAIN

    BRAIN -->|"allow"| NATS
    WORKER -->|"allow"| NATS
    TASK -.->|"egress only"| NATS

    BRAIN -->|"allow (only brain)"| EXTPOD
    EXTPOD -->|"egress only"| NATS
    BRAIN -->|"allow (only brain)"| QDRANT

    BRAIN -.->|"allow"| OTEL
    WORKER -.->|"allow"| OTEL

    OTEL -.->|"allow"| TEMPO
    OTEL -.->|"allow"| LOKI
    PROM -.->|"scrape"| OTEL
    PROM -.->|"scrape"| KSM
    GRAFANA -.->|"allow"| TEMPO
    GRAFANA -.->|"allow"| LOKI
    GRAFANA -.->|"allow"| PROM

    style WORKER fill:#2d4059,color:#eee
    style QDRANT fill:#8B0000,color:#eee
    style TASK fill:#8B4513,color:#eee
    style EXTPOD fill:#2d4059,color:#eee
```

The cluster enforces **default-deny ingress** on every pod, with explicit NetworkPolicy rules whitelisting only the connections that are actually needed:

- **Qdrant** (the vector database holding your memories) is accessible **only from the brain** — no other pod can reach it
- **Workers have zero inbound access** — they pull work exclusively from the NATS message queue
- **Task pods are fully locked down** — zero ingress, egress limited to NATS port 4222 only (see [Task Pod Isolation](#task-pod-isolation))
- **Extensions are network-isolated** — only brain can reach them (port 8080); extensions can only reach NATS (port 4222). They cannot reach each other, Qdrant, the internet, or any other service
- **NATS is sealed** to brain, worker, and extension pods only (plus task pod egress)
- **Observability traffic** is isolated in a separate namespace (`bakerst-telemetry`) with cross-namespace policies restricting access to only the brain and worker
- **Prometheus** is accessible only from Grafana; **kube-state-metrics** is accessible only from Prometheus

### Pod Security

Every deployment enforces a strict security posture at the Kubernetes level:

| Control | Setting | Benefit |
|---------|---------|---------|
| **Non-root execution** | `runAsNonRoot: true`, UID 1000 | Prevents root-level container exploits |
| **Read-only filesystem** | `readOnlyRootFilesystem: true` | Blocks filesystem-based persistence of malware |
| **No privilege escalation** | `allowPrivilegeEscalation: false` | Prevents setuid/setgid exploits |
| **All capabilities dropped** | `capabilities: drop: [ALL]` | Removes all Linux kernel capabilities |
| **Seccomp profile** | `seccompProfile: RuntimeDefault` | Filters dangerous system calls |

Writable mounts are limited to `/tmp` (emptyDir) and explicit data volumes — nothing else can be written.

### Secret Scoping & Least Privilege

Secrets are segmented into three scoped Kubernetes secrets, each containing only what that service needs:

```mermaid
graph TB
    ENV[".env-secrets<br/><i>(gitignored)</i>"] --> SEC["secrets.sh"]

    SEC --> BS["bakerst-brain-secrets"]
    SEC --> WS["bakerst-worker-secrets"]
    SEC --> GS["bakerst-gateway-secrets"]

    BS -->|"envFrom"| BRAIN["Brain"]
    WS -->|"envFrom"| WORKER["Worker"]
    GS -->|"envFrom"| GATEWAY["Gateway"]

    BS -.- BSL["ANTHROPIC_OAUTH_TOKEN<br/>ANTHROPIC_API_KEY<br/>VOYAGE_API_KEY<br/>AUTH_TOKEN"]

    WS -.- WSL["ANTHROPIC_OAUTH_TOKEN<br/>ANTHROPIC_API_KEY"]

    GS -.- GSL["TELEGRAM_BOT_TOKEN<br/>DISCORD_BOT_TOKEN<br/>AUTH_TOKEN"]

    style BS fill:#0f3460,color:#eee
    style WS fill:#0f3460,color:#eee
    style GS fill:#0f3460,color:#eee
```

- The **gateway never sees** Anthropic API keys or Voyage keys
- **Workers never see** Telegram/Discord tokens or the auth token
- The brain's RBAC role is scoped to a **single named secret** — it cannot read any other secret in the namespace
- `AUTH_TOKEN` is auto-generated (32-byte hex) and validated with **timing-safe comparison** to prevent side-channel attacks

### Container Hardening

All images use **multi-stage Docker builds** on Alpine Linux:

- Build tools (compilers, Python, make) exist only in the builder stage — they never reach the production image
- Production images contain only the compiled application and runtime dependencies
- The UI image doesn't even include Node.js — it runs on **Caddy** with static assets, and strips file capabilities from the binary (`setcap -r`)
- Lockfiles are frozen (`--frozen-lockfile`) to prevent supply-chain tampering during builds

### Application-Level Security

- **Bearer token authentication** on all Brain API routes (except `/ping` health check)
- **Command allowlisting** in workers — only pre-approved binaries can execute, with blocked environment variables (PATH, LD_PRELOAD, API keys) and a 30-second timeout
- **Path traversal protection** in the filesystem plugin — all paths resolved and validated against an allowlist
- **Output sanitization** — API keys and tokens matching known patterns are redacted from tool outputs before they reach the model
- **CORS whitelist** in production (permissive only in dev mode)

### Task Pod Isolation

Task pods — ephemeral Kubernetes Jobs launched by the brain — receive the strictest security posture in the system:

| Control | Setting |
|---------|---------|
| **ServiceAccount** | `bakerst-task` — zero RBAC permissions, no K8s API access |
| **Ingress** | Default-deny (zero inbound traffic) |
| **Egress** | `allow-task-to-nats` — only NATS port 4222 |
| **Filesystem** | Read-only root, writable `/tmp` only |
| **Host mounts** | Allowlisted via `TASK_ALLOWED_PATHS`; rejected if not configured; read-only unless explicitly granted |
| **Resource limits** | 512Mi memory, 500m CPU |
| **Timeout** | 30-minute `activeDeadlineSeconds` (configurable per-task) |
| **Cleanup** | `ttlSecondsAfterFinished: 300` — auto-removed 5 minutes after completion |
| **Retries** | `backoffLimit: 0` — no automatic retries |
| **Pod security** | `runAsNonRoot`, UID 1000, drop all capabilities, seccomp RuntimeDefault |

A task pod cannot reach the Kubernetes API, cannot receive incoming connections, cannot write to its own filesystem (except `/tmp`), and is automatically garbage-collected. Even if the code running inside is compromised, the blast radius is limited to streaming messages over NATS for at most 30 minutes.

---

## Feature Highlights

### Conversational AI Agent

The Brain is the central orchestrator — a stateful agent that maintains multi-turn conversations, calls tools iteratively (up to 10 rounds per turn), and decides when to handle requests directly versus dispatching work to the worker pool.

- **Streaming responses** via Server-Sent Events for real-time feedback
- **Conversation persistence** in SQLite with full history
- **Multi-model routing** with role-based model selection (agent, observer, worker) and configurable fallback chains
- **Channel-aware formatting** — adapts responses for web, Telegram, or Discord

### Background Job System

```mermaid
sequenceDiagram
    participant U as User
    participant B as Brain
    participant N as NATS JetStream
    participant W as Worker

    U->>B: "Research Kubernetes operators"
    B->>B: Decide to dispatch
    B->>N: Publish JobDispatch
    B->>U: "I've dispatched a research task..."

    N->>W: Deliver job (pull consumer)
    W->>W: Execute (agent/command/http)
    W-->>N: Publish JobStatus updates
    N-->>B: Status: received → running → completed

    U->>B: "What did you find?"
    B->>B: Retrieve job result
    B->>U: "Here's what I found..."
```

Three job types flow through NATS JetStream with durable delivery guarantees:

| Type | Description | Example |
|------|-------------|---------|
| **Agent** | Claude-powered task on a worker | "Summarize this document" |
| **Command** | Shell command with strict allowlisting | `kubectl get pods -n production` |
| **HTTP** | REST API call to external services | `GET https://api.example.com/status` |

Workers report status updates in real time (received, running, completed, failed), and a zombie reaper automatically cleans up jobs stuck for more than two minutes.

### Task Pods

Task pods are ephemeral Kubernetes Jobs launched on demand for isolated, goal-oriented work. The brain creates each pod via the K8s API, tracks state in SQLite, and communicates over NATS.

```mermaid
sequenceDiagram
    participant U as User / Agent
    participant B as Brain
    participant K8s as Kubernetes API
    participant P as Task Pod
    participant N as NATS

    U->>B: Launch task (goal, toolbox, mode)
    B->>B: Validate mounts against allowlist
    B->>K8s: Create Job (bakerst-task-*)
    B->>N: Subscribe to task.progress / task.result

    K8s->>P: Schedule pod
    P->>N: TaskProgress (log, tool_call, thinking, milestone)
    N-->>B: Stream progress to UI

    P->>N: TaskResult (completed/failed/timeout)
    N-->>B: Update DB, unsubscribe
    K8s->>K8s: TTL cleanup (5 min)
```

Two execution modes:

| Mode | Description |
|------|-------------|
| **Agent** | Full reasoning loop with tools — the toolbox image runs an autonomous agent |
| **Script** | Runs a shell command or script inline, streaming stdout as progress events |

Key properties:

- **Host mount allowlisting** — every mount is checked against `TASK_ALLOWED_PATHS`; requests are rejected outright if the allowlist is unconfigured
- **Toolbox images** — container images from the external `bakerst-toolboxes` repo, each packaging a different set of tools
- **30-minute timeout** with configurable override per task
- **Auto-cleanup** after 5 minutes via Kubernetes TTL controller
- **Zero retries** — failures are reported, not repeated
- **Full security isolation** — see [Task Pod Isolation](#task-pod-isolation) above
- **Feature-flagged** — enable with `FEATURE_TASK_PODS=true`

### Long-Term Memory (RAG)

The memory system uses Qdrant vector search with Voyage AI embeddings to store and retrieve facts across conversations.

```mermaid
graph LR
    subgraph Store
        A["User says something<br/>worth remembering"] --> B["Embed with<br/>Voyage AI"]
        B --> C["Dedup check<br/>(>92% similarity)"]
        C -->|New| D["Insert into Qdrant"]
        C -->|Duplicate| E["Update existing"]
    end

    subgraph Retrieve
        F["New user message"] --> G["Embed query"]
        G --> H["Semantic search<br/>(threshold 0.3)"]
        H --> I["Inject relevant<br/>memories into prompt"]
    end

    D --> H
    E --> H
```

- **Six categories**: gear, preferences, homelab, personal, work, general
- **Automatic deduplication**: Updates existing memories when similarity exceeds 92%
- **Two-phase memory workers**:
  - **Observer** (Phase 1): Extracts structured observations from conversations using a cheaper model — decisions, preferences, facts, issues, action items
  - **Reflector** (Phase 2): Compresses observation logs into higher-level abstractions
- **Circuit breaker** on the embedding API prevents cascading failures

### Extensible Skill System (MCP)

Skills are added at runtime without redeployment — the agent can even install its own. Four tiers provide flexibility from simple prompt instructions to full Kubernetes services:

```mermaid
graph TB
    subgraph "Tier 0 — Instruction"
        T0["Markdown files injected<br/>into system prompt"]
    end

    subgraph "Tier 1 — Stdio"
        T1["MCP server spawned<br/>as child process"]
        T1 <-->|stdin/stdout| BRAIN1["Brain"]
    end

    subgraph "Tier 2 — Sidecar"
        T2["MCP server in<br/>sidecar container"]
        T2 <-->|HTTP| BRAIN2["Brain Pod"]
    end

    subgraph "Tier 3 — Service"
        T3["Standalone K8s<br/>Service"]
        T3 <-->|HTTP| BRAIN3["Brain"]
    end

    style T0 fill:#2d4059,stroke:#ea5455,color:#eee
    style T1 fill:#2d4059,stroke:#f07b3f,color:#eee
    style T2 fill:#2d4059,stroke:#ffd460,color:#eee
    style T3 fill:#2d4059,stroke:#40bf80,color:#eee
```

| Tier | Transport | Lifecycle | Use Case |
|------|-----------|-----------|----------|
| **0 — Instruction** | None (prompt injection) | Static | Domain knowledge, guidelines |
| **1 — Stdio** | Child process stdin/stdout | Brain-managed | Lightweight tools (filesystem) |
| **2 — Sidecar** | HTTP in same pod | Pod-scoped | Tightly coupled tools |
| **3 — Service** | HTTP to K8s Service | Independent | Shared/heavy tools |

**Built-in plugins**:
- **Filesystem** (Tier 1 stdio): Sandboxed file read/list/info with path traversal protection

**Self-management**: The agent can create, update, enable, disable, and delete its own Tier 0 and Tier 1 skills, and browse the public MCP registry to discover new ones.

### Extensions — Pod-Based Tool Plugins

Extensions let developers add tool capabilities by deploying a Kubernetes pod. No brain restarts, no config changes — deploy a pod and the agent gains new tools automatically.

```mermaid
sequenceDiagram
    participant E as Extension Pod
    participant N as NATS
    participant B as Brain

    E->>N: Announce (id, name, mcpUrl, tools)
    N->>B: deliver
    B->>E: Connect MCP (tools/list)
    E->>B: Tool definitions
    Note over B: Tools now available to agent

    loop Every 30 seconds
        E->>N: Heartbeat (uptime, activeRequests)
        N->>B: deliver
    end

    Note over E: Pod deleted
    Note over B: 90s timeout → tools removed

    Note over E: Pod redeployed
    E->>N: Announce
    Note over B: Tools restored
```

Each extension serves tools via an MCP HTTP endpoint and announces itself on NATS. The brain discovers tools via `tools/list`, makes them directly available to the agent's LLM, and monitors health via heartbeats. The `@bakerst/extension-sdk` package provides a one-liner setup; any language can implement the protocol directly.

**Security note:** The platform provides network isolation (only brain can reach extensions, extensions can only reach NATS) but each extension is responsible for its own input validation, authorization, rate limiting, and output sanitization. The brain trusts tool results — a poorly written extension can leak data or cause unintended side effects. See `docs/extensions.md` for the full security model.

- **Feature-flagged** — enable with `FEATURE_EXTENSIONS=true`

### Companions — Distributed Agent Network

Companions are lightweight autonomous agent daemons that run on bare metal, NAS boxes, or VMs outside the Kubernetes cluster. They extend the agent's reach to machines that don't run inside K8s.

```mermaid
sequenceDiagram
    participant I as Companion (bare metal)
    participant N as NATS
    participant B as Brain

    I->>N: Announce (id, hostname, capabilities, paths)
    N->>B: deliver
    B->>B: Persist Companion, subscribe to heartbeat

    loop Every 30 seconds
        I->>N: Heartbeat (uptime, load, activeTasks, memoryPct)
        N->>B: deliver
        B->>B: Update last_seen
    end

    B->>N: CompanionTask (goal, mode, timeout)
    N->>I: deliver
    I->>I: Execute (script or agent mode)
    I-->>N: TaskProgress (log, tool_call, thinking, milestone)
    N-->>B: Stream to UI

    I->>N: TaskResult (completed/failed/timeout)
    N->>B: Update DB
```

Each Companion connects outbound to the NATS server and:

- **Announces capabilities** (e.g., filesystem, docker, zfs, systemctl) and allowed paths on connect
- **Heartbeats every 30 seconds** — the brain marks an Companion offline after 3 missed heartbeats (90s)
- **Receives tasks** dispatched by the brain, executing them locally in script or agent mode
- **Streams progress** back over NATS in real time

Configuration is a JSON file specifying the Companion's ID, NATS URL, capabilities, allowed paths, max concurrency, and Anthropic API key.

- **Feature-flagged** — enable with `FEATURE_COMPANIONS=true`

### Scheduled Tasks

Cron-based scheduling dispatches jobs automatically on a recurring basis. Schedules support the same three job types (agent, command, http) and can be managed through the UI or by the agent itself.

### Multi-Channel Gateway

```mermaid
graph LR
    TG["Telegram"] -->|grammy| GW["Gateway"]
    DC["Discord"] -->|discord.js| GW

    GW -->|Streaming SSE| BRAIN["Brain API"]
    GW -->|Conversation<br/>mapping| DB[("SQLite")]

    BRAIN -->|Response| GW
    GW -->|Split &<br/>format| TG
    GW -->|Split &<br/>format| DC
```

The gateway bridges external messaging platforms to the brain with:

- **Per-channel conversation persistence** — each Telegram chat or Discord channel maps to a unique conversation
- **Platform-aware message splitting** — respects Telegram's 4,096 and Discord's 2,000 character limits
- **Markdown formatting** with graceful plain-text fallback
- **Allowlist filtering** — restrict access to specific chat/channel IDs
- **Typing indicators** while the brain is processing

### Web UI

A React single-page application served by Caddy provides a full management interface:

- **Streaming chat** with real-time tool execution feedback
- **Conversation history** browser
- **Job monitoring** dashboard with live status polling
- **Task pod monitoring** with streaming progress and result display
- **Memory management** with semantic search and category browsing
- **Extensions page** with three tabs:
  - **Skills** — manage Tier 0 instruction skills, toggle enable/disable, upload zip archives
  - **MCP Servers** — manage Tier 1-3 MCP connections, browse the public registry, one-click install
  - **Toolboxes** — view and build task pod toolbox images, check build status
- **Model configuration** with role assignment and cost display
- **Schedule management** with cron expression builder
- **Secret management** with masked display and service restart
- **System health** dashboard showing component status

---

## Zero-Downtime Deployments

Baker Street uses a blue-green deployment strategy with a NATS-based transfer protocol for graceful handoff between brain versions:

```mermaid
sequenceDiagram
    participant NEW as New Brain (Pending)
    participant NATS as NATS
    participant OLD as Old Brain (Active)
    participant SVC as K8s Service

    Note over NEW: Starts with BRAIN_ROLE=pending

    NEW->>NATS: TRANSFER_READY (version, timestamp)
    NATS->>OLD: deliver

    OLD->>OLD: Transition to DRAINING
    OLD->>OLD: Wait for in-flight requests (5s)
    OLD->>OLD: Write handoff note (conversations, schedules)
    OLD->>NATS: TRANSFER_CLEAR (handoffNoteId)
    NATS->>NEW: deliver

    NEW->>NEW: Read handoff note
    NEW->>NEW: Transition to ACTIVE
    NEW->>NATS: TRANSFER_ACK
    NATS->>OLD: deliver

    Note over SVC: Service selector switches<br/>blue ↔ green

    OLD->>OLD: Transition to SHUTDOWN
    OLD->>OLD: Exit

    Note over NEW: Now serving all traffic
```

The handoff note preserves continuity — active conversations and enabled schedules transfer seamlessly to the new version. If the new brain fails health checks, the upgrade script automatically rolls back by scaling down the new slot and keeping the old one active.

---

## Observability

The telemetry stack is optional and deploys to a separate `bakerst-telemetry` namespace via Kustomize namespace transformer, keeping it fully isolated from application workloads.

```mermaid
graph LR
    BRAIN["Brain"] -->|OTLP HTTP| OTEL["OTel Collector"]
    WORKER["Worker"] -->|OTLP HTTP| OTEL

    OTEL -->|OTLP gRPC| TEMPO["Tempo<br/><i>Traces</i>"]
    OTEL -->|HTTP| LOKI["Loki<br/><i>Logs</i>"]
    OTEL -->|":8889"| PROM["Prometheus<br/><i>Metrics</i>"]
    KSM["kube-state-metrics"] -->|":8080"| PROM

    GRAFANA["Grafana"] -->|Query| TEMPO
    GRAFANA -->|Query| LOKI
    GRAFANA -->|Query| PROM

    TEMPO -.->|"Trace → Log<br/>correlation"| LOKI
```

Two Prometheus modes are supported:

| Mode | Description |
|------|-------------|
| **Local** | Prometheus + kube-state-metrics deploy inside the cluster; Prometheus scrapes OTel Collector metrics (`:8889`) and kube-state-metrics (`:8080`); Grafana queries local Prometheus |
| **External** | No local Prometheus; OTel Collector pushes metrics via `prometheusremotewrite` to an external URL; Grafana queries the external Prometheus directly |

Additional details:

- Every API response includes an `X-Trace-Id` header for end-to-end correlation
- Trace context propagates through NATS messages, so a single user request can be traced across brain → NATS → worker
- LLM calls are instrumented as `brain.llm.call` spans with role and iteration metadata
- Tool executions appear as `tool.<name>` child spans
- Cross-namespace network policies allow only the brain and worker to push telemetry into the `bakerst-telemetry` namespace

---

## Quick Start

```bash
# Clone and enter the repository
git clone https://github.com/The-Baker-Street-Project/baker-street.git
cd baker-street

# Interactive deploy — asks for secrets, builds everything, deploys to K8s
scripts/deploy-all.sh

# Open the UI
open http://localhost:30080
```

The deploy script walks through prerequisite checks, secret configuration, TypeScript compilation, Docker image builds, and Kubernetes deployment in a single interactive flow. See `scripts/deploy-all.sh --help` for non-interactive and selective options.

---

## Project Structure

```
bakerst/
├── packages/
│   ├── shared/             # Types, NATS subjects, model router, feature flags
│   └── extension-sdk/      # SDK for building pod-based extensions
├── services/
│   ├── brain/              # Agent orchestrator (Express + Claude + NATS)
│   ├── worker/             # Job execution (NATS consumer + Claude)
│   ├── gateway/            # Telegram & Discord bridge
│   ├── companion/          # Distributed agent daemon (bare metal / VM)
│   └── ui/                 # React SPA (Vite + Tailwind + Caddy)
├── plugins/
│   └── filesystem/         # Sandboxed file access (stdio MCP)
├── examples/
│   ├── extension-github/      # GitHub tools (repos, issues, PRs)
│   ├── extension-obsidian/    # Obsidian vault tools (notes, search, links)
│   └── extension-utilities/   # Time/date and network lookup tools
├── operating_system/       # Personality files (SOUL.md, BRAIN.md, etc.)
├── k8s/                    # Kubernetes manifests (Kustomize)
│   ├── brain/              # Blue-green deployments, RBAC, service
│   ├── worker/
│   ├── ui/
│   ├── gateway/
│   ├── nats/               # JetStream message broker
│   ├── qdrant/             # Vector database
│   ├── task/               # Task pod RBAC (ServiceAccount, zero permissions)
│   ├── telemetry/          # Prometheus, kube-state-metrics, Kustomize namespace transformer
│   ├── otel-collector/     # Trace collection
│   ├── tempo/              # Trace storage
│   ├── loki/               # Log aggregation
│   ├── grafana/            # Dashboards
│   ├── overlays/dev/       # Dev mode patches
│   └── network-policies.yaml
└── scripts/
    ├── deploy-all.sh       # Interactive full deploy
    ├── build.sh            # Docker image builds
    ├── secrets.sh          # K8s secret management
    ├── deploy.sh           # K8s manifest apply
    └── upgrade.sh          # Zero-downtime blue-green upgrade
```
