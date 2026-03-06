import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

import { discoverOllamaModels } from '../ollama-discovery.js';

describe('discoverOllamaModels', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns model definitions from Ollama /api/tags', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'llama3:latest', size: 4_000_000_000 },
            { name: 'mistral:7b', size: 4_000_000_000 },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model_info: { 'context_length': 8192 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model_info: { 'context_length': 32768 },
        }),
      });

    const models = await discoverOllamaModels('http://localhost:11434', 'ollama');
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      id: 'ollama:llama3',
      modelName: 'llama3:latest',
      provider: 'ollama',
      maxTokens: 4096,
    });
    expect(models[1]).toEqual({
      id: 'ollama:mistral',
      modelName: 'mistral:7b',
      provider: 'ollama',
      maxTokens: 4096,
    });
  });

  it('returns empty array when endpoint is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const models = await discoverOllamaModels('http://localhost:11434', 'ollama');
    expect(models).toEqual([]);
  });

  it('returns empty array when /api/tags returns error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const models = await discoverOllamaModels('http://localhost:11434', 'ollama');
    expect(models).toEqual([]);
  });

  it('skips models where /api/show fails', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'llama3:latest', size: 4_000_000_000 },
          ],
        }),
      })
      .mockRejectedValueOnce(new Error('show failed'));

    const models = await discoverOllamaModels('http://localhost:11434', 'ollama');
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('ollama:llama3');
  });

  it('namespaces model IDs with provider key', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: 'qwen2:7b', size: 4_000_000_000 }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model_info: { 'context_length': 4096 },
        }),
      });

    const models = await discoverOllamaModels('http://remote:11434', 'ollama@remote');
    expect(models[0].id).toBe('ollama@remote:qwen2');
  });
});
