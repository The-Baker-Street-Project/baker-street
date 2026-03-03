/**
 * ModelRouter — routes chat requests to the appropriate LLM provider.
 *
 * Supports:
 *   - Anthropic (direct, API key)
 *   - OpenRouter (Anthropic SDK with custom baseURL)
 *   - OpenAI native (openai SDK with full tool support)
 *   - Ollama / OpenAI-compatible (openai SDK with custom baseURL)
 *
 * The router resolves role -> model definition -> provider adapter, handles
 * fallback chains, and normalises responses into provider-agnostic types.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';
import { CircuitBreaker } from './circuit-breaker.js';
import type {
  ModelRouterConfig,
  ModelDefinition,
  ModelRoles,
  AnthropicProviderConfig,
  OpenRouterProviderConfig,
  OllamaProviderConfig,
  OpenAICompatibleProviderConfig,
  OpenAIProviderConfig,
  ChatParams,
  ChatResponse,
  ChatContentBlock,
  ModelStreamEvent,
} from './model-types.js';

const log = logger.child({ module: 'model-router' });

// ---------------------------------------------------------------------------
// Runtime type guards — replace bare `as` casts
// ---------------------------------------------------------------------------

/** Validate that an Anthropic chat response has the expected shape */
function isValidAnthropicResponse(resp: unknown): resp is {
  content: unknown[];
  stop_reason: string | null;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
} {
  if (typeof resp !== 'object' || resp === null) return false;
  const r = resp as Record<string, unknown>;
  return (
    Array.isArray(r.content) &&
    typeof r.model === 'string' &&
    typeof r.usage === 'object' &&
    r.usage !== null &&
    typeof (r.usage as Record<string, unknown>).input_tokens === 'number' &&
    typeof (r.usage as Record<string, unknown>).output_tokens === 'number'
  );
}

/** Validate that a content block has a known type */
function isValidContentBlock(block: unknown): block is ChatContentBlock {
  if (typeof block !== 'object' || block === null) return false;
  const b = block as Record<string, unknown>;
  if (b.type === 'text') return typeof b.text === 'string';
  if (b.type === 'tool_use') return typeof b.id === 'string' && typeof b.name === 'string';
  if (b.type === 'tool_result') return typeof b.tool_use_id === 'string';
  return false;
}

/** Validate content array from API response */
function validateContentBlocks(content: unknown[]): ChatContentBlock[] {
  const validated: ChatContentBlock[] = [];
  for (const block of content) {
    if (isValidContentBlock(block)) {
      validated.push(block);
    } else {
      log.warn({ block }, 'dropping invalid content block from API response');
    }
  }
  return validated;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------

interface ProviderAdapter {
  chat(model: ModelDefinition, params: ChatParams): Promise<ChatResponse>;
  chatStream(model: ModelDefinition, params: ChatParams): AsyncGenerator<ModelStreamEvent>;
}

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

function createAnthropicAdapter(providerCfg: AnthropicProviderConfig): ProviderAdapter {
  const apiKey = providerCfg.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('anthropic adapter: no credentials found');
  }

  const client = new Anthropic({ apiKey });
  log.info('anthropic adapter: using API key');

  const adapter: ProviderAdapter = {
    async chat(model: ModelDefinition, params: ChatParams): Promise<ChatResponse> {
      const response = await client.messages.create({
        model: model.modelName,
        max_tokens: params.maxTokens ?? model.maxTokens,
        system: params.system as Anthropic.Messages.TextBlockParam[] | undefined,
        tools: params.tools as Anthropic.Messages.Tool[] | undefined,
        messages: params.messages as Anthropic.Messages.MessageParam[],
      });

      if (!isValidAnthropicResponse(response)) {
        throw new Error('anthropic adapter: invalid response shape from API');
      }

      const usage: ChatResponse['usage'] = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
      // Propagate prompt cache stats if present
      const rawUsage = response.usage as unknown as Record<string, unknown>;
      if (typeof rawUsage.cache_creation_input_tokens === 'number') {
        usage.cacheCreationInputTokens = rawUsage.cache_creation_input_tokens;
      }
      if (typeof rawUsage.cache_read_input_tokens === 'number') {
        usage.cacheReadInputTokens = rawUsage.cache_read_input_tokens;
      }

      return {
        content: validateContentBlocks(response.content),
        stopReason: response.stop_reason ?? 'end_turn',
        model: response.model,
        usage,
      };
    },

    async *chatStream(model: ModelDefinition, params: ChatParams): AsyncGenerator<ModelStreamEvent> {
      const stream = client.messages.stream({
        model: model.modelName,
        max_tokens: params.maxTokens ?? model.maxTokens,
        system: params.system as Anthropic.Messages.TextBlockParam[] | undefined,
        tools: params.tools as Anthropic.Messages.Tool[] | undefined,
        messages: params.messages as Anthropic.Messages.MessageParam[],
      });

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield { type: 'text_delta', text: event.delta.text };
        }
      }

      const finalMessage = await stream.finalMessage();
      if (!isValidAnthropicResponse(finalMessage)) {
        throw new Error('anthropic adapter: invalid final message shape from stream');
      }

      const streamUsage: ChatResponse['usage'] = {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      };
      const rawStreamUsage = finalMessage.usage as unknown as Record<string, unknown>;
      if (typeof rawStreamUsage.cache_creation_input_tokens === 'number') {
        streamUsage.cacheCreationInputTokens = rawStreamUsage.cache_creation_input_tokens;
      }
      if (typeof rawStreamUsage.cache_read_input_tokens === 'number') {
        streamUsage.cacheReadInputTokens = rawStreamUsage.cache_read_input_tokens;
      }

      yield {
        type: 'message_done',
        response: {
          content: validateContentBlocks(finalMessage.content),
          stopReason: finalMessage.stop_reason ?? 'end_turn',
          model: finalMessage.model,
          usage: streamUsage,
        },
      };
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// OpenRouter adapter (uses Anthropic SDK with custom baseURL)
// ---------------------------------------------------------------------------

function createOpenRouterAdapter(providerCfg: OpenRouterProviderConfig): ProviderAdapter {
  const baseURL = providerCfg.baseURL ?? 'https://openrouter.ai/api/v1';
  const client = new Anthropic({
    apiKey: providerCfg.apiKey,
    baseURL,
  });

  log.info({ baseURL }, 'openrouter adapter: initialized');

  return {
    async chat(model: ModelDefinition, params: ChatParams): Promise<ChatResponse> {
      const response = await client.messages.create({
        model: model.modelName,
        max_tokens: params.maxTokens ?? model.maxTokens,
        system: params.system as Anthropic.Messages.TextBlockParam[] | undefined,
        tools: params.tools as Anthropic.Messages.Tool[] | undefined,
        messages: params.messages as Anthropic.Messages.MessageParam[],
      });

      if (!isValidAnthropicResponse(response)) {
        throw new Error('openrouter adapter: invalid response shape from API');
      }

      return {
        content: validateContentBlocks(response.content),
        stopReason: response.stop_reason ?? 'end_turn',
        model: response.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },

    async *chatStream(model: ModelDefinition, params: ChatParams): AsyncGenerator<ModelStreamEvent> {
      const stream = client.messages.stream({
        model: model.modelName,
        max_tokens: params.maxTokens ?? model.maxTokens,
        system: params.system as Anthropic.Messages.TextBlockParam[] | undefined,
        tools: params.tools as Anthropic.Messages.Tool[] | undefined,
        messages: params.messages as Anthropic.Messages.MessageParam[],
      });

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield { type: 'text_delta', text: event.delta.text };
        }
      }

      const finalMessage = await stream.finalMessage();
      if (!isValidAnthropicResponse(finalMessage)) {
        throw new Error('openrouter adapter: invalid final message shape from stream');
      }

      yield {
        type: 'message_done',
        response: {
          content: validateContentBlocks(finalMessage.content),
          stopReason: finalMessage.stop_reason ?? 'end_turn',
          model: finalMessage.model,
          usage: {
            inputTokens: finalMessage.usage.input_tokens,
            outputTokens: finalMessage.usage.output_tokens,
          },
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI native adapter (uses openai SDK with full tool support)
// ---------------------------------------------------------------------------

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

/** Safely parse JSON, returning empty object on failure */
function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    log.warn({ str: str.slice(0, 200) }, 'failed to parse tool call arguments');
    return {};
  }
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
        input: safeJsonParse(tc.function.arguments),
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
          input: safeJsonParse(tc.args || '{}'),
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

// ---------------------------------------------------------------------------
// Ollama / OpenAI-compatible adapter (uses openai SDK)
// ---------------------------------------------------------------------------

async function createOpenAICompatibleAdapter(
  providerCfg: OllamaProviderConfig | OpenAICompatibleProviderConfig,
): Promise<ProviderAdapter> {
  // Dynamic import — only loaded if this provider is actually used
  const { default: OpenAI } = await import('openai');

  const baseURL =
    providerCfg.provider === 'ollama'
      ? providerCfg.baseURL ?? 'http://localhost:11434/v1'
      : providerCfg.baseURL;

  const apiKey =
    providerCfg.provider === 'openai-compatible'
      ? (providerCfg as OpenAICompatibleProviderConfig).apiKey ?? 'not-needed'
      : 'not-needed';

  const client = new OpenAI({ baseURL, apiKey });

  log.info({ baseURL, provider: providerCfg.provider }, 'openai-compatible adapter: initialized');

  return {
    async chat(model: ModelDefinition, params: ChatParams): Promise<ChatResponse> {
      // Convert Anthropic-style messages to OpenAI format
      const messages = convertToOpenAIMessages(params);

      const response = await client.chat.completions.create({
        model: model.modelName,
        max_tokens: params.maxTokens ?? model.maxTokens,
        messages,
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new Error('openai-compatible adapter: no choices in response');
      }

      const content: ChatContentBlock[] = [];
      if (choice.message.content) {
        content.push({ type: 'text', text: choice.message.content });
      }

      return {
        content,
        stopReason: choice.finish_reason === 'stop' ? 'end_turn' : (choice.finish_reason ?? 'end_turn'),
        model: response.model,
        usage: response.usage
          ? {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens ?? 0,
            }
          : undefined,
      };
    },

    async *chatStream(model: ModelDefinition, params: ChatParams): AsyncGenerator<ModelStreamEvent> {
      const messages = convertToOpenAIMessages(params);

      const stream = await client.chat.completions.create({
        model: model.modelName,
        max_tokens: params.maxTokens ?? model.maxTokens,
        messages,
        stream: true,
      });

      let fullText = '';
      let finishReason = 'end_turn';

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          fullText += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }
        if (chunk.choices[0]?.finish_reason) {
          finishReason =
            chunk.choices[0].finish_reason === 'stop'
              ? 'end_turn'
              : chunk.choices[0].finish_reason;
        }
      }

      yield {
        type: 'message_done',
        response: {
          content: fullText ? [{ type: 'text', text: fullText }] : [],
          stopReason: finishReason,
          model: model.modelName,
        },
      };
    },
  };
}

/** Convert Anthropic-style system/messages to OpenAI chat messages */
function convertToOpenAIMessages(
  params: ChatParams,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

  // System blocks -> single system message
  if (params.system && params.system.length > 0) {
    out.push({
      role: 'system',
      content: params.system.map((b) => b.text).join('\n\n'),
    });
  }

  // Conversation messages — flatten content blocks to text
  for (const msg of params.messages) {
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
    out.push({ role: msg.role, content: text });
  }

  return out;
}

// ---------------------------------------------------------------------------
// ModelRouter class
// ---------------------------------------------------------------------------

export class ModelRouter {
  private adapters: Map<string, ProviderAdapter> = new Map();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private authLockedModels: Set<string> = new Set();
  private config: ModelRouterConfig;
  private onApiCall?: (info: { provider: string; model: string; durationMs: number; inputTokens?: number; outputTokens?: number; error?: string }) => void;

  private constructor(config: ModelRouterConfig) {
    this.config = config;
  }

  /** The resolved config for external inspection */
  get routerConfig(): ModelRouterConfig {
    return this.config;
  }

  /**
   * Factory: create and initialise a ModelRouter.
   * Eagerly creates the Anthropic adapter; others are lazy.
   */
  static async create(config: ModelRouterConfig): Promise<ModelRouter> {
    const router = new ModelRouter(config);

    // Eagerly initialise Anthropic adapter if configured (most common case)
    const anthropicCfg = config.providers['anthropic'];
    if (anthropicCfg && anthropicCfg.provider === 'anthropic') {
      router.adapters.set('anthropic', createAnthropicAdapter(anthropicCfg));
    }

    // OpenRouter — eager if configured
    const orCfg = config.providers['openrouter'];
    if (orCfg && orCfg.provider === 'openrouter') {
      router.adapters.set('openrouter', createOpenRouterAdapter(orCfg));
    }

    // OpenAI native — eager if configured
    const openaiCfg = config.providers['openai'];
    if (openaiCfg && openaiCfg.provider === 'openai') {
      router.adapters.set('openai', await createOpenAINativeAdapter(openaiCfg as OpenAIProviderConfig));
    }

    return router;
  }

  /** Set a callback for API call audit logging */
  setOnApiCall(cb: typeof this.onApiCall): void {
    this.onApiCall = cb;
  }

  private getOrCreateBreaker(provider: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(provider);
    if (!cb) {
      cb = new CircuitBreaker({
        name: `model-router-${provider}`,
        failureThreshold: 5,
        resetTimeoutMs: 30_000,
      });
      this.circuitBreakers.set(provider, cb);
    }
    return cb;
  }

  // -----------------------------------------------------------------------
  // Model resolution
  // -----------------------------------------------------------------------

  private resolveModel(params: ChatParams): ModelDefinition {
    const role = params.role ?? 'agent';
    const modelId = params.modelOverride ?? this.config.roles[role];

    if (!modelId) {
      throw new Error(`model-router: no model configured for role '${role}'`);
    }

    const model = this.config.models.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(
        `model-router: unknown model id '${modelId}' for role '${role}'`,
      );
    }

    return model;
  }

  private async getAdapter(provider: string): Promise<ProviderAdapter> {
    const existing = this.adapters.get(provider);
    if (existing) return existing;

    // Lazy-init ollama and openai-compatible adapters
    const providerCfg = this.config.providers[provider];
    if (!providerCfg) {
      throw new Error(`model-router: no provider config for '${provider}'`);
    }

    if (providerCfg.provider === 'ollama' || providerCfg.provider === 'openai-compatible') {
      const adapter = await createOpenAICompatibleAdapter(providerCfg);
      this.adapters.set(provider, adapter);
      return adapter;
    }

    if (providerCfg.provider === 'openai') {
      const adapter = await createOpenAINativeAdapter(providerCfg as OpenAIProviderConfig);
      this.adapters.set(provider, adapter);
      return adapter;
    }

    throw new Error(`model-router: cannot create adapter for provider '${provider}'`);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Update roles and/or fallback chain at runtime (in-memory only) */
  updateConfig(updates: { roles?: Partial<ModelRoles>; fallbackChain?: string[] }): void {
    if (updates.roles) {
      this.config.roles = { ...this.config.roles, ...updates.roles };
      log.info({ roles: this.config.roles }, 'model router roles updated');
    }
    if (updates.fallbackChain !== undefined) {
      this.config.fallbackChain = updates.fallbackChain;
      log.info({ fallbackChain: this.config.fallbackChain }, 'model router fallback chain updated');
    }
  }

  /** Non-streaming chat call with fallback support */
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
      // Skip auth-locked models
      if (this.authLockedModels.has(m.id)) {
        log.warn({ model: m.id, provider: m.provider }, 'skipping auth-locked model');
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
          this.authLockedModels.add(m.id);
          log.error({ model: m.id, provider: m.provider }, 'auth failure — model locked until key updated');
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

  /** Streaming chat call with circuit breaker (no fallback — fails immediately) */
  async *chatStream(params: ChatParams): AsyncGenerator<ModelStreamEvent> {
    const model = this.resolveModel(params);

    // Reject early if model is auth-locked
    if (this.authLockedModels.has(model.id)) {
      throw new Error(`Model '${model.id}' is auth-locked (previous 401/403 failure)`);
    }

    const adapter = await this.getAdapter(model.provider);
    const cb = this.getOrCreateBreaker(model.provider);
    log.info({ model: model.modelName, provider: model.provider, role: params.role ?? 'agent' }, 'routing streaming chat request');

    const events = await cb.execute(async () => {
      const collected: ModelStreamEvent[] = [];
      for await (const event of adapter.chatStream(model, params)) {
        collected.push(event);
      }
      return collected;
    });

    for (const event of events) {
      yield event;
    }
  }
}
