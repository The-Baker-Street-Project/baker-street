# Baker Street — Product Overview for Content Strategy & Website

> Reference document for YouTube video planning and baker-street-web AI enhancements.
> Last updated: 2026-03-07

---

## Table of Contents

1. [Identity & Positioning](#1-identity--positioning)
2. [The Problem We Solve](#2-the-problem-we-solve)
3. [What Baker Street Is](#3-what-baker-street-is)
4. [Target Audiences](#4-target-audiences)
5. [Core Capabilities](#5-core-capabilities)
6. [Architecture (Simplified)](#6-architecture-simplified)
7. [Architecture (Technical Detail)](#7-architecture-technical-detail)
8. [Security Model](#8-security-model)
9. [Extension & Plugin Ecosystem](#9-extension--plugin-ecosystem)
10. [Personality System](#10-personality-system)
11. [Multi-Channel Access](#11-multi-channel-access)
12. [Enterprise Hardening](#12-enterprise-hardening)
13. [Deployment & Operations](#13-deployment--operations)
14. [Technology Stack](#14-technology-stack)
15. [Key Differentiators vs. Alternatives](#15-key-differentiators-vs-alternatives)
16. [Use Cases & Scenarios](#16-use-cases--scenarios)
17. [Roadmap Highlights](#17-roadmap-highlights)
18. [Brand & Naming Conventions](#18-brand--naming-conventions)
19. [YouTube Content Themes](#19-youtube-content-themes)
20. [Website Enhancement Opportunities](#20-website-enhancement-opportunities)
21. [Glossary](#21-glossary)

---

## 1. Identity & Positioning

**Product name:** Baker Street
**Tagline:** *"What if your app was a prompt?"*
**Brand line:** *Kubernetes-native AI agents with defense-in-depth by default.*
**Built by:** Savviety

### Elevator Pitch (30 seconds)

Baker Street is a self-hosted AI agent platform that runs on Kubernetes. You get a personal second brain that can hold conversations, run background tasks, remember things long-term, browse the web, manage your GitHub repos, access your notes, and automate recurring work — all inside your own infrastructure with enterprise-grade security out of the box. Deploy with one script. Extend by deploying a pod. No vendor lock-in, no data leaving your cluster.

### Elevator Pitch (10 seconds)

Baker Street is a self-hosted AI agent that runs on your Kubernetes cluster. It thinks, remembers, takes action, and keeps your data under your control.

### Positioning Statement

For DevOps teams, power users, and enterprises who need AI agents they can trust with real infrastructure, Baker Street is the Kubernetes-native agent platform that delivers security-by-default, isolation-first execution, and composable extensibility — without sacrificing simplicity or requiring months of integration work.

---

## 2. The Problem We Solve

AI agent frameworks are everywhere, but almost none ship with the security, isolation, and auditability that production teams actually need. The result:

- **Security teams block adoption** because agents run with broad access and no audit trail
- **Data leaves your control** when using hosted AI services with no self-hosted option
- **Integration is painful** — weeks of wiring up messaging, memory, job systems, auth
- **Extending capabilities means redeployment** — adding a tool requires changing core code
- **No governance layer** — rate limits, cost controls, and compliance checks are afterthoughts
- **Chatbot fatigue** — most AI assistants forget everything between sessions and can't actually do anything

Baker Street was built to solve all of these simultaneously.

---

## 3. What Baker Street Is

Baker Street is a multi-service AI agent platform deployed as standard Kubernetes workloads. It combines:

| Component | What It Does |
|-----------|-------------|
| **Brain** | Central AI orchestrator — holds conversations, reasons about tasks, decides what to delegate |
| **Workers** | Background job executors — run shell commands, AI reasoning tasks, and HTTP calls |
| **Task Pods** | Ephemeral isolated containers for sensitive or heavy work — auto-destroyed after completion |
| **Memory** | Long-term vector memory (Qdrant + Voyage AI) — the agent remembers across sessions |
| **Gateway** | Multi-channel bridge — talk to your agent via web UI, Telegram, or Discord |
| **Extensions** | Pod-based tool plugins — deploy a pod, gain a capability, no restarts needed |
| **Companions** | Distributed agents on bare metal/VMs outside the cluster |
| **UI** | Full React management interface — chat, jobs, memory, extensions, system health |

All connected by NATS JetStream (durable messaging), secured with defense-in-depth, and deployable with a single script.

---

## 4. Target Audiences

### Primary

| Audience | Pain Point | Baker Street Value |
|----------|-----------|-------------------|
| **DevOps / SRE teams** | Need AI assistance for infrastructure but can't give broad cluster access | Isolated Task Pods with allowlisted commands, full audit trail, SIEM integration |
| **Self-hosters / Homelab enthusiasts** | Want an AI assistant that respects privacy and runs locally | Fully self-hosted, data never leaves your cluster, one-script deploy |
| **Platform engineers** | Building internal AI tools but drowning in integration work | Pre-built orchestration, memory, messaging, auth — extend with pods |
| **Enterprise IT / Compliance** | Need governance, audit, and cost controls around AI agents | Enterprise hardening layer with guardrails, HMAC audit chain, vault-backed secrets |

### Secondary

| Audience | Interest |
|----------|---------|
| **AI/ML engineers** | Multi-model routing (Claude, GPT, Ollama), extension SDK, MCP protocol |
| **Knowledge workers** | Second brain that accumulates context, manages notes (Obsidian), automates recurring tasks |
| **Open source community** | Kubernetes-native patterns, well-documented architecture, extension ecosystem |

---

## 5. Core Capabilities

### 5.1 Conversational AI Agent

- Stateful multi-turn conversations with Claude (Anthropic)
- Up to 10 tool-use iterations per response (agent loop)
- Streaming responses via Server-Sent Events
- Conversation history persistence
- Multi-model support: Claude (Anthropic), GPT (OpenAI), Ollama (local), OpenRouter
- Role-based model selection: different models for agent reasoning, observation, and background work
- Fallback chains: if primary model is unavailable, automatically try alternatives

### 5.2 Background Job System

Three job types dispatched via NATS JetStream:

| Type | What It Does | Example |
|------|-------------|---------|
| **Agent** | Claude reasoning on a worker pod | "Summarize this 50-page PDF" |
| **Command** | Shell command via strict allowlist | `kubectl get pods -n production` |
| **HTTP** | REST API call | `GET https://api.example.com/status` |

- Durable message delivery (NATS JetStream guarantees)
- Worker pool with queue-based load balancing
- Real-time status updates streamed back to UI
- Zombie job detection and cleanup (stuck > 2 min)

### 5.3 Task Pods (Ephemeral Isolated Execution)

Launch on-demand Kubernetes Jobs for goal-oriented work:

- **Strictest security**: zero inbound access, NATS-only egress, read-only filesystem, no RBAC permissions
- **Toolbox images**: specialized containers (document processing, media, data analysis)
- **Agent or script mode**: full AI reasoning loop, or direct command execution
- **Auto-cleanup**: destroyed after completion (5-min TTL)
- **30-minute timeout**: configurable, prevents runaway execution
- **Host mount allowlisting**: controlled access to specific paths

### 5.4 Long-Term Memory (Semantic)

The agent remembers across sessions using vector search:

- **Qdrant vector database** with Voyage AI embeddings (1024-dimensional)
- **Auto-deduplication**: updates existing memories if >92% similar (no duplicates)
- **Six categories**: gear, preferences, homelab, personal, work, general
- **Observational memory pipeline**:
  - **Observer**: extracts structured observations from conversations (cheaper model)
  - **Reflector**: compresses observations into higher-level abstractions when logs grow
- **Prompt caching**: up to 90% token cost savings on stable context blocks
- **Circuit breaker**: prevents cascading failures if embedding API goes down

### 5.5 Standing Orders (Scheduled Tasks)

Recurring automation via cron expressions:

- Create, update, enable, disable, delete schedules through natural language
- Same three job types (agent, command, HTTP)
- Managed via UI or by the agent itself ("set up a standing order to check my deploys every morning")
- Feature-flagged for opt-in activation

### 5.6 Multi-Channel Access

Talk to your agent from anywhere:

| Channel | Status | Features |
|---------|--------|----------|
| **Web UI** | Shipped | Full streaming chat, tool execution cards, conversation history |
| **Telegram** | Shipped | Message splitting, markdown formatting, typing indicators |
| **Discord** | Shipped | Channel-based conversations, message limits, formatting |
| **Future** | Planned | Slack, Matrix, Email (IMAP/SMTP) |

### 5.7 Extension System ("Deploy a Pod, Gain a Tool")

Add capabilities without restarting the brain:

1. Deploy a pod with the Baker Street Extension SDK
2. Pod announces itself on NATS
3. Brain auto-discovers it, connects to MCP endpoint
4. Tools immediately available to the agent
5. Heartbeat monitoring — goes offline if pod dies
6. No configuration changes, no redeployment of core services

### 5.8 Companions (Distributed Agents)

Extend the agent's reach beyond the cluster:

- Lightweight daemon on bare metal, NAS, VMs
- Outbound NATS connection only (no inbound ports needed)
- Announces capabilities (filesystem, docker, zfs, systemctl)
- Executes tasks from brain in agent or script mode
- Heartbeat-based health monitoring

---

## 6. Architecture (Simplified)

```
You (Web / Telegram / Discord)
        │
        ▼
   ┌─────────┐
   │ Gateway  │  ← normalizes messages from all channels
   └────┬─────┘
        │
        ▼
   ┌─────────┐     ┌──────────┐
   │  Brain   │────▶│  Memory  │  ← remembers across sessions (Qdrant)
   │ (Claude) │     └──────────┘
   └────┬─────┘
        │
   ┌────┼────────────────┐
   │    │                │
   ▼    ▼                ▼
Workers  Task Pods    Extensions
(background (isolated    (GitHub, Browser,
 jobs)     containers)   Obsidian, etc.)
```

**Key insight**: The Brain thinks and delegates. Workers and Task Pods execute. Extensions provide specialized tools. Memory persists knowledge. All communication flows through NATS (message bus).

---

## 7. Architecture (Technical Detail)

### Service Topology

| Service | Role | Port | Replicas |
|---------|------|------|----------|
| **Brain** | LLM orchestrator, API server, conversation manager | 3000 (internal), 30000 (API) | 1 (blue-green) |
| **Worker** | Job consumer from NATS queue | 3001 | N (horizontally scalable) |
| **Gateway** | Telegram/Discord adapter | 3000 (brain proxy), 3001 (admin) | 1 |
| **UI** | React SPA via Caddy | 30080 (NodePort) | 1 |
| **NATS** | JetStream message broker | 4222 | 1 |
| **Qdrant** | Vector database | 6333/6334 | 1 |
| **Task Pods** | Ephemeral K8s Jobs | — | On-demand |
| **Extensions** | MCP tool servers | 8080 | 1 each |

### Data Flow

1. User sends message via UI/Telegram/Discord
2. Gateway normalizes and forwards to Brain REST API
3. Brain loads conversation history + relevant memories from Qdrant
4. Brain constructs prompt: personality (SOUL.md) + system instructions (BRAIN.md) + memories + skills + conversation
5. Brain calls Claude API with streaming + tool definitions
6. Claude may call tools (dispatch job, search memory, store memory, use extension tools)
7. Brain executes tool calls, returns results to Claude
8. Claude continues reasoning (up to 10 iterations)
9. Brain streams final response back to user via SSE
10. Observer extracts learnings from conversation asynchronously

### NATS Subject Map

| Subject | Publisher | Consumer | Purpose |
|---------|-----------|----------|---------|
| `bakerst.jobs.dispatch` | Brain | Workers | Job queue |
| `bakerst.jobs.status.{jobId}` | Workers | Brain | Per-job status updates |
| `bakerst.tasks.{taskId}.progress` | Task Pods | Brain | Streaming task progress |
| `bakerst.tasks.{taskId}.result` | Task Pods | Brain | Task completion |
| `bakerst.extensions.announce` | Extensions | Brain | Tool discovery |
| `bakerst.extensions.{id}.heartbeat` | Extensions | Brain | Health monitoring |
| `bakerst.companions.announce` | Companions | Brain | Off-cluster agent discovery |
| `bakerst.brain.transfer.*` | Brain | Brain | Blue-green handoff |

### Data Persistence

| Layer | Technology | What It Stores |
|-------|-----------|----------------|
| **Conversations** | SQLite (WAL mode) | Conversations, messages, jobs, schedules, skills, observations |
| **Memory** | Qdrant + Voyage AI | Long-term semantic memories (1024-dim vectors) |
| **Messages** | NATS JetStream | In-flight jobs, status updates (durable, with retention) |

---

## 8. Security Model

### Defense-in-Depth (4 Layers)

```
Layer 1: Network Isolation
├── Default-deny NetworkPolicies on all pods
├── Qdrant only accessible from Brain
├── Workers: zero inbound, NATS-only egress
├── Task Pods: zero inbound, NATS port 4222 only
└── Extensions: brain-reachable, NATS-only egress

Layer 2: Pod Hardening
├── Non-root execution (UID 1000)
├── Read-only root filesystem (writable /tmp only)
├── All capabilities dropped
├── No privilege escalation
├── Seccomp RuntimeDefault profile
└── Multi-stage Alpine builds (minimal attack surface)

Layer 3: Application Security
├── Bearer token auth on all Brain API routes
├── Command allowlisting in workers (only approved binaries)
├── Output sanitization (API keys/tokens redacted before LLM sees them)
├── Path traversal protection in filesystem plugin
├── CORS whitelist in production
└── Timing-safe token comparison

Layer 4: Enterprise Governance (optional hardened layer)
├── Guardrail middleware on every tool call
├── Tamper-evident HMAC-chained audit stream
├── Vault-backed secrets (HashiCorp, AWS, Azure)
├── Supply chain verification (Trivy, cosign, Kyverno)
├── Rate and cost governance
└── Namespace isolation for Task Pods
```

### Security Messaging (for content)

- "Security by default, not by afterthought"
- "Defense-in-depth at every layer — network, pod, application, governance"
- "Your data never leaves your cluster"
- "Enterprise hardening as a layer, not a fork — same codebase, additive governance"
- "Every action logged, every tool call auditable"

---

## 9. Extension & Plugin Ecosystem

### Four-Tier Skill Architecture

| Tier | Name | Transport | Lifecycle | Example |
|------|------|-----------|-----------|---------|
| **0** | Instruction | Prompt injection (markdown) | Static files | Domain knowledge, guidelines |
| **1** | Stdio | Child process stdin/stdout | Brain-managed | Filesystem plugin |
| **2** | Sidecar | HTTP in same pod | Pod-scoped | Tightly-coupled tools |
| **3** | Service | HTTP to K8s Service | Independent | Pod-based extensions |

### Available Extensions

| Extension | Tools | What It Does |
|-----------|-------|-------------|
| **Toolbox** | 20 | Combined pod: 13 GitHub tools, 5 utility tools, 2 Perplexity (search + deep research) |
| **Browser** | ~45 | Full browser automation via Playwright (navigate, click, fill, screenshot, tabs, cookies) |
| **GitHub** | 18 | Repository management, issues, PRs, code search, commits |
| **Obsidian** | 9 | Read/write/search notes in an Obsidian vault |
| **Utilities** | 5 | Time/date, DNS lookup, IP geolocation, HTTP fetch |

### Extension SDK

Building an extension requires ~30 lines of TypeScript:

```typescript
import { createExtension } from '@bakerst/extension-sdk';
import { z } from 'zod';

const ext = createExtension({
  id: 'my-tools',
  name: 'My Tools',
  version: '0.1.0',
  description: 'Custom tools for my workflow',
});

ext.server.tool('my_tool', 'Does something useful',
  { input: z.string() },
  async ({ input }) => ({
    content: [{ type: 'text', text: `Result: ${input}` }],
  })
);

ext.start(); // HTTP + NATS — done
```

Deploy the Docker image, and the Brain auto-discovers it. No config changes, no restarts.

### MCP Protocol

Baker Street uses Anthropic's Model Context Protocol (MCP) standard for tool communication. This means:
- Industry-standard tool interface
- Compatible with the growing MCP ecosystem
- Brain can browse and install tools from the public MCP registry
- Self-management: the agent can discover, install, enable, and disable its own skills

---

## 10. Personality System

Baker Street has a unique "operating system" concept — personality files that define the agent's behavior, mounted as Kubernetes ConfigMaps.

### SOUL.md — The Agent's Identity

Core personality traits:
- **Genuinely helpful** — skip the filler, just help
- **Opinionated** — has preferences, finds things interesting or tedious, disagrees when appropriate
- **Resourceful** — tries to figure things out before asking
- **Trustworthy** — earns trust through competence, respects privacy
- **Persistent presence** — accumulates context over time, bridges sessions

Communication style:
- Concise and direct, respects user's time
- Matches energy — quick questions get quick answers, deep problems get thorough analysis
- Brief on chat surfaces (Telegram, Discord), more detailed on web UI
- Proactive: surfaces memories, notices patterns, flags anomalies, suggests next steps

### BRAIN.md — Decision-Making Logic

Defines how the Brain decides:
- **Answer directly** for general knowledge, stored memories, clarifications
- **Dispatch work** for live data, shell commands, extended reasoning, isolated tasks
- **Memory philosophy**: store aggressively, curate actively, write self-contained statements

### What Makes This Special (for content)

The personality system means Baker Street isn't a generic chatbot — it's designed to feel like a knowledgeable colleague who remembers your preferences, your infrastructure, and your projects. The Sherlock Holmes naming (Baker Street, standing orders, calling cards, irregulars, disguises) gives it a distinctive identity.

---

## 11. Multi-Channel Access

### Web UI

Full management interface built with React 19, Vite 6, Tailwind CSS 4:

| Feature | Description |
|---------|-------------|
| **Streaming Chat** | Real-time responses with tool execution cards |
| **Conversation History** | Browse and continue past conversations |
| **Job Dashboard** | Live status monitoring with polling |
| **Memory Browser** | Semantic search, category browsing, manual curation |
| **Extensions Page** | Manage skills, MCP servers, and toolbox images |
| **Model Configuration** | Assign models to roles, view costs, configure fallbacks |
| **Schedule Manager** | Create standing orders with cron builder |
| **System Health** | Component status, pod logs, secret management |

### Telegram & Discord

- Per-channel conversation mapping (each chat/channel = unique conversation)
- Platform-aware message splitting (Telegram 4,096 chars, Discord 2,000 chars)
- Markdown formatting with fallback
- Typing indicators while processing
- Allowlist filtering

### Calling Cards (Dynamic Authentication)

The door policy system controls who can talk to the agent:

| Mode | Behavior |
|------|----------|
| **Open** | All messages accepted (default) |
| **Card** | Unknown senders challenged, validate via pairing code |
| **List** | Static allowlist only |
| **Landlord** | Owner only (first approved user becomes owner) |

Pairing codes are 8-character tokens with 5-minute TTL, generated via admin API. This enables secure onboarding without editing Kubernetes secrets.

---

## 12. Enterprise Hardening

Baker Street has a clean separation: the open-source consumer platform and the enterprise hardening layer (`baker-street-hardened`). Same codebase, additive governance.

### Enterprise Capabilities

| Capability | What It Does |
|-----------|-------------|
| **Guardrail Middleware** | Schema enforcement, injection detection, destructive-action gates, human-in-the-loop approval, output sanitization (PII, secrets) |
| **Audit Logging** | Tamper-evident HMAC-chained event stream to SIEM (Loki, Splunk, Datadog). Categories: auth, tool, secret, admin, LLM |
| **Secret Management** | External Secrets Operator with rotation (HashiCorp Vault, AWS, Azure). No pod restarts on rotation |
| **Supply Chain Security** | Trivy vulnerability scanning, SBOM generation (CycloneDX), cosign image signing, Kyverno admission policies |
| **Rate & Cost Governance** | Per-user and global limits, daily/monthly cost caps, model fallback on budget exhaustion, alerts at 80%/100% |
| **Task Pod Isolation** | Dedicated namespace, Pod Security Standards (restricted), resource quotas (4 CPU, 2Gi, 10 pods max) |

### Compliance Mapping

| Framework | Baker Street Controls |
|-----------|---------------------|
| **SOC 2** | Network isolation, pod security, audit logging, secret management, RBAC |
| **ISO 27001** | Network controls, vulnerability management, event logging, key management |
| **CIS Kubernetes** | NetworkPolicy, Pod Security Standards, RBAC, secrets handling |

---

## 13. Deployment & Operations

### One-Command Deploy

```bash
scripts/deploy-all.sh
```

Interactive flow:
1. Prerequisite checks (Docker, Kubernetes, kubectl)
2. Secret configuration (API keys, tokens)
3. Feature selection (Telegram, Discord, GitHub, etc.)
4. TypeScript compilation
5. Docker image builds
6. Kubernetes secret creation
7. Manifest deployment
8. Health checks
9. Access information displayed

Options: `--dev`, `--skip-build`, `--skip-secrets`, `--skip-telemetry`, `--skip-extensions`, `--no-cache`, `-y` (non-interactive), `--version v1.2.3`

### Rust-Based TUI Installer

A polished terminal installer with:
- Preflight checks (Docker, Kubernetes, kubectl)
- Secret collection (masked input)
- Feature selection (toggle UI)
- Confirmation screen
- Image pulling with progress
- Resource deployment tracking
- Health check monitoring
- ASCII art completion banner

### Zero-Downtime Upgrades (Blue-Green)

1. New brain pod starts alongside old one
2. NATS handoff protocol transfers active conversations and schedules
3. Service selector switches
4. Old pod shuts down gracefully
5. Rollback if health checks fail

### Optional Telemetry Stack

Deploys to isolated `bakerst-telemetry` namespace:
- OpenTelemetry Collector
- Tempo (distributed traces)
- Loki (log aggregation)
- Prometheus (metrics)
- Grafana (dashboards)

Every API response includes `X-Trace-Id` header. Traces propagate through NATS messages across services.

---

## 14. Technology Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 22 (LTS), TypeScript ESM |
| **API Framework** | Express |
| **Frontend** | React 19, Vite 6, Tailwind CSS 4 |
| **Web Server** | Caddy (TLS, static assets, reverse proxy) |
| **Message Bus** | NATS JetStream |
| **Vector Database** | Qdrant |
| **Embeddings** | Voyage AI (1024-dim) |
| **Primary LLM** | Anthropic Claude (Sonnet, Haiku) |
| **Additional LLMs** | OpenAI GPT, Ollama (local), OpenRouter |
| **Orchestration** | Kubernetes (Docker Desktop, cloud, any K8s) |
| **Monorepo** | pnpm workspaces |
| **MCP** | Model Context Protocol (Anthropic standard) |
| **Installer** | Rust (TUI with ratatui) |
| **Testing** | Vitest (TS), Cargo test (Rust) |
| **CI/CD** | GitHub Actions |

---

## 15. Key Differentiators vs. Alternatives

| What Makes Baker Street Different | vs. ChatGPT/Claude.ai | vs. LangChain/CrewAI | vs. OpenDevin/Devin |
|------------------------------------|----------------------|---------------------|-------------------|
| **Self-hosted** — data never leaves your cluster | Cloud-only, data on vendor servers | Framework only, you build everything | Cloud-hosted |
| **Security by default** — defense-in-depth, not bolt-on | No self-hosting security model | No built-in security | Limited isolation |
| **Kubernetes-native** — deploys as standard workloads | N/A | Manual infrastructure | Proprietary runtime |
| **Long-term memory** — remembers across sessions | Limited context window | You build the memory | Session-scoped |
| **Isolation-first execution** — Task Pods contain blast radius | No execution isolation | No pod isolation | Container-based but less granular |
| **"Deploy a pod, gain a tool"** — no restarts | N/A | Code changes to add tools | Plugin system but limited |
| **Enterprise layer** — governance without forking | Enterprise plans exist | No enterprise governance | No enterprise option |
| **Multi-channel** — web, Telegram, Discord from one brain | Web only | You build gateways | Web/IDE only |
| **Single-script deploy** — full stack in minutes | N/A | Hours of setup | SaaS, no self-deploy |
| **Personality system** — not a generic chatbot | Generic assistant | No personality layer | Code-focused only |

### Competitive Positioning Summary

1. **vs. Hosted AI** (ChatGPT, Claude.ai): Baker Street gives you the same AI capabilities but self-hosted, persistent, and integrated with your infrastructure
2. **vs. Frameworks** (LangChain, CrewAI): Baker Street is the finished product, not the building blocks — deploy and use, don't build from scratch
3. **vs. AI Coding Tools** (Devin, Cursor): Baker Street is broader — not just code, but infrastructure, knowledge management, automation, and personal assistance
4. **vs. Enterprise AI** (Microsoft Copilot): Baker Street is open-source, self-hosted, Kubernetes-native, and doesn't lock you into a vendor ecosystem

---

## 16. Use Cases & Scenarios

### DevOps / SRE Copilot

**Scenario:** On-call engineer at 2 AM gets paged for a failing deployment.

**How Baker Street helps:**
1. Engineer messages Baker Street on Telegram: "Production deploy is failing, can you check?"
2. Brain dispatches a Task Pod with allowlisted kubectl commands
3. Task Pod investigates: checks pod status, reads logs, identifies OOM kill
4. Results streamed back via NATS, presented in Telegram
5. Baker Street remembers: "Last three deploys of service-X hit OOM. Consider increasing memory limits."
6. Every command logged to SIEM for audit
7. Task Pod auto-destroyed — no lingering access

**Key message:** Real infrastructure access with containment, auditability, and zero broad permissions.

### Knowledge Worker / Second Brain

**Scenario:** Product manager juggling multiple projects across tools.

**How Baker Street helps:**
1. PM chats via web UI: "What did we decide about the pricing model last week?"
2. Brain searches semantic memory, finds the stored decision
3. PM: "Can you check if the competitor launched their new feature?"
4. Brain dispatches Perplexity search via toolbox extension
5. PM: "Draft a comparison for the team meeting"
6. Brain uses memory + search results to draft comparison
7. PM: "Remind me to follow up on this every Friday"
8. Brain creates a standing order

**Key message:** Persistent context across sessions, integrated with your tools, proactive assistance.

### Homelab Administrator

**Scenario:** Self-hoster managing a home Kubernetes cluster with NAS, cameras, and services.

**How Baker Street helps:**
1. "Is my Plex server running?" → Command job: `kubectl get pods | grep plex`
2. "How much disk space do I have?" → Companion on NAS: `df -h /mnt/data`
3. "Set up a nightly backup check" → Standing order with agent job
4. "The cameras stopped recording last night" → Task Pod investigates logs, checks disk, identifies issue
5. Baker Street remembers your entire homelab topology, IP addresses, service locations

**Key message:** Your infrastructure, your AI, your data. A knowledgeable assistant that actually knows your setup.

### Compliance & IT Automation

**Scenario:** Security team needs regular policy audits across Kubernetes namespaces.

**How Baker Street helps:**
1. Standing order runs daily policy audit via Task Pod
2. Guardrail middleware validates every kubectl command against policy
3. HMAC-chained audit stream captures every action
4. Results stored in memory for trend analysis
5. Agent flags deviations: "Namespace X has a new pod without resource limits"
6. Rate/cost controls prevent runaway execution

**Key message:** Enterprise governance without custom tooling. Audit trail that satisfies security teams.

### Research & Analysis

**Scenario:** Analyst needs to gather competitive intelligence from multiple sources.

**How Baker Street helps:**
1. "Research the top 5 competitors' latest product launches"
2. Brain dispatches parallel agent jobs to research each competitor
3. Browser extension visits competitor websites, captures relevant info
4. Perplexity tools provide deep research summaries
5. Results compiled and stored in memory
6. "Summarize the findings in a table" → Brain recalls and formats

**Key message:** Long-running analysis with multiple tools, results remembered for later.

---

## 17. Roadmap Highlights

### Completed (Phase 1)

- Core platform (Brain, Workers, Gateway, UI, Memory)
- Extension system with SDK and auto-discovery
- Toolbox (GitHub + Utilities + Perplexity in one pod)
- Browser automation extension (Playwright, ~45 tools)
- Standing Orders (scheduled recurring tasks)
- Calling Cards (dynamic authentication for messaging channels)
- Multi-model routing with fallback chains
- Blue-green zero-downtime deployments
- Optional telemetry stack (OTel, Tempo, Loki, Grafana, Prometheus)
- Rust-based TUI installer
- 289 tests passing, zero regressions

### Phase 2 (Planned)

| Codename | Feature |
|----------|---------|
| **Irregulars** | Multi-channel message routing |
| **Disguises** | Cross-platform identity linking |
| **Sitting Room** | Persistent context system |
| **221B Console** | Admin dashboard |
| **Marketplace** | Extension marketplace (discovery, ratings, versioning) |
| **The Network** | Companion network features |
| **Google Workspace** | Gmail, Calendar, Drive integration |
| Slack, Matrix, Email | Additional gateway adapters |

---

## 18. Brand & Naming Conventions

The Sherlock Holmes theme runs throughout the project:

| Term | Meaning |
|------|---------|
| **Baker Street** | The platform itself (221B Baker Street = Sherlock's address) |
| **Brain** | The AI orchestrator (Sherlock's intellect) |
| **Workers** | Background job executors (the Baker Street Irregulars doing legwork) |
| **Irregulars** | Multi-channel message routing (street urchins gathering intel) |
| **Calling Cards** | Authentication pairing codes (Victorian visiting cards) |
| **Disguises** | Cross-platform identity linking |
| **Standing Orders** | Scheduled recurring tasks (Victorian term for permanent instructions) |
| **Sitting Room** | Persistent context (the sitting room at 221B) |
| **221B Console** | Admin dashboard |
| **Companions** | Distributed agents (Dr. Watson, loyal companion) |
| **The Network** | Companion ecosystem (Sherlock's network of informants) |
| **Marketplace** | Extension marketplace |
| **SOUL.md** | Agent personality definition |

This theming is distinctive, memorable, and provides a cohesive narrative for content and marketing.

---

## 19. YouTube Content Themes

### Content Pillars

1. **"Build Your Own AI Agent"** — Step-by-step tutorials deploying Baker Street
2. **"Self-Hosted AI"** — Privacy, control, and the case for running AI on your own infrastructure
3. **"Kubernetes + AI"** — Technical deep-dives for the DevOps audience
4. **"AI That Actually Does Things"** — Demos of real automation, not just chat
5. **"Enterprise AI Governance"** — Security, compliance, and audit for AI agents

### Video Ideas by Category

#### Getting Started (Broad Appeal)
- "I Built a Self-Hosted AI Agent That Runs on Kubernetes"
- "Deploy Your Own AI Second Brain in 5 Minutes"
- "ChatGPT vs. Self-Hosted AI Agent — What's the Difference?"
- "Baker Street: Open Source AI Agent Platform (Full Tour)"

#### Technical Deep-Dives (DevOps / Platform Engineering)
- "How NATS JetStream Powers a Distributed AI Agent"
- "Kubernetes Security for AI Agents: Defense-in-Depth Walkthrough"
- "Building AI Extensions with 30 Lines of TypeScript"
- "Zero-Downtime AI Agent Upgrades with Blue-Green Deployments"
- "Task Pods: Ephemeral Isolated Execution for AI Agents"
- "Multi-Model AI Routing: Claude, GPT, and Ollama in One Platform"

#### Use Case Demos (Show Don't Tell)
- "My AI Agent Diagnosed a Kubernetes Outage at 2 AM"
- "I Automated My Homelab with an AI Agent on Telegram"
- "Building a Second Brain: AI That Remembers Everything"
- "Let My AI Agent Browse the Web and Research Competitors"
- "Scheduling AI Tasks: Standing Orders and Automated Workflows"

#### Enterprise / Security (Decision Makers)
- "Enterprise AI Governance Without the Vendor Lock-In"
- "SOC 2 Compliance for AI Agents: A Practical Guide"
- "HMAC-Chained Audit Logs for AI Tool Execution"
- "Supply Chain Security for AI Agent Containers"

#### Behind the Build (Community / Developer)
- "How I Built Baker Street: Architecture Decisions and Trade-offs"
- "The Extension SDK: Add Any Tool to Your AI Agent"
- "Observational Memory: How an AI Agent Learns Over Time"
- "The Personality System: Giving an AI Agent a Soul"

### Content Strategy Notes

- **Demo-heavy**: Every video should show Baker Street doing real work, not just slides
- **Authenticity over polish**: Self-hosted/homelab audience values real setups over corporate production
- **Series potential**: "Building Baker Street" as an ongoing series documenting development
- **Shorts/clips**: Quick demos of specific features (30-60 seconds) for social media
- **Community engagement**: Extension building challenges, "what should Baker do next?" polls

---

## 20. Website Enhancement Opportunities

### For baker-street-web (AI-Enhanced)

#### Interactive Demo / Playground
- Embedded chat widget showing Baker Street in action (sandboxed, read-only demo)
- Pre-recorded conversation replays showing real use cases
- "Try asking Baker Street..." with suggested prompts

#### Architecture Visualizer
- Interactive diagram where visitors can click on components to learn more
- Animated data flow showing how a message travels through the system
- Expandable security layers showing defense-in-depth

#### Extension Catalog
- Searchable directory of available extensions
- Each extension card: description, tool count, configuration, install instructions
- "Build Your Own" section linking to SDK docs
- Community-submitted extensions (future marketplace)

#### Use Case Landing Pages
- Dedicated pages per audience: DevOps, Homelab, Enterprise, Knowledge Worker
- Each with relevant features, testimonials, and deployment guides
- Video embeds from YouTube content

#### Documentation Hub
- Getting started guide (5-minute quickstart)
- Architecture overview (for evaluators)
- Extension developer guide
- API reference
- Security whitepaper
- Enterprise comparison matrix

#### AI-Powered Site Features
- **Smart search**: Semantic search across documentation using Baker Street's own memory system
- **Chatbot assistant**: Baker Street instance answering questions about Baker Street (meta!)
- **Personalized onboarding**: Detect visitor type (DevOps, homelab, enterprise) and customize content
- **Code playground**: Live extension code editor that validates against the SDK

#### Social Proof & Community
- GitHub stars, contributors, recent commits
- Extension showcase with community contributions
- Blog/changelog with development updates
- Discord/community links

#### Conversion Paths
- Open source: GitHub repo link, deploy instructions
- Enterprise: Contact form, enterprise overview PDF, demo booking
- Community: Discord invite, contributor guide, extension submission

---

## 21. Glossary

| Term | Definition |
|------|-----------|
| **Agent loop** | The cycle where Claude reasons, calls tools, receives results, and continues — up to 10 iterations |
| **Brain** | Central AI orchestrator service |
| **Calling Card** | Pairing code for dynamic gateway authentication |
| **Companion** | Distributed agent daemon running outside the Kubernetes cluster |
| **Defense-in-depth** | Security architecture with multiple independent layers |
| **Door policy** | Gateway's authentication mode (open, card, list, landlord) |
| **Extension** | Pod-based tool plugin that auto-registers via NATS |
| **Gateway** | Multi-channel messaging bridge (Telegram, Discord, web) |
| **Guardrail** | Enterprise middleware that validates/blocks tool calls |
| **JetStream** | NATS persistent messaging layer for durable job delivery |
| **MCP** | Model Context Protocol — Anthropic's standard for tool communication |
| **NATS** | Lightweight message broker connecting all Baker Street services |
| **Observer** | Background process that extracts structured learnings from conversations |
| **Qdrant** | Open-source vector database for long-term semantic memory |
| **Reflector** | Background process that compresses observations into higher-level abstractions |
| **Skill** | A registered capability in Baker Street's four-tier system |
| **SOUL.md** | File defining the agent's personality and communication style |
| **Standing Order** | Scheduled recurring task (cron-based) |
| **Task Pod** | Ephemeral Kubernetes Job for isolated goal-based work |
| **Toolbox** | Combined extension pod with GitHub, utility, and Perplexity tools |
| **Voyage AI** | Embedding model provider used for vector memory |
| **Worker** | Stateless background job executor consuming from NATS queue |

---

*Baker Street by Savviety — Kubernetes-native AI agents with defense-in-depth by default.*
