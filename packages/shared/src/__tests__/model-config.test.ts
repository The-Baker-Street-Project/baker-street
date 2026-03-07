import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createDefaultConfig, loadModelConfig } from '../model-config.js';

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear the saved entries
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('model-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure basic providers are available
    setEnv('ANTHROPIC_API_KEY', 'sk-test-key');
    setEnv('OPENROUTER_API_KEY', undefined);
    setEnv('OPENAI_API_KEY', undefined);
    setEnv('MODEL_ROUTER_CONFIG_PATH', undefined);
    setEnv('DEFAULT_MODEL', undefined);
    setEnv('OBSERVER_MODEL', undefined);
    setEnv('OLLAMA_ENDPOINTS', undefined);
  });

  afterEach(() => {
    restoreEnv();
  });

  describe('createDefaultConfig()', () => {
    it('returns valid config structure', () => {
      const config = createDefaultConfig();
      expect(config).toHaveProperty('providers');
      expect(config).toHaveProperty('models');
      expect(config).toHaveProperty('roles');
      expect(Array.isArray(config.models)).toBe(true);
      expect(config.roles).toHaveProperty('agent');
      expect(config.roles).toHaveProperty('observer');
    });

    it('includes anthropic provider when ANTHROPIC_API_KEY is set', () => {
      const config = createDefaultConfig();
      expect(config.providers).toHaveProperty('anthropic');
      expect(config.providers['anthropic'].provider).toBe('anthropic');
    });

    it('includes openrouter when OPENROUTER_API_KEY set', () => {
      setEnv('OPENROUTER_API_KEY', 'or-test-key');
      const config = createDefaultConfig();
      expect(config.providers).toHaveProperty('openrouter');
      expect(config.providers['openrouter'].provider).toBe('openrouter');
    });

    it('does not include openrouter when OPENROUTER_API_KEY not set', () => {
      const config = createDefaultConfig();
      expect(config.providers).not.toHaveProperty('openrouter');
    });

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
  });

  describe('loadModelConfig()', () => {
    it('loads from file when MODEL_ROUTER_CONFIG_PATH set', async () => {
      const fileConfig = {
        providers: { anthropic: { provider: 'anthropic', apiKey: 'file-key' } },
        models: [{ id: 'test-model', modelName: 'test-model-name', provider: 'anthropic', maxTokens: 1024 }],
        roles: { agent: 'test-model', observer: 'test-model' },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(fileConfig));
      setEnv('MODEL_ROUTER_CONFIG_PATH', '/some/config.json');

      const config = await loadModelConfig();
      expect(mockReadFile).toHaveBeenCalledWith('/some/config.json', 'utf-8');
      expect(config.models[0].id).toBe('test-model');
    });

    it('uses defaults when no file path', async () => {
      const config = await loadModelConfig();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(config.models.length).toBeGreaterThan(0);
      expect(config.roles.agent).toBe('sonnet-4');
    });

    it('applies DEFAULT_MODEL override for a known model ID', async () => {
      setEnv('DEFAULT_MODEL', 'haiku-4.5');
      const config = await loadModelConfig();
      expect(config.roles.agent).toBe('haiku-4.5');
    });

    it('applies DEFAULT_MODEL override with known model name', async () => {
      setEnv('DEFAULT_MODEL', 'claude-opus-4-20250514');
      const config = await loadModelConfig();
      expect(config.roles.agent).toBe('opus-4');
    });

    it('applies DEFAULT_MODEL override with unknown model as ad-hoc', async () => {
      setEnv('DEFAULT_MODEL', 'claude-unknown-model');
      const config = await loadModelConfig();
      expect(config.roles.agent).toBe('custom-agent');
      const adHoc = config.models.find((m) => m.id === 'custom-agent');
      expect(adHoc).toBeDefined();
      expect(adHoc!.modelName).toBe('claude-unknown-model');
    });

    it('applies OBSERVER_MODEL override', async () => {
      setEnv('OBSERVER_MODEL', 'sonnet-4');
      const config = await loadModelConfig();
      expect(config.roles.observer).toBe('sonnet-4');
    });

    it('applies OPENROUTER_API_KEY override to add provider', async () => {
      setEnv('OPENROUTER_API_KEY', 'or-new-key');
      const config = await loadModelConfig();
      expect(config.providers).toHaveProperty('openrouter');
    });

    it('applies DEFAULT_MODEL override with gpt- prefix model', async () => {
      setEnv('OPENAI_API_KEY', 'sk-openai-test');
      setEnv('DEFAULT_MODEL', 'gpt-4o');
      const config = await loadModelConfig();
      expect(config.roles.agent).toBe('gpt-4o');
    });

    it('guesses openai provider for unknown gpt- model', async () => {
      setEnv('OPENAI_API_KEY', 'sk-openai-test');
      setEnv('DEFAULT_MODEL', 'gpt-4-turbo');
      const config = await loadModelConfig();
      expect(config.roles.agent).toBe('custom-agent');
      const adHoc = config.models.find(m => m.id === 'custom-agent');
      expect(adHoc!.provider).toBe('openai');
    });

    it('guesses openai provider for o3/o1 models', async () => {
      setEnv('OPENAI_API_KEY', 'sk-openai-test');
      setEnv('DEFAULT_MODEL', 'o1-preview');
      const config = await loadModelConfig();
      const adHoc = config.models.find(m => m.id === 'custom-agent');
      expect(adHoc!.provider).toBe('openai');
    });
  });

  describe('validateConfigShape() (tested indirectly through loadConfigFromFile)', () => {
    it('rejects non-object', async () => {
      mockReadFile.mockResolvedValue('"not an object"');
      setEnv('MODEL_ROUTER_CONFIG_PATH', '/bad.json');
      await expect(loadModelConfig()).rejects.toThrow('invalid config file');
    });

    it('rejects missing models array', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: { anthropic: { provider: 'anthropic' } },
        roles: { agent: 'x' },
      }));
      setEnv('MODEL_ROUTER_CONFIG_PATH', '/bad.json');
      await expect(loadModelConfig()).rejects.toThrow('invalid config file');
    });

    it('rejects model without provider field', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        providers: { anthropic: { provider: 'anthropic' } },
        models: [{ id: 'test', modelName: 'test-name' }],
        roles: { agent: 'test', observer: 'test' },
      }));
      setEnv('MODEL_ROUTER_CONFIG_PATH', '/bad.json');
      await expect(loadModelConfig()).rejects.toThrow('invalid config file');
    });
  });

  describe('OLLAMA_ENDPOINTS', () => {
    beforeEach(() => {
      setEnv('ANTHROPIC_API_KEY', 'sk-test-key'); // required for validateConfig()
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

  describe('validateConfig()', () => {
    it('throws when no providers configured', async () => {
      setEnv('ANTHROPIC_API_KEY', undefined);
      await expect(loadModelConfig()).rejects.toThrow('no providers configured');
    });

    it('throws when role references unknown model', async () => {
      const fileConfig = {
        providers: { anthropic: { provider: 'anthropic', apiKey: 'key' } },
        models: [{ id: 'model-a', modelName: 'model-a-name', provider: 'anthropic', maxTokens: 1024 }],
        roles: { agent: 'model-a', observer: 'nonexistent-model' },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(fileConfig));
      setEnv('MODEL_ROUTER_CONFIG_PATH', '/bad-role.json');
      await expect(loadModelConfig()).rejects.toThrow("role 'observer' references unknown model");
    });

    it('throws when model references unconfigured provider', async () => {
      const fileConfig = {
        providers: { anthropic: { provider: 'anthropic', apiKey: 'key' } },
        models: [
          { id: 'model-a', modelName: 'model-a-name', provider: 'anthropic', maxTokens: 1024 },
          { id: 'model-b', modelName: 'model-b-name', provider: 'ollama', maxTokens: 1024 },
        ],
        roles: { agent: 'model-a', observer: 'model-b' },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(fileConfig));
      setEnv('MODEL_ROUTER_CONFIG_PATH', '/bad-provider.json');
      await expect(loadModelConfig()).rejects.toThrow("model 'model-b' uses provider 'ollama' but no config exists");
    });

    it('validates fallback chain references', async () => {
      const fileConfig = {
        providers: { anthropic: { provider: 'anthropic', apiKey: 'key' } },
        models: [{ id: 'model-a', modelName: 'model-a-name', provider: 'anthropic', maxTokens: 1024 }],
        roles: { agent: 'model-a', observer: 'model-a' },
        fallbackChain: ['model-a', 'nonexistent'],
      };
      mockReadFile.mockResolvedValue(JSON.stringify(fileConfig));
      setEnv('MODEL_ROUTER_CONFIG_PATH', '/bad-fallback.json');
      await expect(loadModelConfig()).rejects.toThrow("fallback chain references unknown model id 'nonexistent'");
    });
  });
});
