# Handoff: Browser Plugin + Observational Memory

## Current State

**Branch:** merged to `main`
**PRs:** #9 (browser + obs memory, merged), #10 (obs memory, merged), #11 (secrets, merged)
**Build:** `pnpm -r build` passes cleanly
**Deploy:** All pods running (brain, worker, gateway, nats, qdrant, ui)

### What's Done

#### Browser Automation Plugin (complete)
- `plugins/browser/` — 7 tools (open, snapshot, click, fill, type, get_text, navigate)
- Shells out to `agent-browser` CLI over CDP to a headless Chrome pod
- `k8s/browser/` — deployment + service for `chromedp/headless-shell:latest`
- Wired into brain Dockerfile (`agent-browser@0.9.2` installed globally), PLUGINS.json, kustomization.yaml, deploy.sh

#### Gateway / Telegram Adapter (complete)
- `services/gateway/` — Telegram bot adapter via grammy
- Bot running as `@irene_assistant_bot`

#### Secrets Management (complete)
- `.env-secrets` file (gitignored) holds all secrets locally
- `scripts/secrets.sh` auto-sources `.env-secrets` — no manual exports needed

#### Observational Memory Phase 1: Schema + Context Builder (complete)
- 4 new SQLite tables: `observations`, `observation_log`, `reflections`, `memory_state`
- `token-count.ts` — fast 4-chars/token estimator
- `memory-config.ts` — threshold constants (30k observe, 40k reflect, 12 tail messages)
- `context-builder.ts` — replaces unbounded `loadHistory()` with stable prefix (system + observation log) + bounded tail (last N messages after cursor)
- `agent.ts` — uses context builder, inits memory state on conversation creation
- `addMessage()` in `db.ts` tracks unobserved token counts automatically

#### Observational Memory Phase 2: Observer Worker (complete)
- `observer.ts` — `runObserver(conversationId)` compresses unobserved messages into structured observations via Haiku 4.5
- Fires async (fire-and-forget) after response when unobserved tokens > 30k
- Appends to `observations` table and materialized `observation_log`
- Advances cursor in `memory_state`, resets unobserved count
- Graceful degradation: skips if no API key, retries on concurrent write race

### What's NOT Done

#### Observational Memory Phase 3: Reflector Worker
- `services/brain/src/reflector.ts` — needs to be created
- Compacts the observation log when it exceeds 40k tokens (min 1hr between runs)
- Uses Sonnet (needs judgment about what to keep vs. merge)
- Wire into `triggerMemoryWorkers()` in agent.ts (placeholder already there at line 343)
- Full spec in `docs/observational-memory-implementation.md` under "Phase 3"

#### Observational Memory Phase 4: Prompt Caching
- Add `cache_control: { type: "ephemeral" }` to last stable system block in context-builder.ts
- Reorder system blocks so cacheable prefix precedes per-turn tail
- Log cache hit/miss stats from API response `usage` field
- Add `GET /conversations/:id/memory` diagnostics endpoint to api.ts
- Full spec in `docs/observational-memory-implementation.md` under "Phase 4"

#### Tests
- No test framework exists in the project yet
- Recommended: add vitest, write unit tests for `token-count.ts`, `db.ts` CRUD, `context-builder.ts`
- These are all pure/synchronous or use in-memory SQLite — no API mocking needed
- `observer.ts` message slicing logic is testable; the Haiku call would need a mock

## Key Files

| File | Purpose |
|------|---------|
| `.env-secrets` | All secrets (gitignored) — auto-loaded by secrets.sh |
| `services/brain/entrypoint.sh` | Container startup entrypoint |
| `services/brain/src/context-builder.ts` | Prompt construction (stable prefix + tail) |
| `services/brain/src/observer.ts` | Observer worker (Haiku extraction) |
| `services/brain/src/db.ts` | All SQLite tables + CRUD |
| `services/brain/src/agent.ts` | Orchestration, `triggerMemoryWorkers()` at line 336 |
| `services/brain/src/memory-config.ts` | Threshold constants |
| `docs/observational-memory-implementation.md` | Full 4-phase plan with code sketches |

## To Resume

1. **Phase 3** — create `reflector.ts` following the plan doc, replace the placeholder log in `triggerMemoryWorkers()`
2. **Phase 4** — add cache_control + monitoring
3. **Tests** — `pnpm add -Dw vitest`, create `services/brain/src/__tests__/`
4. **Deploy & verify** — `scripts/secrets.sh && scripts/build.sh && scripts/deploy.sh`

## Quick Deploy

```bash
scripts/secrets.sh              # auto-loads .env-secrets, creates K8s secret
scripts/build.sh                # docker build all images
scripts/deploy.sh               # kubectl apply + rollout wait
```

