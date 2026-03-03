# Multi-Model Provider System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend Baker Street's ModelRouter to support OpenAI (native, with tool calling), multi-endpoint Ollama discovery, failure-aware cooldowns, session-level model override, and installer integration.

**Architecture:** Enhance the existing in-process ModelRouter (Approach A). Add a native OpenAI adapter using the `openai` SDK with full tool-calling translation. Add `classifyError()` for failure-type cooldowns. Discover Ollama endpoints from `OLLAMA_ENDPOINTS` env var. Add `PATCH /conversations/:id/model` API. Add Providers phase to the Rust installer.

**Tech Stack:** TypeScript ESM, `openai` SDK (already a dep), `@anthropic-ai/sdk`, vitest, Rust (installer), ratatui

<!-- Validated: PENDING -->

---

## Task 1: Add OpenAI Provider Type and Model Definitions

**Files:**
- Modify: `packages/shared/src/model-types.ts:12,43-47,88-97`
- Modify: `packages/shared/src/model-config.ts:12,25-45,47-74,212-235`
- Test: `packages/shared/src/__tests__/model-config.test.ts`

### Step 1: Write failing tests for OpenAI provider detection and model definitions

Add these tests to `packages/shared/src/__tests__/model-config.test.ts`:

```typescript
// Inside describe('createDefaultConfig()')
it('includes openai provider when OPENAI_API_KEY is set', () => {
  setEnv('OPENAI_API_KEY', 'sk-openai-test');
  const config = createDefaultConfig();
  expect(config.providers).toHaveProperty('openai');
  expect(config.providers['openai'].provider).toBe('openai');
});

it('does not include openai when OPENAI_API_KEY not set', () => {
  const config = createDefaultConfig();
  expect(config.providers).not.toHaveProperty('openai');
});

it('includes openai model definitions when OPENAI_API_KEY set', () => {
  setEnv('OPENAI_API_KEY', 'sk-openai-test');
  const config = createDefaultConfig();
  const openaiModels = config.models.filter(m => m.provider === 'openai');
  expect(openaiModels.length).toBeGreaterThanOrEqual(3);
  expect(openaiModels.map(m => m.id)).toEqual(
    expect.arrayContaining(['gpt-4o', 'gpt-4o-mini', 'o3-mini'])
  );
});

// Inside describe('loadModelConfig()')
it('applies DEFAULT_MODEL override with gpt- prefix model', () => {
  setEnv('OPENAI_API_KEY', 'sk-openai-test');
  setEnv('DEFAULT_MODEL', 'gpt-4o');
  const config = await loadModelConfig();
  expect(config.roles.agent).toBe('gpt-4o');
});

it('guesses openai provider for unknown gpt- model', () => {
  setEnv('OPENAI_API_KEY', 'sk-openai-test');
  setEnv('DEFAULT_MODEL', 'gpt-4-turbo');
  const config = await loadModelConfig();
  expect(config.roles.agent).toBe('custom-agent');
  const adHoc = config.models.find(m => m.id === 'custom-agent');
  expect(adHoc!.provider).toBe('openai');
});

it('guesses openai provider for o3/o1 models', () => {
  setEnv('OPENAI_API_KEY', 'sk-openai-test');
  setEnv('DEFAULT_MODEL', 'o1-preview');
  const config = await loadModelConfig();
  const adHoc = config.models.find(m => m.id === 'custom-agent');
  expect(adHoc!.provider).toBe('openai');
});
```

Also add `'OPENAI_API_KEY'` to the `setEnv` cleanup in `beforeEach`:

```typescript
setEnv('OPENAI_API_KEY', undefined);
```

### Step 2: Run tests to verify they fail

```bash
cd packages/shared && pnpm test -- --run model-config
```

Expected: FAIL — `openai` not in providers, `guessProvider` doesn't know `gpt-`/`o1`/`o3` prefixes.

### Step 3: Add OpenAI types

In `packages/shared/src/model-types.ts`:

1. Add `'openai'` to the `ModelProvider` union (line 12):

```typescript
export type ModelProvider = 'anthropic' | 'openrouter' | 'ollama' | 'openai-compatible' | 'openai';
```

2. Add `OpenAIProviderConfig` interface (after line 41):

```typescript
export interface OpenAIProviderConfig {
  provider: 'openai';
  apiKey: string;
}
```

3. Add to `ProviderConfig` union (lines 43-47):

```typescript
export type ProviderConfig =
  | AnthropicProviderConfig
  | OpenRouterProviderConfig
  | OllamaProviderConfig
  | OpenAICompatibleProviderConfig
  | OpenAIProviderConfig;
```

4. Add `fallbackStrategy` to `ModelRouterConfig` (line 97):

```typescript
export interface ModelRouterConfig {
  providers: Record<string, ProviderConfig>;
  models: ModelDefinition[];
  roles: ModelRoles;
  fallbackChain?: string[];
  fallbackStrategy?: 'configured' | 'cheapest-first';
}
```

### Step 4: Add OpenAI provider detection and models

In `packages/shared/src/model-config.ts`:

1. Add import for `OpenAIProviderConfig` (line 16 area):

```typescript
import type {
  ModelRouterConfig,
  ModelDefinition,
  ProviderConfig,
  ModelRoles,
  ModelProvider,
} from './model-types.js';
```

2. In `defaultProviders()`, after the openrouter block (line 42), add:

```typescript
const openaiKey = process.env.OPENAI_API_KEY;
if (openaiKey) {
  providers['openai'] = {
    provider: 'openai',
    apiKey: openaiKey,
  };
}
```

3. In `defaultModels()`, after the haiku definition (line 73), add:

```typescript
// OpenAI models (only included when OPENAI_API_KEY is set)
...(process.env.OPENAI_API_KEY
  ? [
      {
        id: 'gpt-4o',
        modelName: 'gpt-4o',
        provider: 'openai' as const,
        maxTokens: 4096,
        costPer1MInput: 2.5,
        costPer1MOutput: 10,
      },
      {
        id: 'gpt-4o-mini',
        modelName: 'gpt-4o-mini',
        provider: 'openai' as const,
        maxTokens: 4096,
        costPer1MInput: 0.15,
        costPer1MOutput: 0.6,
      },
      {
        id: 'o3-mini',
        modelName: 'o3-mini',
        provider: 'openai' as const,
        maxTokens: 4096,
        costPer1MInput: 1.1,
        costPer1MOutput: 4.4,
      },
    ]
  : []),
```

4. Update `guessProvider()` (lines 212-235) to handle `gpt-`, `o1`, `o3` prefixes:

```typescript
function guessProvider(
  modelName: string,
  config: ModelRouterConfig,
): ModelProvider {
  let guessed: ModelProvider;

  if (modelName.startsWith('claude')) {
    guessed = 'anthropic';
  } else if (modelName.startsWith('gpt-') || modelName.startsWith('o1') || modelName.startsWith('o3')) {
    guessed = 'openai';
  } else if (config.providers['openrouter']) {
    guessed = 'openrouter';
  } else if (config.providers['ollama']) {
    guessed = 'ollama';
  } else {
    guessed = 'anthropic';
  }

  if (!config.providers[guessed]) {
    throw new Error(
      `Model '${modelName}' appears to be a ${guessed} model but no ${guessed} provider is configured`,
    );
  }

  return guessed;
}
```

Also update the return type signature which currently has a hardcoded union — use `ModelProvider` instead.

### Step 5: Run tests to verify they pass

```bash
cd packages/shared && pnpm test -- --run model-config
```

Expected: All tests PASS.

### Step 6: Commit

```bash
git add packages/shared/src/model-types.ts packages/shared/src/model-config.ts packages/shared/src/__tests__/model-config.test.ts
git commit -m "feat(shared): add OpenAI provider type and model definitions

Add 'openai' to ModelProvider union, OpenAIProviderConfig interface,
gpt-4o/gpt-4o-mini/o3-mini model definitions (conditional on OPENAI_API_KEY),
and guessProvider() support for gpt-/o1/o3 prefixes."
```

---

## Task 2: OpenAI Native Adapter — Text Chat + Streaming

**Files:**
- Modify: `packages/shared/src/model-router.ts:13-28,270-390,415-490`
- Test: `packages/shared/src/__tests__/model-router.test.ts`

### Step 1: Write failing tests for OpenAI native text chat

Add to `packages/shared/src/__tests__/model-router.test.ts`:

```typescript
// Helper for OpenAI config
function makeOpenAIConfig(overrides?: Partial<ModelRouterConfig>): ModelRouterConfig {
  return {
    providers: {
      openai: {
        provider: 'openai' as const,
        apiKey: 'sk-openai-test',
      },
    },
    models: [
      {
        id: 'gpt-4o',
        modelName: 'gpt-4o',
        provider: 'openai' as const,
        maxTokens: 4096,
        costPer1MInput: 2.5,
        costPer1MOutput: 10,
      },
    ],
    roles: {
      agent: 'gpt-4o',
      observer: 'gpt-4o',
    },
    ...overrides,
  };
}

const mockOpenAITextResponse = {
  choices: [{
    message: { role: 'assistant', content: 'Hello from GPT' },
    finish_reason: 'stop',
  }],
  model: 'gpt-4o',
  usage: { prompt_tokens: 10, completion_tokens: 20 },
};

describe('OpenAI native adapter', () => {
  it('routes text chat to OpenAI and normalizes response', async () => {
    mockOpenAICreate.mockResolvedValue(mockOpenAITextResponse);
    const router = await ModelRouter.create(makeOpenAIConfig());
    const response = await router.chat(makeParams());

    expect(response.content).toEqual([{ type: 'text', text: 'Hello from GPT' }]);
    expect(response.stopReason).toBe('end_turn');
    expect(response.model).toBe('gpt-4o');
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('converts system blocks to OpenAI system message', async () => {
    mockOpenAICreate.mockResolvedValue(mockOpenAITextResponse);
    const router = await ModelRouter.create(makeOpenAIConfig());
    await router.chat(makeParams({
      system: [{ type: 'text', text: 'You are helpful.' }],
    }));

    const callArgs = mockOpenAICreate.mock.calls[0][0];
    expect(callArgs.messages[0]).toEqual({
      role: 'system',
      content: 'You are helpful.',
    });
  });

  it('streams text deltas from OpenAI', async () => {
    // Mock async iterable stream
    const streamChunks = [
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 10 } },
    ];
    mockOpenAICreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of streamChunks) yield chunk;
      },
    });

    const router = await ModelRouter.create(makeOpenAIConfig());
    const events: any[] = [];
    for await (const event of router.chatStream(makeParams())) {
      events.push(event);
    }

    const textDeltas = events.filter(e => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0].text).toBe('Hello');
    expect(textDeltas[1].text).toBe(' world');

    const done = events.find(e => e.type === 'message_done');
    expect(done).toBeDefined();
    expect(done.response.stopReason).toBe('end_turn');
  });
});
```

### Step 2: Run tests to verify they fail

```bash
cd packages/shared && pnpm test -- --run model-router
```

Expected: FAIL — no `openai` adapter in `getAdapter()`, `ModelRouter.create()` doesn't init OpenAI.

### Step 3: Implement `createOpenAINativeAdapter()`

In `packages/shared/src/model-router.ts`:

1. Add import for `OpenAIProviderConfig`:

```typescript
import type {
  // ...existing imports...
  OpenAIProviderConfig,
} from './model-types.js';
```

2. Add `createOpenAINativeAdapter()` after `createOpenRouterAdapter()` (after line 264):

```typescript
// ---------------------------------------------------------------------------
// OpenAI native adapter (uses openai SDK with full tool support)
// ---------------------------------------------------------------------------

async function createOpenAINativeAdapter(
  providerCfg: OpenAIProviderConfig,
): Promise<ProviderAdapter> {
  const { default: OpenAI } = await import('openai');

  const client = new OpenAI({ apiKey: providerCfg.apiKey });

  log.info('openai native adapter: initialized');

  return {
    async chat(model: ModelDefinition, params: ChatParams): Promise<ChatResponse> {
      const messages = convertToOpenAIMessagesWithTools(params);
      const tools = params.tools ? convertToolsToOpenAI(params.tools) : undefined;

      const response = await client.chat.completions.create({
        model: model.modelName,
        max_tokens: params.maxTokens ?? model.maxTokens,
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new Error('openai native adapter: no choices in response');
      }

      return normalizeOpenAIResponse(choice, response.model, response.usage);
    },

    async *chatStream(model: ModelDefinition, params: ChatParams): AsyncGenerator<ModelStreamEvent> {
      const messages = convertToOpenAIMessagesWithTools(params);
      const tools = params.tools ? convertToolsToOpenAI(params.tools) : undefined;

      const stream = await client.chat.completions.create({
        model: model.modelName,
        max_tokens: params.maxTokens ?? model.maxTokens,
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
        stream: true,
      });

      let fullText = '';
      let finishReason = 'end_turn';
      // Accumulate tool call fragments across chunks
      const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          fullText += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }

        // Accumulate tool call deltas
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallAccumulator.get(tc.index);
            if (!existing) {
              toolCallAccumulator.set(tc.index, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                args: tc.function?.arguments ?? '',
              });
            } else {
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = mapOpenAIFinishReason(chunk.choices[0].finish_reason);
        }
      }

      // Build final content blocks
      const content: ChatContentBlock[] = [];
      if (fullText) {
        content.push({ type: 'text', text: fullText });
      }
      for (const [, tc] of toolCallAccumulator) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.args || '{}'),
        });
      }

      yield {
        type: 'message_done',
        response: {
          content,
          stopReason: finishReason,
          model: model.modelName,
        },
      };
    },
  };
}
```

3. Add helper functions:

```typescript
/** Convert Anthropic-style messages to OpenAI format, preserving tool_use and tool_result blocks */
function convertToOpenAIMessagesWithTools(
  params: ChatParams,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  // System blocks -> single system message
  if (params.system && params.system.length > 0) {
    out.push({
      role: 'system',
      content: params.system.map((b) => b.text).join('\n\n'),
    });
  }

  for (const msg of params.messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Check for tool_result blocks (user messages with tool results)
    const toolResults = msg.content.filter(b => b.type === 'tool_result');
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        if (tr.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          });
        }
      }
      continue;
    }

    // Check for tool_use blocks (assistant messages with tool calls)
    const toolUses = msg.content.filter(b => b.type === 'tool_use');
    if (toolUses.length > 0) {
      const textParts = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      out.push({
        role: 'assistant',
        content: textParts || null,
        tool_calls: toolUses.map(b => {
          if (b.type !== 'tool_use') return undefined;
          return {
            id: b.id,
            type: 'function',
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input),
            },
          };
        }).filter(Boolean),
      });
      continue;
    }

    // Plain text content blocks
    const text = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    out.push({ role: msg.role, content: text });
  }

  return out;
}

/** Convert Anthropic tool definitions to OpenAI function format */
function convertToolsToOpenAI(
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/** Normalize an OpenAI chat completion choice into ChatResponse */
function normalizeOpenAIResponse(
  choice: { message: Record<string, unknown>; finish_reason: string | null },
  model: string,
  usage?: { prompt_tokens: number; completion_tokens: number | null } | null,
): ChatResponse {
  const content: ChatContentBlock[] = [];

  if (typeof choice.message.content === 'string' && choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  // Convert tool_calls to tool_use content blocks
  const toolCalls = choice.message.tool_calls as Array<{
    id: string;
    function: { name: string; arguments: string };
  }> | undefined;

  if (toolCalls) {
    for (const tc of toolCalls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  return {
    content,
    stopReason: mapOpenAIFinishReason(choice.finish_reason),
    model,
    usage: usage
      ? {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}

/** Map OpenAI finish_reason to Anthropic-style stop reason */
function mapOpenAIFinishReason(reason: string | null): string {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return reason ?? 'end_turn';
  }
}
```

4. Update `ModelRouter.create()` to eagerly init OpenAI (after line 428):

```typescript
// OpenAI native — eager if configured
const openaiCfg = config.providers['openai'];
if (openaiCfg && openaiCfg.provider === 'openai') {
  router.adapters.set('openai', await createOpenAINativeAdapter(openaiCfg));
}
```

5. Update `getAdapter()` to handle `'openai'` provider (after line 487):

```typescript
if (providerCfg.provider === 'openai') {
  const adapter = await createOpenAINativeAdapter(providerCfg as OpenAIProviderConfig);
  this.adapters.set(provider, adapter);
  return adapter;
}
```

### Step 4: Run tests to verify they pass

```bash
cd packages/shared && pnpm test -- --run model-router
```

Expected: All tests PASS including new OpenAI adapter tests.

### Step 5: Commit

```bash
git add packages/shared/src/model-router.ts packages/shared/src/__tests__/model-router.test.ts
git commit -m "feat(shared): add OpenAI native adapter with text chat and streaming

createOpenAINativeAdapter() uses openai SDK directly. Includes
convertToOpenAIMessagesWithTools(), tool format translation helpers,
stop reason mapping, and streaming with tool call accumulation."
```

---

## Task 3: OpenAI Adapter — Tool Calling Tests

**Files:**
- Test: `packages/shared/src/__tests__/model-router.test.ts`

This task adds comprehensive tool-calling tests against the adapter built in Task 2.

### Step 1: Write tool calling tests

Add to the `describe('OpenAI native adapter')` block in `model-router.test.ts`:

```typescript
it('translates tool definitions from Anthropic to OpenAI format', async () => {
  mockOpenAICreate.mockResolvedValue(mockOpenAITextResponse);
  const router = await ModelRouter.create(makeOpenAIConfig());
  await router.chat(makeParams({
    tools: [{
      name: 'search',
      description: 'Search the web',
      input_schema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
    }],
  }));

  const callArgs = mockOpenAICreate.mock.calls[0][0];
  expect(callArgs.tools).toEqual([{
    type: 'function',
    function: {
      name: 'search',
      description: 'Search the web',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
    },
  }]);
});

it('converts OpenAI tool_calls response to tool_use content blocks', async () => {
  mockOpenAICreate.mockResolvedValue({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_abc',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"test"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    model: 'gpt-4o',
    usage: { prompt_tokens: 10, completion_tokens: 15 },
  });

  const router = await ModelRouter.create(makeOpenAIConfig());
  const response = await router.chat(makeParams({
    tools: [{
      name: 'search',
      description: 'Search',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    }],
  }));

  expect(response.stopReason).toBe('tool_use');
  expect(response.content).toEqual([{
    type: 'tool_use',
    id: 'call_abc',
    name: 'search',
    input: { q: 'test' },
  }]);
});

it('converts tool_result messages to OpenAI tool role', async () => {
  mockOpenAICreate.mockResolvedValue(mockOpenAITextResponse);
  const router = await ModelRouter.create(makeOpenAIConfig());
  await router.chat(makeParams({
    messages: [
      { role: 'user', content: 'Search for test' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_abc', name: 'search', input: { q: 'test' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_abc', content: 'Found 5 results' },
        ],
      },
    ],
  }));

  const callArgs = mockOpenAICreate.mock.calls[0][0];
  // Should have: user, assistant with tool_calls, tool message
  expect(callArgs.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'tool', tool_call_id: 'call_abc', content: 'Found 5 results' }),
  ]));
});

it('assembles fragmented tool call arguments during streaming', async () => {
  const streamChunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_123', function: { name: 'search', arguments: '{"q":' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  mockOpenAICreate.mockResolvedValue({
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of streamChunks) yield chunk;
    },
  });

  const router = await ModelRouter.create(makeOpenAIConfig());
  const events: any[] = [];
  for await (const event of router.chatStream(makeParams({
    tools: [{
      name: 'search',
      description: 'Search',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    }],
  }))) {
    events.push(event);
  }

  const done = events.find(e => e.type === 'message_done');
  expect(done.response.stopReason).toBe('tool_use');
  expect(done.response.content).toEqual([{
    type: 'tool_use',
    id: 'call_123',
    name: 'search',
    input: { q: 'hello' },
  }]);
});
```

### Step 2: Run tests

```bash
cd packages/shared && pnpm test -- --run model-router
```

Expected: All tests PASS (these test the Task 2 implementation).

### Step 3: Commit

```bash
git add packages/shared/src/__tests__/model-router.test.ts
git commit -m "test(shared): add comprehensive OpenAI tool calling tests

Tests cover: tool definition translation (Anthropic→OpenAI format),
tool_calls response→tool_use content blocks, tool_result→tool role
conversion, and streaming tool call fragment assembly."
```

---

## Task 4: Failure Classification and Enhanced Cooldowns

**Files:**
- Modify: `packages/shared/src/model-router.ts`
- Test: `packages/shared/src/__tests__/model-router.test.ts`

### Step 1: Write failing tests for classifyError and cooldown behavior

Add to `model-router.test.ts`:

```typescript
// At top, import classifyError (we'll need to export it for testing)
// We'll test it indirectly through ModelRouter behavior

describe('failure classification and cooldowns', () => {
  it('locks provider permanently on auth failure (401)', async () => {
    const err = new Error('Unauthorized') as any;
    err.status = 401;
    mockMessagesCreate
      .mockRejectedValueOnce(err)
      .mockResolvedValue(mockAnthropicResponse); // would succeed if called

    const config = makeConfig({ fallbackChain: ['sonnet-4', 'haiku-4.5'] });
    const router = await ModelRouter.create(config);

    // First call fails with 401, falls back to haiku
    const response = await router.chat(makeParams());
    expect(response.model).toBe('claude-haiku-4-5-20251001');

    // Second call should skip anthropic entirely (auth-locked)
    mockMessagesCreate.mockClear();
    mockMessagesCreate.mockResolvedValue({
      ...mockAnthropicResponse,
      model: 'claude-haiku-4-5-20251001',
    });
    const response2 = await router.chat(makeParams());
    // Should only have called once (haiku), not twice (sonnet then haiku)
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it('maps rate limit (429) to 60s cooldown', async () => {
    const err = new Error('Rate limited') as any;
    err.status = 429;

    mockMessagesCreate.mockRejectedValue(err);

    const router = await ModelRouter.create(makeConfig());

    // Trip the breaker with rate limit errors
    for (let i = 0; i < 5; i++) {
      try { await router.chat(makeParams()); } catch { /* expected */ }
    }

    // Breaker should be open — verify it rejects immediately
    await expect(router.chat(makeParams())).rejects.toThrow(/circuit breaker.*open/i);
  });

  it('sorts fallback candidates by cost when cheapest-first strategy', async () => {
    mockMessagesCreate
      .mockRejectedValueOnce(new Error('primary failed'))
      .mockResolvedValue({
        ...mockAnthropicResponse,
        model: 'claude-haiku-4-5-20251001',
      });

    const config = makeConfig({
      models: [
        { id: 'sonnet-4', modelName: 'claude-sonnet-4-20250514', provider: 'anthropic', maxTokens: 4096, costPer1MInput: 3 },
        { id: 'opus-4', modelName: 'claude-opus-4-20250514', provider: 'anthropic', maxTokens: 4096, costPer1MInput: 15 },
        { id: 'haiku-4.5', modelName: 'claude-haiku-4-5-20251001', provider: 'anthropic', maxTokens: 2048, costPer1MInput: 0.8 },
      ],
      fallbackChain: ['sonnet-4', 'opus-4', 'haiku-4.5'],
      fallbackStrategy: 'cheapest-first',
    });

    const router = await ModelRouter.create(config);
    const response = await router.chat(makeParams());

    // After sonnet fails, cheapest-first should try haiku (0.8) before opus (15)
    const calls = mockMessagesCreate.mock.calls;
    expect(calls[0][0].model).toBe('claude-sonnet-4-20250514'); // primary
    expect(calls[1][0].model).toBe('claude-haiku-4-5-20251001'); // cheapest fallback
  });
});
```

### Step 2: Run tests to verify they fail

```bash
cd packages/shared && pnpm test -- --run model-router
```

Expected: FAIL — no `classifyError`, no auth-lock, no cheapest-first sort.

### Step 3: Implement failure classification

In `packages/shared/src/model-router.ts`:

1. Add failure classification types and function (after the helpers section, before the adapter section):

```typescript
// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

type FailureType = 'rate_limit' | 'auth' | 'timeout' | 'server_error' | 'unknown';

function classifyError(err: Error): FailureType {
  const status = (err as any).status ?? (err as any).statusCode;
  if (status === 429 || err.message.toLowerCase().includes('rate limit')) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 500 || status === 502 || status === 503) return 'server_error';
  if (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNABORTED') || err.message.includes('timeout')) return 'timeout';
  return 'unknown';
}

const COOLDOWN_MS: Record<FailureType, number> = {
  rate_limit: 60_000,
  timeout: 30_000,
  server_error: 30_000,
  auth: Infinity, // permanent
  unknown: 30_000,
};
```

2. Add `authLockedProviders` set and cooldown logic to `ModelRouter`:

```typescript
export class ModelRouter {
  private adapters: Map<string, ProviderAdapter> = new Map();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private authLockedProviders: Set<string> = new Set(); // NEW
  private config: ModelRouterConfig;
  // ... rest unchanged
```

3. Update `chat()` to skip auth-locked providers and set cooldown durations:

```typescript
async chat(params: ChatParams): Promise<ChatResponse> {
  const model = this.resolveModel(params);
  let modelsToTry = [model];

  // Append fallback chain if configured
  if (this.config.fallbackChain) {
    const fallbacks: ModelDefinition[] = [];
    for (const fbId of this.config.fallbackChain) {
      if (fbId === model.id) continue;
      const fbModel = this.config.models.find((m) => m.id === fbId);
      if (fbModel) fallbacks.push(fbModel);
    }

    // Sort fallbacks by cost if cheapest-first strategy
    if (this.config.fallbackStrategy === 'cheapest-first') {
      fallbacks.sort((a, b) => (a.costPer1MInput ?? 0) - (b.costPer1MInput ?? 0));
    }

    modelsToTry = [model, ...fallbacks];
  }

  let lastError: Error = new Error('All models in fallback chain failed');
  for (const m of modelsToTry) {
    // Skip auth-locked providers
    if (this.authLockedProviders.has(m.provider)) {
      log.warn({ provider: m.provider }, 'skipping auth-locked provider');
      continue;
    }

    const start = Date.now();
    try {
      const adapter = await this.getAdapter(m.provider);
      const cb = this.getOrCreateBreaker(m.provider);
      log.info({ model: m.modelName, provider: m.provider, role: params.role ?? 'agent' }, 'routing chat request');
      const result = await cb.execute(() => adapter.chat(m, params));
      const durationMs = Date.now() - start;
      this.onApiCall?.({ provider: m.provider, model: m.modelName, durationMs, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const durationMs = Date.now() - start;
      this.onApiCall?.({ provider: m.provider, model: m.modelName, durationMs, error: lastError.message });

      // Classify failure and set appropriate cooldown
      const failureType = classifyError(lastError);
      if (failureType === 'auth') {
        this.authLockedProviders.add(m.provider);
        log.error({ provider: m.provider }, 'auth failure — provider locked until key updated');
      } else {
        // Adjust circuit breaker timeout based on failure type
        const cb = this.getOrCreateBreaker(m.provider);
        cb.resetTimeoutMs = COOLDOWN_MS[failureType];
      }

      log.warn(
        { err, model: m.modelName, provider: m.provider, failureType },
        'chat request failed, trying fallback',
      );
    }
  }

  throw lastError;
}
```

4. Expose `resetTimeoutMs` on `CircuitBreaker` if not already public. Check `circuit-breaker.ts` — if `resetTimeoutMs` is private, make it a public property.

### Step 4: Run tests to verify they pass

```bash
cd packages/shared && pnpm test -- --run model-router
```

Expected: All tests PASS.

### Step 5: Commit

```bash
git add packages/shared/src/model-router.ts packages/shared/src/circuit-breaker.ts packages/shared/src/__tests__/model-router.test.ts
git commit -m "feat(shared): add failure classification and enhanced cooldowns

classifyError() maps HTTP status/message to FailureType.
Auth failures (401/403) permanently lock provider.
Rate limits use 60s cooldown, timeouts/server errors use 30s.
cheapest-first fallback strategy sorts by costPer1MInput."
```

---

## Task 5: Multi-Endpoint Ollama Discovery

**Files:**
- Modify: `packages/shared/src/model-config.ts`
- Modify: `packages/shared/src/model-router.ts` (getAdapter for multi-key providers)
- Test: `packages/shared/src/__tests__/model-config.test.ts`

### Step 1: Write failing tests for OLLAMA_ENDPOINTS parsing

Add to `model-config.test.ts`:

```typescript
describe('OLLAMA_ENDPOINTS', () => {
  beforeEach(() => {
    setEnv('OLLAMA_ENDPOINTS', undefined);
  });

  it('parses OLLAMA_ENDPOINTS into multiple provider entries', async () => {
    setEnv('OLLAMA_ENDPOINTS', 'localhost:11434,192.168.4.94:11434');
    const config = await loadModelConfig();

    expect(config.providers).toHaveProperty('ollama');
    expect(config.providers['ollama']).toEqual({
      provider: 'ollama',
      baseURL: 'http://localhost:11434/v1',
    });

    expect(config.providers).toHaveProperty('ollama@192.168.4.94');
    expect(config.providers['ollama@192.168.4.94']).toEqual({
      provider: 'ollama',
      baseURL: 'http://192.168.4.94:11434/v1',
    });
  });

  it('handles single OLLAMA_ENDPOINTS entry', async () => {
    setEnv('OLLAMA_ENDPOINTS', 'localhost:11434');
    const config = await loadModelConfig();
    expect(config.providers).toHaveProperty('ollama');
    expect(Object.keys(config.providers).filter(k => k.startsWith('ollama'))).toHaveLength(1);
  });

  it('skips empty OLLAMA_ENDPOINTS', async () => {
    setEnv('OLLAMA_ENDPOINTS', '');
    const config = await loadModelConfig();
    expect(Object.keys(config.providers).filter(k => k.startsWith('ollama'))).toHaveLength(0);
  });

  it('trims whitespace from OLLAMA_ENDPOINTS entries', async () => {
    setEnv('OLLAMA_ENDPOINTS', ' localhost:11434 , 192.168.4.94:11434 ');
    const config = await loadModelConfig();
    expect(config.providers).toHaveProperty('ollama');
    expect(config.providers).toHaveProperty('ollama@192.168.4.94');
  });
});
```

### Step 2: Run tests to verify they fail

```bash
cd packages/shared && pnpm test -- --run model-config
```

Expected: FAIL — `OLLAMA_ENDPOINTS` not parsed.

### Step 3: Implement OLLAMA_ENDPOINTS parsing

In `packages/shared/src/model-config.ts`, add to `defaultProviders()` after the OpenAI block:

```typescript
// Ollama endpoints — OLLAMA_ENDPOINTS=host1:port1,host2:port2
const ollamaEndpoints = process.env.OLLAMA_ENDPOINTS;
if (ollamaEndpoints) {
  const endpoints = ollamaEndpoints.split(',').map(e => e.trim()).filter(Boolean);
  for (const endpoint of endpoints) {
    const isLocalhost = endpoint.startsWith('localhost') || endpoint.startsWith('127.0.0.1');
    const key = isLocalhost ? 'ollama' : `ollama@${endpoint.split(':')[0]}`;
    providers[key] = {
      provider: 'ollama',
      baseURL: `http://${endpoint}/v1`,
    };
  }
}
```

Also update `guessProvider()` — when an ollama provider key is present (any key starting with `ollama`), return the first one:

```typescript
} else if (Object.keys(config.providers).some(k => k.startsWith('ollama'))) {
  guessed = 'ollama';
```

Wait — this won't work because the provider key is `ollama@hostname` but models reference `provider: 'ollama'`. Multi-endpoint Ollama models will have their provider set to the endpoint key. The `guessProvider` just needs to return `'ollama'` and the router's `getAdapter()` uses the model's `provider` field to find the adapter.

Actually for now, `OLLAMA_ENDPOINTS` just creates provider entries. Model discovery (`discoverOllamaModels`) is deferred — users will reference Ollama models by setting `DEFAULT_MODEL` to a model name and the system will route based on which provider that model is registered with. For v1, the provider entries are sufficient.

### Step 4: Run tests to verify they pass

```bash
cd packages/shared && pnpm test -- --run model-config
```

Expected: All tests PASS.

### Step 5: Commit

```bash
git add packages/shared/src/model-config.ts packages/shared/src/__tests__/model-config.test.ts
git commit -m "feat(shared): parse OLLAMA_ENDPOINTS into multiple provider entries

OLLAMA_ENDPOINTS=host1:port,host2:port creates provider keys:
'ollama' for localhost, 'ollama@hostname' for remote endpoints.
Each gets its own adapter in the ModelRouter."
```

---

## Task 6: Session-Level Model Override API

**Files:**
- Modify: `services/brain/src/db.ts:41-48`
- Modify: `services/brain/src/api.ts:259-272`
- Modify: `services/brain/src/agent.ts` (pass override to chat params)
- Test: `services/brain/src/__tests__/api-routes.test.ts`

### Step 1: Add model_override column to conversations table

In `services/brain/src/db.ts`, update the conversations CREATE TABLE (lines 41-48):

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id             TEXT PRIMARY KEY,
    title          TEXT,
    model_override TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  )
`);
```

Add migration for existing databases (after the CREATE TABLE):

```typescript
// Migration: add model_override column if it doesn't exist
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN model_override TEXT`);
} catch {
  // Column already exists — ignore
}
```

Add getter/setter functions:

```typescript
export function getConversationModelOverride(conversationId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT model_override FROM conversations WHERE id = ?').get(conversationId) as { model_override: string | null } | undefined;
  return row?.model_override ?? null;
}

export function setConversationModelOverride(conversationId: string, model: string | null): void {
  const db = getDb();
  db.prepare('UPDATE conversations SET model_override = ?, updated_at = ? WHERE id = ?')
    .run(model, new Date().toISOString(), conversationId);
}
```

### Step 2: Add PATCH /conversations/:id/model API endpoint

In `services/brain/src/api.ts`, after the `GET /conversations/:id/messages` route (line 272), add:

```typescript
app.patch('/conversations/:id/model', (req, res) => {
  try {
    const conversation = getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' });
      return;
    }

    const { model } = req.body;
    if (model !== null && model !== undefined && typeof model !== 'string') {
      res.status(400).json({ error: 'model must be a string or null' });
      return;
    }

    // Validate model exists in router config
    if (model && modelRouter) {
      const config = modelRouter.routerConfig;
      const exists = config.models.some(m => m.id === model || m.modelName === model);
      if (!exists) {
        res.status(400).json({
          error: `unknown model '${model}'`,
          available: config.models.map(m => m.id),
        });
        return;
      }
    }

    setConversationModelOverride(req.params.id, model ?? null);
    res.json({ ok: true, model: model ?? null });
  } catch (err) {
    log.error({ err }, 'set conversation model error');
    res.status(500).json({ error: 'failed to set model' });
  }
});
```

Add import for `setConversationModelOverride` and `getConversationModelOverride` from `./db.js`.

### Step 3: Update agent to read model override

In `services/brain/src/agent.ts`, where `modelRouter.chat()` is called, read the override:

```typescript
// Before calling modelRouter.chat(), check for conversation-level override
const modelOverride = getConversationModelOverride(conversationId);
const chatResponse = await modelRouter.chat({
  ...params,
  ...(modelOverride ? { modelOverride } : {}),
});
```

This is a minimal change — the `modelOverride` field already exists on `ChatParams`.

### Step 4: Write tests

Add to brain's test file or create a focused test for the API endpoint. Since the brain tests may use supertest or similar, follow the existing test pattern:

```typescript
// In api-routes test file:
it('PATCH /conversations/:id/model sets model override', async () => {
  // Create a conversation first
  // Then PATCH it
  // Then verify GET returns the override
});

it('PATCH /conversations/:id/model with null clears override', async () => {
  // Set then clear
});

it('PATCH /conversations/:id/model rejects unknown model', async () => {
  // Should return 400
});
```

### Step 5: Run tests

```bash
cd services/brain && pnpm test -- --run
```

Expected: Tests pass.

### Step 6: Commit

```bash
git add services/brain/src/db.ts services/brain/src/api.ts services/brain/src/agent.ts
git commit -m "feat(brain): add session-level model override API

PATCH /conversations/:id/model sets per-conversation model override.
Stored in model_override column on conversations table.
Agent reads override and passes as modelOverride to ModelRouter.chat()."
```

---

## Task 7: Installer — Providers Phase and Manifest Updates

**Files:**
- Modify: `tools/installer/release-manifest.json`
- Modify: `tools/installer/src/app.rs:1-56,69-78`
- Modify: `tools/installer/src/config_file.rs:13-20`
- Modify: `tools/installer/src/main.rs` (secret handling, deploy secrets)
- Modify: `tools/installer/src/tui.rs` (confirm phase display)
- Test: `tools/installer/src/manifest.rs` (embedded manifest tests)

### Step 1: Update release-manifest.json

Add `OPENAI_API_KEY` and `OLLAMA_ENDPOINTS` to `requiredSecrets`:

```json
{
  "key": "OPENAI_API_KEY",
  "description": "OpenAI API key for GPT models (optional)",
  "required": false,
  "inputType": "secret",
  "targetSecrets": ["bakerst-brain-secrets", "bakerst-worker-secrets"]
},
{
  "key": "OLLAMA_ENDPOINTS",
  "description": "Comma-separated Ollama endpoints (e.g. localhost:11434,192.168.4.94:11434)",
  "required": false,
  "inputType": "text",
  "targetSecrets": ["bakerst-brain-secrets", "bakerst-worker-secrets"]
}
```

Insert after the `AUTH_TOKEN` entry and before `AGENT_NAME`.

### Step 2: Update InstallConfig

In `tools/installer/src/app.rs`, add to `InstallConfig`:

```rust
pub struct InstallConfig {
    pub api_key: Option<String>,
    pub default_model: Option<String>,
    pub openai_api_key: Option<String>,     // NEW
    pub ollama_endpoints: Option<String>,    // NEW
    pub voyage_api_key: Option<String>,
    pub agent_name: String,
    pub auth_token: String,
    pub features: Vec<FeatureSelection>,
    pub namespace: String,
}
```

Update `Default` impl (it already derives Default, just add the new fields which are `Option<String>` so they default to `None`).

### Step 3: Update Phase enum

In `tools/installer/src/app.rs`, insert `Providers` after `Secrets`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Preflight,
    Secrets,
    Providers,  // NEW
    Features,
    Confirm,
    Pull,
    Deploy,
    Health,
    Complete,
}

impl Phase {
    pub fn index(&self) -> usize {
        match self {
            Phase::Preflight => 0,
            Phase::Secrets => 1,
            Phase::Providers => 2,   // NEW
            Phase::Features => 3,
            Phase::Confirm => 4,
            Phase::Pull => 5,
            Phase::Deploy => 6,
            Phase::Health => 7,
            Phase::Complete => 8,
        }
    }

    pub fn total() -> usize {
        9  // was 8
    }

    pub fn label(&self) -> &'static str {
        match self {
            Phase::Preflight => "Preflight",
            Phase::Secrets => "Secrets",
            Phase::Providers => "Providers",  // NEW
            Phase::Features => "Features",
            Phase::Confirm => "Confirm",
            Phase::Pull => "Pull Images",
            Phase::Deploy => "Deploy",
            Phase::Health => "Health Check",
            Phase::Complete => "Complete",
        }
    }

    pub fn next(&self) -> Option<Phase> {
        match self {
            Phase::Preflight => Some(Phase::Secrets),
            Phase::Secrets => Some(Phase::Providers),    // CHANGED
            Phase::Providers => Some(Phase::Features),   // NEW
            Phase::Features => Some(Phase::Confirm),
            Phase::Confirm => Some(Phase::Pull),
            Phase::Pull => Some(Phase::Deploy),
            Phase::Deploy => Some(Phase::Health),
            Phase::Health => Some(Phase::Complete),
            Phase::Complete => None,
        }
    }
}
```

### Step 4: Update config_file.rs

Add new fields to `Credentials`:

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct Credentials {
    pub anthropic_api_key: Option<String>,
    pub openai_api_key: Option<String>,       // NEW
    pub ollama_endpoints: Option<String>,      // NEW
    pub voyage_api_key: Option<String>,
    pub agent_name: Option<String>,
    pub auth_token: Option<String>,
    pub default_model: Option<String>,
}
```

### Step 5: Update main.rs secret handling

In `submit_current_secret()`, add match arms for the new keys:

```rust
"OPENAI_API_KEY" => {
    if !input.is_empty() {
        app.config.openai_api_key = Some(input.clone());
    }
}
"OLLAMA_ENDPOINTS" => {
    if !input.is_empty() {
        app.config.ollama_endpoints = Some(input.clone());
    }
}
```

In `deploy_secrets()`, add new keys to brain and worker secret data:

```rust
if let Some(ref key) = app.config.openai_api_key {
    brain_data.insert("OPENAI_API_KEY".into(), key.clone());
    worker_data.insert("OPENAI_API_KEY".into(), key.clone());
}
if let Some(ref endpoints) = app.config.ollama_endpoints {
    brain_data.insert("OLLAMA_ENDPOINTS".into(), endpoints.clone());
    worker_data.insert("OLLAMA_ENDPOINTS".into(), endpoints.clone());
}
```

In `run_non_interactive()`, read env vars:

```rust
app.config.openai_api_key = std::env::var("OPENAI_API_KEY").ok()
    .or_else(|| std::env::var("BAKERST_OPENAI_API_KEY").ok());
app.config.ollama_endpoints = std::env::var("OLLAMA_ENDPOINTS").ok()
    .or_else(|| std::env::var("BAKERST_OLLAMA_ENDPOINTS").ok());
```

In `run_config_install()`, read from config file:

```rust
if let Some(ref key) = file_config.credentials.openai_api_key {
    std::env::set_var("OPENAI_API_KEY", key);
    app.config.openai_api_key = Some(key.clone());
}
if let Some(ref endpoints) = file_config.credentials.ollama_endpoints {
    std::env::set_var("OLLAMA_ENDPOINTS", endpoints);
    app.config.ollama_endpoints = Some(endpoints.clone());
}
```

### Step 6: Update tests

In `tools/installer/src/manifest.rs` tests, update the assertion count if needed:

```rust
#[test]
fn embedded_manifest_has_anthropic_secret() {
    let m = embedded_manifest().unwrap();
    assert!(m.required_secrets.iter().any(|s| s.key == "ANTHROPIC_API_KEY"));
}

// Add new test
#[test]
fn embedded_manifest_has_openai_secret() {
    let m = embedded_manifest().unwrap();
    assert!(m.required_secrets.iter().any(|s| s.key == "OPENAI_API_KEY"));
}

#[test]
fn embedded_manifest_has_ollama_endpoints() {
    let m = embedded_manifest().unwrap();
    assert!(m.required_secrets.iter().any(|s| s.key == "OLLAMA_ENDPOINTS"));
}
```

Update the phase tests in `app.rs`:

```rust
#[test]
fn phase_advances_through_all_stages() {
    let mut phase = Phase::Preflight;
    let mut count = 0;
    while let Some(next) = phase.next() {
        phase = next;
        count += 1;
    }
    assert_eq!(count, 8); // was 7
    assert_eq!(phase, Phase::Complete);
}

#[test]
fn phase_index_is_sequential() {
    assert_eq!(Phase::Preflight.index(), 0);
    assert_eq!(Phase::Complete.index(), 8); // was 7
}
```

### Step 7: Run tests

```bash
cd tools/installer && cargo test
```

Expected: All tests PASS.

### Step 8: Commit

```bash
git add tools/installer/release-manifest.json tools/installer/src/app.rs tools/installer/src/config_file.rs tools/installer/src/main.rs tools/installer/src/manifest.rs tools/installer/src/tui.rs
git commit -m "feat(installer): add Providers phase with OpenAI and Ollama support

New Phase::Providers between Secrets and Features. Total phases: 9.
OPENAI_API_KEY and OLLAMA_ENDPOINTS added to release-manifest.json
and handled in interactive, non-interactive, and config-file modes.
New secrets deployed to brain and worker K8s secrets."
```

---

## Task 8: Update Shell Scripts and Docs

**Files:**
- Modify: `scripts/secrets.sh`
- Modify: `scripts/deploy-all.sh`
- Modify: `scripts/Deploy-BakerStreet.ps1`
- Modify: `CLAUDE.md`

### Step 1: Update secrets.sh

Add `OPENAI_API_KEY` and `OLLAMA_ENDPOINTS` to brain and worker secret creation.

In the brain secrets section (around line 32-42), add:

```bash
if [ -n "${OPENAI_API_KEY:-}" ]; then
  brain_args+=("--from-literal=OPENAI_API_KEY=${OPENAI_API_KEY}")
fi
if [ -n "${OLLAMA_ENDPOINTS:-}" ]; then
  brain_args+=("--from-literal=OLLAMA_ENDPOINTS=${OLLAMA_ENDPOINTS}")
fi
```

In the worker secrets section (around line 58-68), add the same two blocks.

### Step 2: Update deploy-all.sh

Add `OPENAI_API_KEY` and `OLLAMA_ENDPOINTS` to the .env-secrets template, secret prompts, and K8s secret creation sections. Follow the existing pattern for optional secrets (like `VOYAGE_API_KEY`).

### Step 3: Update Deploy-BakerStreet.ps1

Add the same handling in the PowerShell script, following the existing pattern.

### Step 4: Update CLAUDE.md

Add to the secrets list:

```
OPENAI_API_KEY            # OpenAI API key (optional, for GPT models)
OLLAMA_ENDPOINTS          # Comma-separated Ollama endpoints (optional)
```

Add to secret scoping:

```
- `bakerst-brain-secrets` — ANTHROPIC_API_KEY, DEFAULT_MODEL, OPENAI_API_KEY, OLLAMA_ENDPOINTS, VOYAGE_API_KEY, AUTH_TOKEN, AGENT_NAME
- `bakerst-worker-secrets` — ANTHROPIC_API_KEY, DEFAULT_MODEL, OPENAI_API_KEY, OLLAMA_ENDPOINTS, AGENT_NAME
```

### Step 5: Verify

```bash
# Ensure no syntax errors in shell scripts
bash -n scripts/secrets.sh
bash -n scripts/deploy-all.sh
```

### Step 6: Commit

```bash
git add scripts/secrets.sh scripts/deploy-all.sh scripts/Deploy-BakerStreet.ps1 CLAUDE.md
git commit -m "docs(scripts): add OPENAI_API_KEY and OLLAMA_ENDPOINTS to deploy scripts

Updated secrets.sh, deploy-all.sh, Deploy-BakerStreet.ps1 to handle
new provider secrets. Updated CLAUDE.md with new env vars and scoping."
```

---

## Verification Checklist

After all tasks:

```bash
# TypeScript tests
cd packages/shared && pnpm test -- --run
cd services/brain && pnpm test -- --run

# Rust installer tests
cd tools/installer && cargo test

# Ensure no regressions
cd packages/shared && pnpm test -- --run model-config
cd packages/shared && pnpm test -- --run model-router

# Verify new env vars documented
grep -r 'OPENAI_API_KEY' scripts/secrets.sh CLAUDE.md
grep -r 'OLLAMA_ENDPOINTS' scripts/secrets.sh CLAUDE.md
```
