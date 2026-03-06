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
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3:latest', size: 4_000_000_000 },
          { name: 'mistral:7b', size: 4_000_000_000 },
        ],
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
    // Only one fetch call — /api/tags only, no /api/show
    expect(mockFetch).toHaveBeenCalledTimes(1);
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

  it('namespaces model IDs with provider key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'qwen2:7b', size: 4_000_000_000 }],
      }),
    });

    const models = await discoverOllamaModels('http://remote:11434', 'ollama@remote');
    expect(models[0].id).toBe('ollama@remote:qwen2');
  });

  it('strips /v1 suffix from base URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'phi3:latest', size: 2_000_000_000 }],
      }),
    });

    await discoverOllamaModels('http://localhost:11434/v1', 'ollama');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.any(Object),
    );
  });
});
