# Baker Street Phase 1: Foundation — Delivery Report

**Date:** 2026-03-01
**Branch:** `worktree-feat-rust-installer`
**Base:** `e517b20` | **Head:** `d622252`

---

## Executive Summary

Phase 1 delivers the foundation that unblocks Phase 2 (multi-channel Irregulars, Disguises, 221B Console). Four backlog issues were completed in a single session across 3 sprints, producing 35 changed files, ~3,845 lines of new code, and 66 new tests — all passing with zero regressions.

---

## Scope

| # | Issue | Name | Sprint | Effort |
|---|-------|------|--------|--------|
| 1 | BAK-9 | Combined Extension Pod ("Toolbox") | 1 | Small |
| 2 | BAK-15 | Browser Extension Promotion | 1 | Small |
| 3 | BAK-12 | Standing Orders | 2 | Medium |
| 4 | BAK-13 | Calling Cards | 3 | Medium |

**Deferred to Phase 2:** BAK-10 (Irregulars), BAK-14 (Disguises), BAK-11 (Sitting Room), BAK-16 (221B Console), BAK-17 (Marketplace), BAK-18 (The Network), BAK-19 (Google Workspace)

---

## Sprint 1: Extension Consolidation (BAK-9 + BAK-15)

### BAK-9: Toolbox — Combined Extension Pod

**Problem:** 3 separate pods (utilities, github, obsidian) + perplexity = 4 pods for lightweight tools. Wasteful on Docker Desktop.

**Solution:** Single `extension-toolbox` pod with all tool modules on one MCP server.

- **20 tools** in one pod: 13 GitHub, 5 utility, 2 Perplexity (search + deep research)
- **Graceful degradation:** tools skip registration with a warning if their API key is missing — pod starts regardless
- K8s template with optional `envFrom` for `bakerst-github-secrets` and `bakerst-perplexity-secrets`

**Files created:** `examples/extension-toolbox/` (7 files: package.json, tsconfig.json, Dockerfile, src/index.ts, src/tools/github.ts, src/tools/utilities.ts, src/tools/perplexity.ts) + `tools/installer/src/templates/toolbox.yaml`

### BAK-15: Browser Extension Promotion

**Problem:** `agent-browser-mcp` repo had everything built but wasn't in the installer or release pipeline.

**Solution:** Copied into monorepo as `examples/extension-browser/` with parameterized K8s templates.

- **~45 browser automation tools** (navigate, click, fill, snapshot, screenshot, tabs, cookies, etc.)
- Runs Chromium via Playwright inside the pod with `/dev/shm` shared memory volume
- Higher resource allocation: 1CPU/2GB request, 2CPU/4GB limit

**Files created:** `examples/extension-browser/` (8 files) + `tools/installer/src/templates/browser.yaml`

### Installer + CI Updates

- `templates.rs`: embedded `TOOLBOX_YAML` and `BROWSER_YAML` constants
- `manifest.rs`: added `ext-toolbox`, `ext-browser` images + browser feature
- `main.rs`: deploy in extension sequence, create perplexity secrets, template vars, health watch
- `generate-manifest.mjs`: added to components list
- `release.yml`: added to build matrix (10 parallel builds, up from 8) and digest pipeline

---

## Sprint 2: Standing Orders (BAK-12)

**Problem:** `ScheduleManager` exists in brain with full CRUD + cron execution, but the agent has no tools to create/manage schedules. Users must use the REST API directly.

**Solution:** 3 brain-native tools that delegate to `ScheduleManager`, enabling natural language schedule management.

| Tool | Description |
|------|-------------|
| `manage_standing_order` | Create, update, enable, disable, or delete a schedule |
| `list_standing_orders` | List all schedules with status, last run, cron expression |
| `trigger_standing_order` | Execute a schedule immediately |

- **Feature-flagged:** tools only appear when the `scheduler` feature is enabled
- **Bakerized vocabulary:** "standing order" instead of "schedule"
- **31 new unit tests** covering all actions, error paths, and edge cases

**Files created:** `services/brain/src/schedule-tools.ts`, `services/brain/src/__tests__/schedule-tools.test.ts`
**Files modified:** `services/brain/src/agent.ts`, `services/brain/src/index.ts`

---

## Sprint 3: Calling Cards (BAK-13)

**Problem:** Gateway uses static `allowedChatIds`/`allowedChannelIds` env vars. No dynamic pairing. No way for new users to authenticate without editing K8s secrets.

**Solution:** Door policy system with 4 modes and a pairing code flow.

### Door Policy Modes

| Mode | Behavior |
|------|----------|
| `open` (default) | All messages pass through — identical to current behavior |
| `card` | Check approval, challenge unknown senders, validate pairing codes |
| `list` | Static allowlist only |
| `landlord` | Owner only (first approved sender becomes owner) |

### Pairing Flow (card mode)

1. Unknown sender messages the bot
2. Bot responds with a challenge asking for a pairing code
3. Admin generates a code via the admin API (`POST /pairing-codes`)
4. Sender enters the code in chat
5. Bot validates, approves sender, and forwards future messages normally

### Admin API (port 3001)

| Endpoint | Purpose |
|----------|---------|
| `POST /pairing-codes` | Generate 8-char pairing code (5-min TTL) |
| `GET /approved-senders` | List all approved senders |
| `DELETE /approved-senders/:platform/:senderId` | Revoke a sender |

Auth: `AUTH_TOKEN` bearer (same as brain API).

### Backward Compatibility

- Default `open` mode preserves existing behavior exactly
- Static `TELEGRAM_ALLOWED_CHAT_IDS` / `DISCORD_ALLOWED_CHANNEL_IDS` still work as adapter-level pre-filters
- In `card` mode, static allowed IDs are auto-imported as pre-approved senders on first boot

### Phase 2 Hook

The `door_policy` table schema is designed to accommodate BAK-14 (Disguises) cross-platform identity linking without a breaking migration.

**Files created:** `services/gateway/src/door-policy.ts`, `services/gateway/src/admin-api.ts`, `services/gateway/src/__tests__/door-policy.test.ts`
**Files modified:** `services/gateway/src/mapping-db.ts`, `services/gateway/src/index.ts`, `services/gateway/src/types.ts`, `services/gateway/src/config.ts`, `tools/installer/src/templates/gateway.yaml`, `tools/installer/src/main.rs`

---

## Test Results

| Package | Tests Passed | New Tests | Status |
|---------|-------------|-----------|--------|
| Brain (vitest) | 223/223 | +31 | All passing |
| Gateway (vitest) | 47/47 | +35 | All passing |
| Rust Installer (cargo) | 19/19 | 0 | All passing (no regressions) |
| TypeScript builds | 4/4 packages | — | All exit 0 |
| **Total** | **289/289** | **+66** | **Zero failures** |

---

## Development Process

**Methodology:** Subagent-driven development with two-stage review gates.

| Phase | Agent Count | Purpose |
|-------|------------|---------|
| Codebase exploration | 4 | Parallel deep analysis of extensions, installer, brain, gateway |
| Implementation | 4 | One per task, fresh context each |
| Spec compliance review | 3 | Independent verification: code matches requirements |
| **Total agents** | **11** | |

Each task followed:
1. Dispatch implementation agent with full spec + codebase context
2. Independent spec compliance review (read code, not trust report)
3. Fix any issues found
4. Fresh test verification before marking complete

---

## Commit Log

```
d622252 feat(gateway): add door policy system with pairing codes
2b62924 feat(brain): add standing order tools for agent schedule management
cc94b76 feat(installer): add toolbox and browser to installer + CI pipeline
ac8eabc feat(extensions): add extension-browser (agent-browser-mcp)
c1b4074 fix(toolbox): correct GitHub tool count in log message (13, not 14)
fae628c feat(extensions): add extension-toolbox combined MCP pod
```

---

## Files Summary

| Sprint | Created | Modified | Total |
|--------|---------|----------|-------|
| S1 (BAK-9/15) | 18 | 6 | 24 |
| S2 (BAK-12) | 2 | 2 | 4 |
| S3 (BAK-13) | 3 | 6 | 9 |
| **Total** | **23** | **14** | **35** (+2 lockfile/build artifacts) |

**Lines:** +3,845 / -3

---

## What's Next (Phase 2)

With Phase 1 complete, the following are unblocked:

- **BAK-10 (Irregulars):** Multi-channel message routing — builds on Calling Cards identity
- **BAK-14 (Disguises):** Cross-platform identity linking — extends `door_policy` table
- **BAK-11 (Sitting Room):** Persistent context — builds on Standing Orders patterns
- **BAK-16 (221B Console):** Admin dashboard — can use admin API + door policy endpoints
