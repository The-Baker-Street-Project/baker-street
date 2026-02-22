# Observational Memory — Implementation Plan

Reference architecture: `observational_memory_architecture.md`

## Current State

The brain service currently has two memory layers:

1. **Raw history (SQLite)** — `messages` table stores every user/assistant message per conversation. `loadHistory()` in `agent.ts:350` loads *all* messages for a conversation and sends them verbatim to Claude. No trimming, no summarization. Long conversations will exceed the context window.

2. **Long-term memory (Qdrant)** — Explicit `memory_store` tool calls save facts. Top-5 auto-retrieved per turn via `memoryService.search()` in `agent.ts:361`. These go into the system blocks (prefix).

**What's missing** is the middle layer: automatic summarization of conversation history into structured observations, a stable-prefix prompt layout for caching, and lifecycle management to keep token counts bounded.

---

## Phase 1: Schema + Context Builder

**Goal:** Add the database tables for observational memory and replace the inline prompt construction in `agent.ts` with a `ContextBuilder` that separates the stable prefix from the changing tail.

### 1a. New SQLite tables in `db.ts`

Add these tables inside `getDb()` after the existing `messages` table:

```sql
-- Append-only observation chunks produced by the Observer
CREATE TABLE IF NOT EXISTS observations (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id),
  created_at          TEXT NOT NULL,
  text                TEXT NOT NULL,
  token_count         INTEGER NOT NULL,
  tags                TEXT,              -- JSON array: ["Decision","Preference",...]
  source_message_from TEXT NOT NULL,     -- message.id of first source message
  source_message_to   TEXT NOT NULL      -- message.id of last source message
);

-- Materialized observation log (latest version is the active one)
CREATE TABLE IF NOT EXISTS observation_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id),
  version             INTEGER NOT NULL DEFAULT 1,
  text                TEXT NOT NULL,
  token_count         INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE(conversation_id, version)
);

-- Reflector compaction outputs
CREATE TABLE IF NOT EXISTS reflections (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id),
  created_at          TEXT NOT NULL,
  replaces_version    INTEGER NOT NULL,  -- observation_log version this replaces
  output_text         TEXT NOT NULL,
  token_count         INTEGER NOT NULL
);

-- Per-conversation memory accounting
CREATE TABLE IF NOT EXISTS memory_state (
  conversation_id            TEXT PRIMARY KEY REFERENCES conversations(id),
  observed_cursor_message_id TEXT,           -- last message.id processed by Observer
  unobserved_token_count     INTEGER NOT NULL DEFAULT 0,
  observation_token_count    INTEGER NOT NULL DEFAULT 0,
  last_observer_run          TEXT,
  last_reflector_run         TEXT,
  lock_version               INTEGER NOT NULL DEFAULT 0
);
```

Add CRUD helper functions:

```
// observations
addObservation(conversationId, text, tokenCount, tags, fromMsgId, toMsgId)
getObservations(conversationId) → ObservationRow[]

// observation_log
getActiveObservationLog(conversationId) → { version, text, token_count } | null
upsertObservationLog(conversationId, version, text, tokenCount)

// memory_state
getMemoryState(conversationId) → MemoryStateRow | null
initMemoryState(conversationId) → void
updateMemoryState(conversationId, updates, expectedLockVersion) → boolean  // optimistic lock
```

### 1b. Token counting utility

New file: `services/brain/src/token-count.ts`

```typescript
/**
 * Estimate token count from text.
 * Uses the ~4 chars/token heuristic for fast, synchronous counting.
 * Accurate enough for threshold triggers — we don't need exact BPE counts.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

Why not use a tokenizer library: adds a dependency, is slower (matters when called per-message), and the thresholds are approximate anyway. The 4-chars heuristic is within ~15% of tiktoken for English text, which is fine for triggering at 30k vs 35k.

### 1c. Update `addMessage()` to track token counts

Modify `addMessage()` in `db.ts` to also update `memory_state.unobserved_token_count`:

```typescript
export function addMessage(conversationId: string, role: string, content: string): MessageRow {
  // ... existing insert logic ...

  // Update unobserved token count
  const tokens = estimateTokens(content);
  const db = getDb();
  db.prepare(`
    UPDATE memory_state
    SET unobserved_token_count = unobserved_token_count + ?
    WHERE conversation_id = ?
  `).run(tokens, conversationId);

  return row;
}
```

And in `resolveConversation()` (agent.ts), after creating a conversation, also init the memory state:

```typescript
function resolveConversation(conversationId?: string): string {
  // ... existing logic ...
  createConversation(id);
  initMemoryState(id);  // <-- add this
  return id;
}
```

### 1d. Context Builder

New file: `services/brain/src/context-builder.ts`

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { getMessages, getActiveObservationLog, getMemoryState } from './db.js';
import type { MemorySearchResult } from './memory.js';

export interface ContextBuilderConfig {
  keepLastMessages: number;       // default: 12
  keepLastToolSummaries: number;  // default: 6
}

export interface BuiltContext {
  /** Stable system blocks — put cache_control on the last one */
  systemBlocks: Anthropic.Messages.TextBlockParam[];
  /** Recent messages for the tail */
  messages: Anthropic.Messages.MessageParam[];
  /** Whether the observer should run after this turn */
  shouldObserve: boolean;
  /** Whether the reflector should run after this turn */
  shouldReflect: boolean;
}

export function buildContext(
  conversationId: string,
  systemPrompt: string,
  relevantMemories: MemorySearchResult[],
  opts: { useOAuth: boolean; channel?: string },
  config: ContextBuilderConfig,
): BuiltContext {
  // --- Stable prefix ---
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [];

  if (opts.useOAuth) {
    systemBlocks.push({ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." });
  }
  if (systemPrompt) {
    systemBlocks.push({ type: 'text', text: systemPrompt });
  }

  // Observation log goes in the prefix (stable, cacheable)
  const obsLog = getActiveObservationLog(conversationId);
  if (obsLog && obsLog.text) {
    systemBlocks.push({
      type: 'text',
      text: `## Conversation Context (Observations)\n${obsLog.text}`,
    });
  }

  // Qdrant memories in the prefix (changes per-turn, but small)
  if (relevantMemories.length > 0) {
    const lines = relevantMemories.map(
      (m) => `- [${m.category}] ${m.content} (id: ${m.id})`,
    );
    systemBlocks.push({
      type: 'text',
      text: `## Long-Term Memories\n...\n\n${lines.join('\n')}`,
    });
  }

  if (opts.channel && opts.channel !== 'web') {
    systemBlocks.push({
      type: 'text',
      text: `The user is messaging from ${opts.channel}. Keep responses concise.`,
    });
  }

  // --- Tail: recent messages only ---
  const memState = getMemoryState(conversationId);
  const allMessages = getMessages(conversationId);

  let tailMessages: typeof allMessages;
  if (memState?.observed_cursor_message_id) {
    // Find cursor position, take everything after it
    const cursorIdx = allMessages.findIndex(
      (m) => m.id === memState.observed_cursor_message_id,
    );
    if (cursorIdx >= 0) {
      tailMessages = allMessages.slice(cursorIdx + 1);
    } else {
      tailMessages = allMessages.slice(-config.keepLastMessages);
    }
  } else {
    // No observations yet — use all messages (but cap at keepLastMessages)
    tailMessages = allMessages.slice(-config.keepLastMessages);
  }

  // Always keep at least keepLastMessages for continuity
  if (tailMessages.length < config.keepLastMessages) {
    const startIdx = Math.max(0, allMessages.length - config.keepLastMessages);
    tailMessages = allMessages.slice(startIdx);
  }

  const messages: Anthropic.Messages.MessageParam[] = tailMessages.map((r) => ({
    role: r.role as 'user' | 'assistant',
    content: r.content,
  }));

  // --- Threshold checks ---
  const shouldObserve = (memState?.unobserved_token_count ?? 0) > 30_000;
  const shouldReflect = (memState?.observation_token_count ?? 0) > 40_000;

  return { systemBlocks, messages, shouldObserve, shouldReflect };
}
```

### 1e. Integrate into `agent.ts`

Replace the inline prompt construction. The key changes in both `chat()` and `chatStream()`:

**Before (lines 358-378):**
```typescript
const [systemPrompt, relevantMemories] = await Promise.all([...]);
const systemBlocks = buildSystemBlocks(systemPrompt);
if (relevantMemories.length > 0) { ... }
if (opts?.channel ...) { ... }
const messages = loadHistory(conversationId);
messages.push({ role: 'user', content: message });
```

**After:**
```typescript
const [systemPrompt, relevantMemories] = await Promise.all([...]);
const ctx = buildContext(conversationId, systemPrompt, relevantMemories, {
  useOAuth,
  channel: opts?.channel,
}, contextConfig);
const systemBlocks = ctx.systemBlocks;
const messages = ctx.messages;
messages.push({ role: 'user', content: message });
```

After the response is saved, check triggers:
```typescript
addMessage(conversationId, 'user', message);
addMessage(conversationId, 'assistant', text);

// Fire-and-forget observation if threshold crossed
if (ctx.shouldObserve) {
  runObserver(conversationId).catch((err) =>
    log.error({ err }, 'observer failed'),
  );
}
```

### 1f. Configuration

Add to a new `services/brain/src/memory-config.ts` (or inline constants):

```typescript
export const MEMORY_CONFIG = {
  keepLastMessages: 12,
  keepLastToolSummaries: 6,
  observeThresholdTokens: 30_000,
  reflectThresholdTokens: 40_000,
  reflectMinIntervalMinutes: 60,
};
```

### Files touched in Phase 1

| File | Change |
|------|--------|
| `services/brain/src/db.ts` | Add 4 tables + CRUD functions |
| `services/brain/src/token-count.ts` | **New** — `estimateTokens()` |
| `services/brain/src/context-builder.ts` | **New** — `buildContext()` |
| `services/brain/src/memory-config.ts` | **New** — threshold constants |
| `services/brain/src/agent.ts` | Replace inline prompt building with `buildContext()`, add observer trigger after response |
| `services/brain/src/index.ts` | Pass config to agent if needed |

---

## Phase 2: Observer Worker

**Goal:** When unobserved message tokens exceed the threshold, compress older messages into structured observation chunks and advance the cursor.

### 2a. Observer module

New file: `services/brain/src/observer.ts`

```typescript
import Anthropic from '@anthropic-ai/sdk';
import {
  getMessages,
  getMemoryState,
  addObservation,
  getActiveObservationLog,
  upsertObservationLog,
  updateMemoryState,
} from './db.js';
import { estimateTokens } from './token-count.js';

const OBSERVER_SYSTEM_PROMPT = `You are an observation extractor. Given a slice of conversation between a user and an AI assistant, extract the key observations.

Output a structured list of observations. Each observation should be:
- Time-anchored (include approximate date if available)
- Tagged with a category: Decision, Preference, Fact, Issue, NextStep, Outcome
- Self-contained (understandable without the original conversation)
- Concise (1-2 sentences max)

Format:
[tag] Observation text.

Only extract information worth remembering. Skip pleasantries, small talk, and routine exchanges. Focus on:
- Decisions made and their rationale
- User preferences expressed
- Important facts or constraints discovered
- Issues encountered and resolutions
- Action items or next steps agreed upon
- Tool/command outcomes that affect future work`;

export async function runObserver(conversationId: string): Promise<void> {
  const memState = getMemoryState(conversationId);
  if (!memState) return;

  // Get unobserved messages
  const allMessages = getMessages(conversationId);
  let startIdx = 0;

  if (memState.observed_cursor_message_id) {
    const cursorIdx = allMessages.findIndex(
      (m) => m.id === memState.observed_cursor_message_id,
    );
    if (cursorIdx >= 0) startIdx = cursorIdx + 1;
  }

  const unobserved = allMessages.slice(startIdx);
  if (unobserved.length === 0) return;

  // Format messages for the observer prompt
  const slice = unobserved
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n\n');

  // Call Claude Haiku to extract observations (cheap + fast)
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: OBSERVER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: slice }],
  });

  const observationText = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  if (!observationText.trim()) return;

  const tokenCount = estimateTokens(observationText);
  const lastMsg = unobserved[unobserved.length - 1];
  const firstMsg = unobserved[0];

  // Append observation chunk
  addObservation(
    conversationId,
    observationText,
    tokenCount,
    null, // tags extracted inline in the text
    firstMsg.id,
    lastMsg.id,
  );

  // Update the materialized observation log (append to existing)
  const existing = getActiveObservationLog(conversationId);
  const newVersion = (existing?.version ?? 0) + 1;
  const separator = existing?.text ? '\n\n---\n\n' : '';
  const newLogText = (existing?.text ?? '') + separator + observationText;
  const newLogTokens = estimateTokens(newLogText);

  upsertObservationLog(conversationId, newVersion, newLogText, newLogTokens);

  // Advance cursor and reset unobserved count
  updateMemoryState(conversationId, {
    observed_cursor_message_id: lastMsg.id,
    unobserved_token_count: 0,
    observation_token_count: newLogTokens,
    last_observer_run: new Date().toISOString(),
  }, memState.lock_version);
}
```

### 2b. Observer LLM choice

Use **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) for the observer:
- ~20x cheaper than Sonnet for input tokens
- Fast enough to run synchronously after a response without noticeable delay
- Observation extraction is a straightforward summarization task — doesn't need Sonnet-level reasoning

The observer creates a *separate* Anthropic client instance (not the main agent client) so it can use a different model and doesn't interfere with the agent's auth setup (which might be OAuth).

### 2c. Integration in agent.ts

At the end of `chat()` and `chatStream()`, after saving messages:

```typescript
// After saving the response
addMessage(conversationId, 'user', message);
addMessage(conversationId, 'assistant', text);

// Trigger observer if threshold crossed (fire-and-forget)
if (ctx.shouldObserve) {
  runObserver(conversationId).catch((err) =>
    log.error({ err, conversationId }, 'observer failed'),
  );
}
```

The observer runs asynchronously after the response is sent to the user. If it fails, the system degrades gracefully — the next turn just loads more raw messages in the tail.

### 2d. Edge cases

- **First few turns:** No observations exist. Context builder falls back to loading all messages (capped at `keepLastMessages`). This is identical to current behavior.
- **Observer fails mid-run:** Cursor doesn't advance, `unobserved_token_count` stays high, observer retries next turn.
- **Concurrent requests to same conversation:** The `lock_version` in `memory_state` provides optimistic concurrency. If two observers race, the second one's `updateMemoryState` fails and it retries on the next turn.

### Files touched in Phase 2

| File | Change |
|------|--------|
| `services/brain/src/observer.ts` | **New** — `runObserver()` |
| `services/brain/src/agent.ts` | Add observer trigger after response in both `chat()` and `chatStream()` |

---

## Phase 3: Reflector Worker

**Goal:** When the observation log grows beyond 40k tokens, compact it by deduplicating, merging related observations, and removing stale entries.

### 3a. Reflector module

New file: `services/brain/src/reflector.ts`

```typescript
import Anthropic from '@anthropic-ai/sdk';
import {
  getActiveObservationLog,
  getMemoryState,
  upsertObservationLog,
  updateMemoryState,
} from './db.js';
import { estimateTokens } from './token-count.js';
import { MEMORY_CONFIG } from './memory-config.js';

const REFLECTOR_SYSTEM_PROMPT = `You are a memory compactor. Given an observation log from an ongoing conversation, produce a condensed version that preserves all important information while removing:

- Duplicate or near-duplicate observations
- Observations that were superseded by later ones (e.g., "decided to use X" followed by "changed to Y" → keep only Y)
- Trivially obvious facts that don't need to be remembered
- Routine operational details (successful deploys, routine commands) unless they revealed something important

Preserve:
- All active decisions and their rationale
- User preferences (especially recent ones)
- Unresolved issues and open questions
- Important constraints and requirements
- Recent outcomes that inform future work

Output the condensed log in the same format as the input. Keep observations time-anchored. Group related observations together under section headers if helpful.

Target: reduce the log to roughly 60% of its current size while preserving all actionable information.`;

export async function runReflector(conversationId: string): Promise<void> {
  const memState = getMemoryState(conversationId);
  if (!memState) return;

  // Check minimum interval
  if (memState.last_reflector_run) {
    const lastRun = new Date(memState.last_reflector_run).getTime();
    const minInterval = MEMORY_CONFIG.reflectMinIntervalMinutes * 60 * 1000;
    if (Date.now() - lastRun < minInterval) return;
  }

  const obsLog = getActiveObservationLog(conversationId);
  if (!obsLog || !obsLog.text) return;

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  // Reflector uses Sonnet — compaction needs better judgment than Haiku
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: REFLECTOR_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Here is the current observation log (${obsLog.token_count} tokens):\n\n${obsLog.text}`,
    }],
  });

  const condensed = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  if (!condensed.trim()) return;

  const newTokenCount = estimateTokens(condensed);
  const newVersion = obsLog.version + 1;

  // Write new version of the observation log
  upsertObservationLog(conversationId, newVersion, condensed, newTokenCount);

  // Update memory state
  updateMemoryState(conversationId, {
    observation_token_count: newTokenCount,
    last_reflector_run: new Date().toISOString(),
  }, memState.lock_version);
}
```

### 3b. Reflector LLM choice

Use **Claude Sonnet** for the reflector (same model as the main agent). Compaction requires judgment about what's important vs. stale, which Haiku isn't as good at. This is acceptable because the reflector runs rarely (at most once per hour, only when the log exceeds 40k tokens).

### 3c. Integration in agent.ts

Add reflector trigger alongside the observer trigger:

```typescript
if (ctx.shouldObserve) {
  runObserver(conversationId).catch((err) =>
    log.error({ err, conversationId }, 'observer failed'),
  );
}
if (ctx.shouldReflect) {
  runReflector(conversationId).catch((err) =>
    log.error({ err, conversationId }, 'reflector failed'),
  );
}
```

### 3d. Reflector vs Observer ordering

If both thresholds are crossed on the same turn (unlikely but possible), run observer first, *then* reflector. The observer appends new chunks, the reflector compacts the whole log including those new chunks. In practice, because both are fire-and-forget async, we should sequence them:

```typescript
if (ctx.shouldObserve || ctx.shouldReflect) {
  (async () => {
    if (ctx.shouldObserve) await runObserver(conversationId);
    if (ctx.shouldReflect) await runReflector(conversationId);
  })().catch((err) =>
    log.error({ err, conversationId }, 'memory workers failed'),
  );
}
```

### Files touched in Phase 3

| File | Change |
|------|--------|
| `services/brain/src/reflector.ts` | **New** — `runReflector()` |
| `services/brain/src/agent.ts` | Add reflector trigger, sequence observer → reflector |

---

## Phase 4: Prompt Caching Optimization

**Goal:** Leverage Anthropic's prompt caching so the stable prefix (system instructions + observation log) is cached across turns, reducing per-turn cost by up to 90% on the prefix portion.

### 4a. How Anthropic prompt caching works

When you send `system` blocks with `cache_control: { type: "ephemeral" }` on a block, Anthropic caches everything up to and including that block. Subsequent requests that share the same prefix get a cache hit — cached input tokens are billed at 10% of the normal rate.

The cache has a 5-minute TTL (refreshed on each hit). For a conversation where the user sends messages every few minutes, this means near-continuous cache hits.

### 4b. Add `cache_control` to system blocks

In `context-builder.ts`, mark the last stable block with `cache_control`:

```typescript
// After building all systemBlocks...

// Find the last block that's part of the stable prefix
// (observation log or system prompt — NOT the memories or channel hint,
//  which change per-turn)
const lastStableIdx = obsLog ? systemBlocks.length - 1 : (systemPrompt ? 1 : 0);

// Add cache_control to the last stable block
if (lastStableIdx >= 0 && systemBlocks[lastStableIdx]) {
  (systemBlocks[lastStableIdx] as Record<string, unknown>).cache_control = {
    type: 'ephemeral',
  };
}
```

**Block ordering matters.** The system blocks should be ordered:

1. Claude Code identity (if OAuth) — **stable across all conversations**
2. SOUL.md + BRAIN.md system prompt — **stable across all conversations**
3. Observation log — **stable within a conversation** (changes only after observer/reflector) ← `cache_control` goes here
4. Long-term memories (Qdrant) — changes per turn (tail)
5. Channel hint — changes per request (tail)

This way, blocks 1-3 are cached. Blocks 4-5 are in the "tail" of the system blocks and change each turn but are small.

### 4c. Move Qdrant memories out of system blocks

Currently `formatMemoriesForPrompt` puts memories in a system block. For optimal caching, move retrieved memories into the *first user message* in the tail instead:

```typescript
// In context-builder.ts
// Instead of adding memories to systemBlocks, prepend to first message:
if (relevantMemories.length > 0) {
  const memoryBlock = formatMemoriesForPrompt(relevantMemories);
  // This goes into the return value, and agent.ts prepends it
  // to the user message or adds it as a system-context user message
}
```

Or, more practically: keep memories as a system block but put them *after* the cache_control breakpoint. Anthropic caches everything up to the breakpoint, so blocks after it are "uncached tail" — this is fine because memories are small (~500 tokens) and change every turn.

### 4d. Monitoring

Add logging to track caching effectiveness. The Anthropic API response includes `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens`:

```typescript
// In agent.ts, after each API call:
const usage = response.usage;
log.info({
  conversationId,
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  cacheCreation: (usage as Record<string, unknown>).cache_creation_input_tokens ?? 0,
  cacheRead: (usage as Record<string, unknown>).cache_read_input_tokens ?? 0,
}, 'claude api usage');
```

This lets you see:
- How many tokens are being cache-hit per turn
- The ratio of cached vs uncached input tokens
- Whether the observation log is stable enough between turns

### 4e. Metrics endpoint

Add a simple diagnostics endpoint in `api.ts`:

```typescript
app.get('/conversations/:id/memory', (req, res) => {
  const conversationId = req.params.id;
  const memState = getMemoryState(conversationId);
  const obsLog = getActiveObservationLog(conversationId);
  const observations = getObservations(conversationId);

  res.json({
    memoryState: memState,
    observationLog: obsLog ? {
      version: obsLog.version,
      tokenCount: obsLog.token_count,
      textLength: obsLog.text.length,
    } : null,
    observationCount: observations.length,
    totalObservationTokens: observations.reduce((sum, o) => sum + o.token_count, 0),
  });
});
```

### Files touched in Phase 4

| File | Change |
|------|--------|
| `services/brain/src/context-builder.ts` | Add `cache_control` to last stable system block, reorder blocks |
| `services/brain/src/agent.ts` | Log cache hit/miss stats from API response usage |
| `services/brain/src/api.ts` | Add `GET /conversations/:id/memory` diagnostics endpoint |

---

## Implementation Order (across all phases)

```
Phase 1 (foundation):
  1. services/brain/src/token-count.ts         — new, no dependencies
  2. services/brain/src/memory-config.ts        — new, no dependencies
  3. services/brain/src/db.ts                   — add tables + CRUD
  4. services/brain/src/context-builder.ts      — new, depends on db.ts
  5. services/brain/src/agent.ts                — swap to context builder

Phase 2 (observer):
  6. services/brain/src/observer.ts             — new, depends on db.ts
  7. services/brain/src/agent.ts                — add observer trigger

Phase 3 (reflector):
  8. services/brain/src/reflector.ts            — new, depends on db.ts
  9. services/brain/src/agent.ts                — add reflector trigger

Phase 4 (caching):
  10. services/brain/src/context-builder.ts     — add cache_control
  11. services/brain/src/agent.ts               — add usage logging
  12. services/brain/src/api.ts                 — add diagnostics endpoint
```

Each phase is independently deployable. Phase 1 changes behavior (tail-only messages instead of full history) but is backwards-compatible — conversations with no observations yet fall back to loading the last N messages. Phases 2-4 are additive.

## Verification Plan

### Phase 1
- `pnpm -r build` — compiles
- Start brain, send a few messages — verify `memory_state` row is created
- Check that conversations still work normally (context builder loads full history when no observations exist)

### Phase 2
- Send >30k tokens of messages in a conversation
- Verify `observations` table gets a row
- Verify `observation_log` has a materialized log
- Verify `memory_state.observed_cursor_message_id` advanced
- Next turn should show the observation log in system blocks and fewer raw messages in the tail

### Phase 3
- Manually set `observation_token_count > 40000` in a conversation's memory_state (or send a *lot* of messages)
- Verify reflector produces a condensed log
- Verify `observation_log` gets a new version with fewer tokens

### Phase 4
- Check API response `usage` field for `cache_read_input_tokens > 0` on consecutive turns
- Verify cache hit ratio via the logging
- Check `/conversations/:id/memory` endpoint returns correct stats
- Compare per-turn token costs before and after (should see significant reduction)

## Cost Projections

Rough estimates for a typical conversation:

| Metric | Before (no obs memory) | After (with obs memory + caching) |
|--------|----------------------|----------------------------------|
| System prompt tokens per turn | ~2,000 | ~2,000 (cached) |
| History tokens per turn (20 exchanges) | ~15,000 | ~3,000 (tail) + ~5,000 (obs log, cached) |
| Effective input cost per turn | ~17,000 tokens | ~3,000 full + ~7,000 cached (= ~3,700 effective) |
| Observer cost (Haiku, every ~8 turns) | 0 | ~1,000 tokens amortized |
| **Net reduction** | baseline | **~75-80% input token savings** |

The savings compound over conversation length — the longer the conversation, the more the observation log + caching saves vs. loading full raw history.
