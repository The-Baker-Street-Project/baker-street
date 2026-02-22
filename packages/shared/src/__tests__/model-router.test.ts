import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelRouterConfig, ChatParams, ChatResponse } from '../model-types.js';

// ---------------------------------------------------------------------------
// Mock Anthropic SDK
// ---------------------------------------------------------------------------

const { mockMessagesCreate, mockMessagesStream, mockOpenAICreate } = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockMessagesStream: vi.fn(),
  mockOpenAICreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: mockMessagesCreate,
      stream: mockMessagesStream,
    },
  })),
}));

// ---------------------------------------------------------------------------
// Mock openai SDK (for Ollama / OpenAI-compatible adapter)
// ---------------------------------------------------------------------------

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockOpenAICreate,
      },
    },
  })),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { ModelRouter } from '../model-router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<ModelRouterConfig>): ModelRouterConfig {
  return {
    providers: {
      anthropic: {
        provider: 'anthropic' as const,
        apiKey: 'sk-test-key',
      },
    },
    models: [
      {
        id: 'sonnet-4',
        modelName: 'claude-sonnet-4-20250514',
        provider: 'anthropic' as const,
        maxTokens: 4096,
      },
      {
        id: 'haiku-4.5',
        modelName: 'claude-haiku-4-5-20251001',
        provider: 'anthropic' as const,
        maxTokens: 2048,
      },
    ],
    roles: {
      agent: 'sonnet-4',
      observer: 'haiku-4.5',
    },
    ...overrides,
  };
}

const mockAnthropicResponse = {
  content: [{ type: 'text', text: 'Hello from Claude' }],
  stop_reason: 'end_turn',
  model: 'claude-sonnet-4-20250514',
  usage: { input_tokens: 10, output_tokens: 20 },
};

function makeParams(overrides?: Partial<ChatParams>): ChatParams {
  return {
    messages: [{ role: 'user', content: 'Hi' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create()', () => {
    it('initializes with Anthropic provider', async () => {
      const router = await ModelRouter.create(makeConfig());
      expect(router).toBeInstanceOf(ModelRouter);
      expect(router.routerConfig.providers).toHaveProperty('anthropic');
    });

    it('initializes with OpenRouter provider', async () => {
      const config = makeConfig({
        providers: {
          openrouter: {
            provider: 'openrouter' as const,
            apiKey: 'or-test-key',
          },
        },
      });
      const router = await ModelRouter.create(config);
      expect(router.routerConfig.providers).toHaveProperty('openrouter');
    });

    it('sets useOAuth to false for API key auth', async () => {
      const router = await ModelRouter.create(makeConfig());
      expect(router.useOAuth).toBe(false);
    });

    it('sets useOAuth to true for OAuth token', async () => {
      const config = makeConfig({
        providers: {
          anthropic: {
            provider: 'anthropic' as const,
            oauthToken: 'sk-ant-oat-test-token',
          },
        },
      });
      const router = await ModelRouter.create(config);
      expect(router.useOAuth).toBe(true);
    });
  });

  describe('resolveModel() (tested via chat)', () => {
    it('resolves agent role to correct model', async () => {
      mockMessagesCreate.mockResolvedValue(mockAnthropicResponse);
      const router = await ModelRouter.create(makeConfig());
      await router.chat(makeParams());
      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4-20250514' }),
      );
    });

    it('resolves observer role', async () => {
      mockMessagesCreate.mockResolvedValue(mockAnthropicResponse);
      const router = await ModelRouter.create(makeConfig());
      await router.chat(makeParams({ role: 'observer' }));
      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
      );
    });

    it('throws for unknown role', async () => {
      const router = await ModelRouter.create(makeConfig());
      await expect(
        router.chat(makeParams({ role: 'worker' as any })),
      ).rejects.toThrow("no model configured for role 'worker'");
    });

    it('uses modelOverride when provided', async () => {
      mockMessagesCreate.mockResolvedValue(mockAnthropicResponse);
      const router = await ModelRouter.create(makeConfig());
      await router.chat(makeParams({ modelOverride: 'haiku-4.5' }));
      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
      );
    });
  });

  describe('chat()', () => {
    it('calls adapter with correct params and normalizes response', async () => {
      mockMessagesCreate.mockResolvedValue(mockAnthropicResponse);
      const router = await ModelRouter.create(makeConfig());
      const response = await router.chat(makeParams());

      expect(response.content).toEqual([{ type: 'text', text: 'Hello from Claude' }]);
      expect(response.stopReason).toBe('end_turn');
      expect(response.model).toBe('claude-sonnet-4-20250514');
      expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    });

    it('tries fallback chain on primary failure', async () => {
      mockMessagesCreate
        .mockRejectedValueOnce(new Error('primary failed'))
        .mockResolvedValueOnce({
          ...mockAnthropicResponse,
          model: 'claude-haiku-4-5-20251001',
        });

      const config = makeConfig({ fallbackChain: ['sonnet-4', 'haiku-4.5'] });
      const router = await ModelRouter.create(config);
      const response = await router.chat(makeParams());

      expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
      expect(response.model).toBe('claude-haiku-4-5-20251001');
    });

    it('throws when all fallbacks fail', async () => {
      mockMessagesCreate
        .mockRejectedValueOnce(new Error('primary failed'))
        .mockRejectedValueOnce(new Error('fallback failed'));

      const config = makeConfig({ fallbackChain: ['sonnet-4', 'haiku-4.5'] });
      const router = await ModelRouter.create(config);

      await expect(router.chat(makeParams())).rejects.toThrow('fallback failed');
    });
  });

  describe('chatStream()', () => {
    it('yields text_delta events', async () => {
      const mockAsyncIterator = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } };
        },
      };
      const mockFinalMessage = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hello world' }],
        stop_reason: 'end_turn',
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 5, output_tokens: 10 },
      });

      mockMessagesStream.mockReturnValue({
        [Symbol.asyncIterator]: mockAsyncIterator[Symbol.asyncIterator],
        finalMessage: mockFinalMessage,
      });

      const router = await ModelRouter.create(makeConfig());
      const events: any[] = [];
      for await (const event of router.chatStream(makeParams())) {
        events.push(event);
      }

      expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'text_delta', text: 'Hello' });
      expect(events[1]).toEqual({ type: 'text_delta', text: ' world' });
    });

    it('yields message_done at end', async () => {
      const mockAsyncIterator = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } };
        },
      };
      const mockFinalMessage = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hi' }],
        stop_reason: 'end_turn',
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      mockMessagesStream.mockReturnValue({
        [Symbol.asyncIterator]: mockAsyncIterator[Symbol.asyncIterator],
        finalMessage: mockFinalMessage,
      });

      const router = await ModelRouter.create(makeConfig());
      const events: any[] = [];
      for await (const event of router.chatStream(makeParams())) {
        events.push(event);
      }

      const last = events[events.length - 1];
      expect(last.type).toBe('message_done');
      expect(last.response.content).toEqual([{ type: 'text', text: 'Hi' }]);
      expect(last.response.stopReason).toBe('end_turn');
    });

    it('does NOT use fallback (fails immediately)', async () => {
      mockMessagesStream.mockImplementation(() => {
        throw new Error('stream failed');
      });

      const config = makeConfig({ fallbackChain: ['sonnet-4', 'haiku-4.5'] });
      const router = await ModelRouter.create(config);

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _event of router.chatStream(makeParams())) {
          // consume
        }
      }).rejects.toThrow('stream failed');

      // Should NOT attempt fallback — stream only calls once
      expect(mockMessagesStream).toHaveBeenCalledTimes(1);
    });

    it('uses circuit breaker for streaming', async () => {
      const router = await ModelRouter.create(makeConfig());

      // Fail 5 times to trip the breaker
      for (let i = 0; i < 5; i++) {
        mockMessagesStream.mockImplementationOnce(() => {
          throw new Error('stream failed');
        });
        try {
          for await (const _event of router.chatStream(makeParams())) { /* consume */ }
        } catch { /* expected */ }
      }

      // 6th call should fail immediately with circuit breaker open
      mockMessagesStream.mockClear();

      await expect(async () => {
        for await (const _event of router.chatStream(makeParams())) { /* consume */ }
      }).rejects.toThrow(/circuit breaker.*open/i);

      // Adapter should NOT have been called — breaker rejected it
      expect(mockMessagesStream).not.toHaveBeenCalled();
    });
  });

  describe('response validation', () => {
    it('throws on invalid response shape (missing content)', async () => {
      mockMessagesCreate.mockResolvedValue({
        // missing 'content' array
        stop_reason: 'end_turn',
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const router = await ModelRouter.create(makeConfig());
      await expect(router.chat(makeParams())).rejects.toThrow('invalid response shape');
    });

    it('throws on invalid response shape (missing usage)', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
        model: 'claude-sonnet-4-20250514',
        // missing 'usage'
      });

      const router = await ModelRouter.create(makeConfig());
      await expect(router.chat(makeParams())).rejects.toThrow('invalid response shape');
    });

    it('drops invalid content blocks from response', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [
          { type: 'text', text: 'Valid' },
          { type: 'unknown_type', data: 'invalid' },
          { type: 'text', text: 'Also valid' },
        ],
        stop_reason: 'end_turn',
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const router = await ModelRouter.create(makeConfig());
      const response = await router.chat(makeParams());
      expect(response.content).toEqual([
        { type: 'text', text: 'Valid' },
        { type: 'text', text: 'Also valid' },
      ]);
    });

    it('validates tool_use content blocks', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [
          { type: 'tool_use', id: 'tu_123', name: 'get_weather', input: { city: 'NYC' } },
        ],
        stop_reason: 'tool_use',
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const router = await ModelRouter.create(makeConfig());
      const response = await router.chat(makeParams());
      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe('tool_use');
    });
  });

  describe('getAdapter() lazy init', () => {
    it('lazy-inits Ollama adapter', async () => {
      const config: ModelRouterConfig = {
        providers: {
          anthropic: { provider: 'anthropic', apiKey: 'sk-test' },
          ollama: { provider: 'ollama', baseURL: 'http://localhost:11434/v1' },
        },
        models: [
          { id: 'sonnet-4', modelName: 'claude-sonnet-4-20250514', provider: 'anthropic', maxTokens: 4096 },
          { id: 'llama3', modelName: 'llama3:8b', provider: 'ollama', maxTokens: 4096 },
        ],
        roles: { agent: 'sonnet-4', observer: 'sonnet-4' },
      };

      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: 'Hello from Llama' }, finish_reason: 'stop' }],
        model: 'llama3:8b',
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      });

      const router = await ModelRouter.create(config);
      const response = await router.chat(makeParams({ modelOverride: 'llama3' }));

      expect(response.content).toEqual([{ type: 'text', text: 'Hello from Llama' }]);
      expect(mockOpenAICreate).toHaveBeenCalled();
    });
  });
});
