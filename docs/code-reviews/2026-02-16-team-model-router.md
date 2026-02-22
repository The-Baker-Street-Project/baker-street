# Code Review: Model Router Implementation

| Field         | Value                                    |
|---------------|------------------------------------------|
| **Review ID** | `6c1be4f3`                               |
| **Date**      | 2026-02-16                               |
| **Scope**     | team: model-router                       |
| **Mode**      | full                                     |
| **Verdict**   | **WARN**                                 |
| **Reviewed by** | Claude Opus 4.6 (automated)           |

## Summary

| Severity | Count |
|----------|-------|
| Blocker  | 0     |
| High     | 3     |
| Medium   | 6     |
| Low      | 2     |
| Info     | 1     |

---

## Findings

### HIGH-1: Duplicated model-router.ts and model-config.ts across brain and worker

- **ID**: `api-patterns-3eecd910-1:461` / `api-patterns-620470a7-1:424`
- **Domain**: api-patterns
- **Severity**: High
- **Confidence**: 0.92
- **Files**: `services/brain/src/model-router.ts`, `services/worker/src/model-router.ts`, `services/brain/src/model-config.ts`, `services/worker/src/model-config.ts`
- **Line Range**: entire files

The `model-router.ts` and `model-config.ts` files are nearly identical copies between `services/brain/src/` and `services/worker/src/`. The worker version differs only in file-level comments. This violates the DRY principle and the project's existing pattern of placing shared code in `packages/shared`. When a bug is found or a provider adapter needs updating, both copies must be modified in lockstep, which is error-prone.

**Recommendation**: Move `ModelRouter` and `loadModelConfig` into `packages/shared` (e.g., `packages/shared/src/model-router.ts` and `packages/shared/src/model-config.ts`). Both brain and worker would then import from `@bakerst/shared`. The `openai` dependency would need to move to `packages/shared/package.json` as well. If the worker truly needs a subset (no streaming), consider a slim wrapper or just export the full class and let the worker ignore `chatStream`.

---

### HIGH-2: Unused `Anthropic` import in agent.ts

- **ID**: `typescript-quality-e60a19c1-3:3`
- **Domain**: typescript-quality
- **Severity**: High
- **Confidence**: 0.95
- **File**: `services/brain/src/agent.ts`
- **Line Range**: 3

```typescript
import Anthropic from '@anthropic-ai/sdk';
```

The refactoring removed all direct usage of the Anthropic client from `agent.ts`, but the default import on line 3 was left behind. This is a dead import that inflates the bundle and causes confusion about whether the agent still directly depends on the Anthropic SDK.

**Recommendation**: Remove line 3 (`import Anthropic from '@anthropic-ai/sdk';`). The agent now communicates exclusively through the `ModelRouter` abstraction, which is correct.

---

### HIGH-3: Unsafe `JSON.parse` with unchecked `as` assertion on config file loading

- **ID**: `security-f894da9c-90:93`
- **Domain**: security (input validation), also api-patterns
- **Severity**: High
- **Confidence**: 0.88
- **Files**: `services/brain/src/model-config.ts` (lines 90-93), `services/worker/src/model-config.ts` (lines 87-91)
- **Line Range**: 90-93

```typescript
async function loadConfigFromFile(path: string): Promise<ModelRouterConfig> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as ModelRouterConfig;
  return parsed;
}
```

The file-based config loader uses `JSON.parse` and blindly casts the result to `ModelRouterConfig` via `as`. If the config file is malformed (missing `providers`, `models`, or `roles` keys, wrong types, extra fields), it will be accepted without structural validation. The downstream `validateConfig()` checks only referential integrity (roles pointing to known model IDs, etc.) but does not validate that `providers` is an object, that `models` is an array, or that each `ModelDefinition` has the required fields.

**Recommendation**: Add runtime schema validation after `JSON.parse`. Options include: (a) a hand-written guard function that checks `typeof parsed.providers === 'object'`, `Array.isArray(parsed.models)`, etc., or (b) a lightweight schema validator like Zod. This is especially important since the config path comes from an environment variable (`MODEL_ROUTER_CONFIG_PATH`) and the file contents are not trusted.

---

### MEDIUM-1: Unused type imports in model-router.ts (both copies)

- **ID**: `typescript-quality-3eecd910-27:27`
- **Domain**: typescript-quality
- **Severity**: Medium
- **Confidence**: 0.90
- **Files**: `services/brain/src/model-router.ts` (line 27), `services/worker/src/model-router.ts` (line 20)
- **Line Range**: 27, 20

```typescript
type ModelRoles,
```

`ModelRoles` is imported but never referenced in the body of either `model-router.ts` file. It is only used inside `model-config.ts` and `model-types.ts`.

**Recommendation**: Remove the `ModelRoles` import from both `model-router.ts` files.

---

### MEDIUM-2: Unused `ProviderConfig` import in brain model-router.ts

- **ID**: `typescript-quality-3eecd910-18:18`
- **Domain**: typescript-quality
- **Severity**: Medium
- **Confidence**: 0.88
- **Files**: `services/brain/src/model-router.ts` (line 18)
- **Line Range**: 18

```typescript
type ProviderConfig,
```

`ProviderConfig` (the union type) is imported on line 18 but never used. The code only uses the specific provider config types (`AnthropicProviderConfig`, `OpenRouterProviderConfig`, etc.).

**Recommendation**: Remove the unused `ProviderConfig` import. This also applies to the worker copy if consolidated.

---

### MEDIUM-3: Numerous `as` type assertions bridging provider-agnostic and Anthropic SDK types

- **ID**: `typescript-quality-3eecd910-81:103`
- **Domain**: typescript-quality
- **Severity**: Medium
- **Confidence**: 0.78
- **Files**: `services/brain/src/model-router.ts` (lines 81-83, 101-103, 152-154, 172-174), `services/worker/src/model-router.ts` (same pattern)
- **Line Range**: 81-174

```typescript
system: params.system as Anthropic.Messages.TextBlockParam[] | undefined,
tools: params.tools as Anthropic.Messages.Tool[] | undefined,
messages: params.messages as Anthropic.Messages.MessageParam[],
```

The Anthropic adapter casts the provider-agnostic `ChatParams` fields to Anthropic SDK types using `as`. This is repeated 4 times per file (8 total across both copies). While understandable for an adapter layer, these assertions silence type-checking and could mask runtime mismatches if the provider-agnostic types drift from the Anthropic SDK types (e.g., if Anthropic adds required fields).

**Recommendation**: Consider creating thin mapping functions like `toAnthropicMessages(params.messages)` that do explicit field mapping rather than type assertions. This makes the boundary explicit and would fail at compile time if the Anthropic SDK types change.

---

### MEDIUM-4: `lastError` can be `undefined` when thrown in fallback chain

- **ID**: `api-patterns-3eecd910-435:450`
- **Domain**: api-patterns
- **Severity**: Medium
- **Confidence**: 0.82
- **Files**: `services/brain/src/model-router.ts` (lines 435-450), `services/worker/src/model-router.ts` (lines 400-415)
- **Line Range**: 435-450

```typescript
let lastError: unknown;
for (const m of modelsToTry) {
  try {
    // ...
    return await adapter.chat(m, params);
  } catch (err) {
    lastError = err;
    // ...
  }
}

throw lastError;
```

If `modelsToTry` is empty (theoretically impossible given `resolveModel` always returns at least one, but defensively), `lastError` remains `undefined` and `throw undefined` would be thrown. TypeScript allows this but it makes the thrown value untyped and the stack trace unhelpful.

**Recommendation**: Initialize `lastError` to a descriptive `Error` (e.g., `new Error('model-router: no models available to try')`) or add a post-loop guard: `throw lastError ?? new Error('model-router: all models in fallback chain failed');`.

---

### MEDIUM-5: `guessProvider` fallback logic could silently pick the wrong provider

- **ID**: `api-patterns-f894da9c-157:165`
- **Domain**: api-patterns
- **Severity**: Medium
- **Confidence**: 0.80
- **Files**: `services/brain/src/model-config.ts` (lines 157-165), `services/worker/src/model-config.ts` (lines 149-157)
- **Line Range**: 157-165

```typescript
function guessProvider(modelName: string, config: ModelRouterConfig): ModelProvider {
  if (modelName.startsWith('claude')) return 'anthropic';
  if (config.providers['openrouter']) return 'openrouter';
  if (config.providers['ollama']) return 'ollama';
  return 'anthropic';
}
```

When `DEFAULT_MODEL` or `OBSERVER_MODEL` is set to a non-Claude model name, `guessProvider` falls through to whichever provider happens to be configured. If both `openrouter` and `ollama` are configured, it always picks `openrouter`. More importantly, the final fallback returns `'anthropic'` even if Anthropic is not configured, which would pass validation but fail at runtime when the adapter is requested.

**Recommendation**: Log a warning when the guess is ambiguous, or require an explicit provider prefix in the env var (e.g., `OPENROUTER:gpt-4o`). At minimum, validate that the guessed provider is actually configured before returning it.

---

### MEDIUM-6: `workerRole` type assertion uses `as const` to bypass type safety

- **ID**: `typescript-quality-6e6007c9-78:78`
- **Domain**: typescript-quality
- **Severity**: Medium
- **Confidence**: 0.80
- **File**: `services/worker/src/actions.ts`
- **Line Range**: 78

```typescript
const workerRole = modelRouter.routerConfig.roles.worker ? 'worker' as const : 'agent' as const;
```

The `as const` assertions here are working around the fact that `keyof ModelRoles` does not include `'worker'` as a guaranteed key (it is optional). The ternary checks if `roles.worker` is truthy, then passes `'worker'` as a role. However, `ChatParams.role` is typed as `keyof ModelRoles` which is `'agent' | 'observer' | 'worker'`. The `as const` is not needed for correctness but the code reads awkwardly and could be simplified.

**Recommendation**: Define `const workerRole: keyof ModelRoles = modelRouter.routerConfig.roles.worker ? 'worker' : 'agent';` which is cleaner and still type-safe.

---

### LOW-1: `openai` dependency added to brain and worker but only used by Ollama/OpenAI-compatible adapter

- **ID**: `api-patterns-c031e3d7-19:19`
- **Domain**: api-patterns
- **Severity**: Low
- **Confidence**: 0.85
- **Files**: `services/brain/package.json` (line 19), `services/worker/package.json` (line 14)
- **Line Range**: 19, 14

The `openai` SDK is added as a direct dependency in both `services/brain/package.json` and `services/worker/package.json`. However, the adapter uses a dynamic `import('openai')` so it is only loaded at runtime when an Ollama or OpenAI-compatible provider is configured. While having it as a direct dependency is correct for the lock file, it adds ~2MB to every Docker image even when only Anthropic is used.

**Recommendation**: This is acceptable for now. If image size becomes a concern, consider making it an optional peer dependency or moving it to the shared package (which also resolves HIGH-1).

---

### LOW-2: `content_block_start` event in `ModelStreamEvent` is never emitted

- **ID**: `typescript-quality-d4080697-169:169`
- **Domain**: typescript-quality
- **Severity**: Low
- **Confidence**: 0.85
- **File**: `packages/shared/src/model-types.ts`
- **Line Range**: 169

```typescript
| { type: 'content_block_start'; index: number; contentBlock: ChatContentBlock }
```

The `ModelStreamEvent` union includes a `content_block_start` variant, but none of the adapter implementations (`createAnthropicAdapter`, `createOpenRouterAdapter`, `createOpenAICompatibleAdapter`) ever yield this event type. Only `text_delta` and `message_done` are emitted.

**Recommendation**: Either implement emission of `content_block_start` events in the adapters (particularly for tool_use blocks during streaming) or remove this variant from the union to avoid dead code. If streaming tool use is planned for a future phase, add a comment indicating this.

---

### INFO-1: Config path from environment variable is not sanitized

- **ID**: `security-f894da9c-224:227`
- **Domain**: security
- **Severity**: Info
- **Confidence**: 0.70
- **Files**: `services/brain/src/model-config.ts` (lines 224-227), `services/worker/src/model-config.ts` (lines 204-207)
- **Line Range**: 224-227

```typescript
const configPath = process.env.MODEL_ROUTER_CONFIG_PATH;
if (configPath) {
  config = await loadConfigFromFile(configPath);
}
```

`MODEL_ROUTER_CONFIG_PATH` is read from the environment and used directly as a file path. In a Kubernetes environment, environment variables are controlled by the deployment manifest and are trusted. However, this is worth noting for defense-in-depth: there is no path traversal check or restriction to a specific directory.

**Recommendation**: Consider restricting the config path to a known base directory (e.g., must start with `/etc/bakerst/`). Low risk given the K8s deployment model but worth a comment documenting the trust boundary.

---

## Architecture Notes

The Model Router implementation successfully decouples model/provider selection from business logic. Key observations:

1. **Clean abstraction**: The `ChatParams` / `ChatResponse` / `ModelStreamEvent` types in `packages/shared/src/model-types.ts` provide a solid provider-agnostic interface.

2. **Good backward compatibility**: Default config exactly reproduces current hardcoded behavior (Sonnet 4 for agent, Haiku 4.5 for observer). No breaking changes to existing deployments.

3. **Fallback chain**: Non-streaming `chat()` supports a fallback chain. Streaming `chatStream()` intentionally does not, which is a reasonable tradeoff documented in the code.

4. **Config resolution order**: File -> defaults -> env overrides -> validation. This is a sensible layering.

5. **Critical duplication concern**: The most impactful issue is the copy-paste of `model-router.ts` and `model-config.ts` between brain and worker. Addressing HIGH-1 would eliminate ~700 lines of duplicated code and 4 of the 12 findings.
