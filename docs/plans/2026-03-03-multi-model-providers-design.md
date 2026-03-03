# Multi-Model Provider System (The Network) — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend Baker Street's ModelRouter to support Anthropic, OpenAI, and multi-endpoint Ollama with native adapters, tool calling translation, failure-aware cooldowns, and installer integration.

**Architecture:** Enhance the existing in-process ModelRouter (Approach A). Add provider adapters that implement the existing `ProviderAdapter` interface. No gateway proxy, no new dependencies beyond what's already present. Brain and worker consume the router unchanged.

**Tech Stack:** TypeScript ESM, `@anthropic-ai/sdk`, `openai` SDK (already a dep), Rust TUI installer

**Linear:** BAK-18

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Extend existing ModelRouter | 3 providers doesn't justify plugin architecture or external SDK |
| Providers (v1) | Anthropic + OpenAI + Ollama | User's active providers. Google/others deferred. |
| Ollama | Auto-discover localhost + prompt for additional endpoints | User runs Ollama on 3 machines |
| Tool calling | Full support for OpenAI | Agent loop must work regardless of provider |
| Session override | UI dropdown → brain API | Simple, no chat commands needed |
| Installer | New Providers phase after Secrets | Checklist UI, model role assignment |
| Routing | Failure-type cooldowns + cheapest-first fallback | No load balancing (YAGNI for personal agent) |

## Section 1: Type Changes

### `model-types.ts`

Expand provider union and add OpenAI config:

```typescript
export type ModelProvider = 'anthropic' | 'openrouter' | 'ollama' | 'openai-compatible' | 'openai';

export interface OpenAIProviderConfig {
  provider: 'openai';
  apiKey: string;
}

export type ProviderConfig =
  | AnthropicProviderConfig
  | OpenRouterProviderConfig
  | OllamaProviderConfig
  | OpenAICompatibleProviderConfig
  | OpenAIProviderConfig;
```

No changes to `ChatParams`, `ChatResponse`, `ModelStreamEvent`, or the `ProviderAdapter` interface. These are already provider-agnostic.

### `model-config.ts`

Add default OpenAI model definitions:

```typescript
{ id: 'gpt-4o',      modelName: 'gpt-4o',      provider: 'openai', maxTokens: 4096,
  costPer1MInput: 2.5,  costPer1MOutput: 10 },
{ id: 'gpt-4o-mini', modelName: 'gpt-4o-mini', provider: 'openai', maxTokens: 4096,
  costPer1MInput: 0.15, costPer1MOutput: 0.6 },
{ id: 'o3-mini',     modelName: 'o3-mini',     provider: 'openai', maxTokens: 4096,
  costPer1MInput: 1.1,  costPer1MOutput: 4.4 },
```

## Section 2: OpenAI Native Adapter

New `createOpenAIAdapter()` in `model-router.ts` using the `openai` SDK.

### Tool Format Translation

Anthropic → OpenAI (outbound):

```typescript
// Anthropic (what brain sends):
{ name: "search", description: "...", input_schema: { type: "object", properties: {...} } }

// OpenAI (what adapter sends to API):
{ type: "function", function: { name: "search", description: "...", parameters: { type: "object", properties: {...} } } }
```

OpenAI → Anthropic (response):

```typescript
// OpenAI response:
{ id: "call_abc", function: { name: "search", arguments: '{"q":"test"}' } }

// Converted to ChatContentBlock:
{ type: "tool_use", id: "call_abc", name: "search", input: { q: "test" } }
```

### Tool Result Messages

When brain sends a `tool_result` content block back, the adapter converts:

```typescript
// Anthropic format (inbound from brain):
{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_abc", content: "result" }] }

// OpenAI format (sent to API):
{ role: "tool", tool_call_id: "call_abc", content: "result" }
```

### Stop Reason Mapping

OpenAI `"tool_calls"` → Anthropic-style `"tool_use"`.

### Streaming

Uses `openai` SDK streaming with `stream: true`. Tool call arguments arrive as partial JSON fragments across chunks — the adapter concatenates them before parsing.

## Section 3: Multi-Endpoint Ollama Discovery

### Multiple Provider Entries

Each Ollama endpoint becomes its own provider key:

```typescript
providers: {
  'ollama':           { provider: 'ollama', baseURL: 'http://localhost:11434/v1' },
  'ollama@sherlock':  { provider: 'ollama', baseURL: 'http://192.168.4.94:11434/v1' },
  'ollama@mycroft':   { provider: 'ollama', baseURL: 'http://192.168.4.x:11434/v1' },
}
```

### Model ID Namespacing

```typescript
{ id: 'ollama:mistral',        modelName: 'mistral', provider: 'ollama' }
{ id: 'ollama@sherlock:qwen',  modelName: 'qwen',    provider: 'ollama@sherlock' }
```

### Discovery Function

New `discoverOllamaModels(baseURL)` in `model-config.ts`:

1. `GET http://<host>:11434/api/tags` → list of models
2. For each model, `GET /api/show` → context_length
3. Returns `ModelDefinition[]` with provider set to the endpoint key

### Configuration

```
OLLAMA_ENDPOINTS=localhost:11434,192.168.4.94:11434,mycroft:11434
```

Discovery runs at startup in `loadModelConfig()`. Unreachable endpoints are skipped with a warning.

### Installer Flow

1. Ping `localhost:11434/api/tags`
2. If found: "Found Ollama on this machine with N models. Add more Ollama instances?"
3. User enters additional `host:port` entries
4. Each endpoint pinged, models listed
5. Stored as `OLLAMA_ENDPOINTS`

## Section 4: Enhanced Routing & Cooldowns

### Failure Classification

```typescript
type FailureType = 'rate_limit' | 'auth' | 'timeout' | 'server_error' | 'unknown';

function classifyError(err: Error): FailureType {
  // HTTP 429 or "rate limit" → rate_limit
  // HTTP 401/403 → auth
  // ETIMEDOUT, ECONNABORTED → timeout
  // HTTP 500/502/503 → server_error
  // else → unknown
}
```

### Cooldown Durations

| Failure Type | Default Cooldown | Behavior |
|-------------|-----------------|----------|
| `rate_limit` | 60s | Wait, then retry |
| `timeout` | 30s | Wait, then retry |
| `server_error` | 30s | Wait, then retry |
| `auth` | Permanent | Skip until key updated |
| `unknown` | 30s | Existing circuit breaker behavior |

The circuit breaker's `resetTimeoutMs` is set dynamically based on the last failure type. Auth failures keep the breaker open and log an actionable error.

### Fallback Strategy

New optional field on `ModelRouterConfig`:

```typescript
fallbackStrategy?: 'configured' | 'cheapest-first';
```

- `configured` (default): use fallback chain order as-is
- `cheapest-first`: sort fallback candidates by `costPer1MInput` ascending

No load balancing or latency tracking.

## Section 5: Session-Level Model Override

### Brain Conversation Metadata

```typescript
// Per-conversation state
modelOverride?: string;  // e.g. "gpt-4o" or "ollama:mistral"
```

When set, every `modelRouter.chat()` call passes it as `params.modelOverride`.

### API Endpoints

```
PATCH /conversations/:id/model
Body: { "model": "gpt-4o" }     // set
Body: { "model": null }          // clear

GET /models
Response: { models: ModelDefinition[], roles: ModelRoles, currentDefault: string }
```

### UI

Dropdown in chat header showing current model. Lists all configured models grouped by provider. Selecting calls PATCH endpoint. (UI implementation is BAK-16 territory — we build the API surface here.)

## Section 6: Installer Changes

### New Phase

```
Preflight → Secrets → Providers → Features → Confirm → Pull → Deploy → Health → Complete
```

`Phase::Providers` inserted after Secrets. Total phases: 9.

### Providers Phase TUI

```
┌─────────────────────────────────────────┐
│  Configure Providers                     │
│                                          │
│  [x] Anthropic (Claude)    ← always on  │
│  [ ] OpenAI (GPT-4o, o3)               │
│  [ ] Ollama (local models)              │
│                                          │
│  Space to toggle, Enter to continue      │
└─────────────────────────────────────────┘
```

- OpenAI toggled → prompt for `OPENAI_API_KEY`
- Ollama toggled → auto-discover localhost, prompt for additional endpoints

### Model Role Assignment

After provider selection, show available models from enabled providers:

```
┌─────────────────────────────────────────┐
│  Default Agent Model                     │
│                                          │
│  [1] claude-sonnet-4  (Anthropic)       │
│  [2] claude-opus-4    (Anthropic)       │
│  [3] gpt-4o           (OpenAI)          │
│  [4] mistral           (ollama)         │
│                                          │
│  Select [1-4]:                           │
└─────────────────────────────────────────┘
```

Similar prompt for observer model (defaults to cheapest available).

### K8s Secrets

Provider keys go into existing scoped secrets:
- `bakerst-brain-secrets` — `OPENAI_API_KEY`, `OLLAMA_ENDPOINTS`
- `bakerst-worker-secrets` — same

### release-manifest.json

```json
{ "key": "OPENAI_API_KEY", "required": false, "inputType": "secret",
  "targetSecrets": ["bakerst-brain-secrets", "bakerst-worker-secrets"] },
{ "key": "OLLAMA_ENDPOINTS", "required": false, "inputType": "text",
  "targetSecrets": ["bakerst-brain-secrets", "bakerst-worker-secrets"] }
```

## Section 7: Testing Strategy

### Unit Tests (`packages/shared`)

**model-router.test.ts:**
- OpenAI adapter: chat, streaming, tool call translation (both directions)
- Tool result message conversion
- Streaming tool call fragment assembly
- `classifyError` returns correct `FailureType`
- Auth failure locks provider permanently
- Rate limit sets 60s cooldown
- `cheapest-first` fallback sorts correctly
- Multi-endpoint Ollama: each endpoint gets its own adapter

**model-config.test.ts:**
- `OPENAI_API_KEY` env var creates openai provider
- `OLLAMA_ENDPOINTS` parsed into multiple provider entries
- Unknown `DEFAULT_MODEL` with openai provider guesses `openai`
- `discoverOllamaModels` returns models on success, empty on failure

### Installer Tests (`tools/installer`)

- Config file with `openai_api_key` and `ollama_endpoints` parsed correctly
- Non-interactive mode reads env vars
- Phase ordering: Providers after Secrets

### No Live API Tests

All adapter tests use mocked SDK responses. Live testing is manual.

## What Does NOT Change

- `ProviderAdapter` interface
- `ChatParams`, `ChatResponse`, `ModelStreamEvent` types
- Brain service code (agent.ts, observer.ts, reflector.ts) — still calls `modelRouter.chat()`
- Worker service code — still calls `modelRouter.chat()`
- NATS messaging
- Extension system
- Existing Anthropic and OpenRouter adapters
