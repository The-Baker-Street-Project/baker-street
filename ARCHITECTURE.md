# bakerst Architecture Overview

A Kubernetes-native personal AI agent system built on Claude, NATS messaging, and Qdrant vector memory.

## System Diagram

```
                    ┌──────────────────────────┐
                    │      UI (React SPA)      │
                    │   nginx :8080            │
                    │   /chat /jobs /memory     │
                    └───────────┬──────────────┘
                                │ HTTP / SSE
                                │ /api/* → brain
                                ▼
┌───────────────────────────────────────────────────────────────┐
│                     Brain (Express :3000)                      │
│                                                               │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Agent   │  │ Dispatcher │  │ Status   │  │  Memory   │  │
│  │ (Claude) │  │            │  │ Tracker  │  │ Service   │  │
│  └────┬─────┘  └─────┬──────┘  └────┬─────┘  └─────┬─────┘  │
│       │              │              │               │         │
│       │ tools        │ publish      │ subscribe     │ embed   │
│       ▼              ▼              ▼               ▼         │
│  ┌─────────┐   ┌──────────┐  ┌──────────┐   ┌──────────┐   │
│  │ SQLite  │   │   NATS   │  │   NATS   │   │  Qdrant  │   │
│  │  /data  │   │  :4222   │  │  :4222   │   │  :6333   │   │
│  └─────────┘   └────┬─────┘  └──────────┘   └──────────┘   │
└──────────────────────┼───────────────────────────────────────┘
                       │
                       │ bakerst.jobs.dispatch (queue group)
                       ▼
              ┌─────────────────┐
              │  Worker Pod(s)  │
              │                 │
              │  agent │ cmd │ http
              │                 │
              │  → status updates
              │    bakerst.jobs.status.*
              └─────────────────┘
```

## Components

### Brain (`services/brain`)

The central decision-making service. Receives user messages, reasons with Claude, dispatches work to workers, and manages conversations and memory.

**Key modules:**

| Module | Purpose |
|--------|---------|
| `agent.ts` | Claude integration with 6 tools (dispatch_job, get/list_jobs, memory_store/search/delete). Supports blocking and streaming chat. Max 10 tool iterations per response. |
| `api.ts` | Express REST API — chat, chat/stream (SSE), webhooks, conversations, jobs, memories. CORS enabled. |
| `dispatcher.ts` | Creates job records in SQLite and publishes to NATS `bakerst.jobs.dispatch`. |
| `status-tracker.ts` | Subscribes to `bakerst.jobs.status.*`, persists worker status updates to SQLite. |
| `memory.ts` | Qdrant vector store with Voyage AI embeddings (`voyage-3.5-lite`, 1024-dim). Deduplicates at 92% similarity. |
| `db.ts` | SQLite (better-sqlite3) with tables: `jobs`, `conversations`, `messages`. WAL mode. |
| `cron.ts` | Loads scheduled jobs from `CRONS.json`, dispatches on schedule via node-cron. |

### Worker (`services/worker`)

Stateless execution pods that process jobs from the NATS queue.

**Job types:**

| Type | Executor | Description |
|------|----------|-------------|
| `agent` | Claude Sonnet | Independent AI reasoning with SOUL.md + WORKER.md context. 1024 max tokens. |
| `command` | `child_process.exec` | Shell command execution. 30s timeout. |
| `http` | `fetch` | HTTP requests with configurable method, headers, and body. |

Workers use NATS queue groups (`QueueGroups.WORKERS`) for load-balanced distribution. Multiple replicas can process jobs in parallel.

### UI (`services/ui`)

React 19 SPA with Vite 6 and Tailwind CSS 4. Served by nginx in production.

**Pages:**

| Route | Feature |
|-------|---------|
| `/chat/:id?` | Streaming chat with tool call cards, conversation history sidebar |
| `/jobs/:id?` | Auto-polling job table (5s) with status badges and detail panel |
| `/conversations/:id?` | Browse and read past conversations |
| `/memory` | Semantic search and category-filtered memory browser |

**API proxy:** In dev, Vite proxies `/api/*` → `localhost:3000`. In production, nginx proxies `/api/*` → `brain.bakerst.svc.cluster.local:3000` with `proxy_buffering off` for SSE.

### Shared (`packages/shared`)

Common library used by brain and worker.

- **NATS subjects** — `bakerst.jobs.dispatch`, `bakerst.jobs.status.{jobId}`, heartbeats
- **Types** — `JobDispatch`, `JobStatus`, `Heartbeat`
- **Utilities** — NATS connection/codec, Pino logger

## Data Flow: Chat Message

```
1. User sends message         → POST /chat/stream
2. Brain loads conversation   → SQLite (conversations, messages)
3. Brain retrieves memories   → Qdrant semantic search
4. Agent calls Claude         → Anthropic API (claude-sonnet-4-20250514)
5. Claude invokes tool        → e.g. dispatch_job(type: "command", command: "uptime")
6. Brain dispatches job       → SQLite insert + NATS publish
7. Worker receives job        → NATS queue subscription
8. Worker executes            → shell exec / Claude / HTTP fetch
9. Worker reports status      → NATS publish (bakerst.jobs.status.{jobId})
10. Brain receives status     → NATS subscription → SQLite update
11. Agent polls for result    → statusTracker.getStatus() (250ms–2s backoff, 120s timeout)
12. Claude continues          → may call more tools or return final response
13. Brain stores messages     → SQLite (messages table)
14. Response streams to UI    → SSE events: text, tool_use, tool_result, done
```

## Personality System

Files in `operating_system/` are mounted as a ConfigMap at `/etc/bakerst`:

| File | Loaded by | Purpose |
|------|-----------|---------|
| `SOUL.md` | Brain + Worker | Core identity: helpful, concise, reliable |
| `BRAIN.md` | Brain | When to answer directly vs dispatch, memory management, response style |
| `WORKER.md` | Worker | Task execution guidelines |
| `CRONS.json` | Brain | Scheduled jobs (currently empty) |
| `TRIGGERS.json` | Brain | Webhook triggers (currently empty) |

## Authentication & Secrets

All secrets are stored in `.env-secrets` (gitignored) and loaded into the `bakerst-secrets` Kubernetes Secret via `scripts/secrets.sh`, which auto-sources the file.

```
ANTHROPIC_OAUTH_TOKEN (priority) → Bearer token with claude-code beta headers
ANTHROPIC_API_KEY (fallback)     → Standard API key auth
VOYAGE_API_KEY                   → Voyage AI embeddings for memory
TELEGRAM_BOT_TOKEN               → Telegram bot for gateway adapter
```

Secrets are injected into pods via `envFrom` on scoped K8s Secrets.

## Data Persistence

| Store | Location | Contents |
|-------|----------|----------|
| SQLite | `/Users/gary/bakerst-data/bakerst.db` (hostPath → `/data`) | Jobs, conversations, messages |
| Qdrant | `/Users/gary/bakerst-qdrant/` (hostPath) | Memory vectors (1024-dim, Cosine) |

Memory categories: `gear`, `preferences`, `homelab`, `personal`, `work`, `general`.

## Kubernetes Resources

All resources in namespace `bakerst`, managed by Kustomize.

| Deployment | Image | Port | Resources |
|------------|-------|------|-----------|
| nats | `nats:2.10-alpine` | 4222 | 64–128Mi, 50–200m CPU |
| qdrant | `qdrant/qdrant:v1.16.2` | 6333, 6334 | 128–512Mi, 100–500m CPU |
| brain | `bakerst-brain:latest` | 3000 | 128–256Mi, 100–500m CPU |
| worker | `bakerst-worker:latest` | — | 128–256Mi, 100–500m CPU |
| gateway | `bakerst-gateway:latest` | — | Telegram adapter (extensible) |
| browser | `chromedp/headless-shell:latest` | 9222 | Headless Chrome for browser plugin |
| ui | `bakerst-ui:latest` | 8080 | 32–64Mi, 10–100m CPU |

All custom images use `imagePullPolicy: Never` (built locally via Docker Desktop).

## Build & Deploy

```bash
pnpm install                 # install all workspace deps
pnpm -r build                # compile TypeScript in all workspaces
scripts/build.sh             # docker build brain, worker, ui, gateway images
scripts/secrets.sh           # create k8s secrets (auto-loads .env-secrets)
scripts/deploy.sh            # kubectl apply manifests, wait for rollout
```

### Local access

```bash
kubectl port-forward svc/brain 3000:3000 -n bakerst   # API
kubectl port-forward svc/ui 8080:8080 -n bakerst       # Web UI
```

### Dev mode (UI)

```bash
pnpm --filter=@bakerst/ui dev # Vite dev server at localhost:5173
                              # proxies /api → localhost:3000
```

## Directory Structure

```
bakerst/
├── packages/shared/          # NATS types, subjects, logger, plugin interfaces
├── services/
│   ├── brain/                # Express API + Claude agent + memory + plugin registry
│   ├── worker/               # Job execution (agent/command/http)
│   ├── gateway/              # Messaging adapters (Telegram, Discord)
│   └── ui/                   # React SPA (Vite + Tailwind)
├── plugins/
│   └── filesystem/           # Sandboxed file access (stdio MCP)
├── operating_system/         # Personality files (ConfigMap)
├── k8s/                      # Kubernetes manifests (Kustomize)
│   ├── nats/
│   ├── qdrant/
│   ├── brain/
│   ├── worker/
│   ├── gateway/
│   ├── browser/
│   └── ui/
├── scripts/                  # Build and deploy automation
└── .env-secrets              # Local secrets file (gitignored)
```
