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
    setEnv('ANTHROPIC_OAUTH_TOKEN', undefined);
    setEnv('OPENROUTER_API_KEY', undefined);
    setEnv('MODEL_ROUTER_CONFIG_PATH', undefined);
    setEnv('DEFAULT_MODEL', undefined);
    setEnv('OBSERVER_MODEL', undefined);
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

    it('includes anthropic provider when ANTHROPIC_OAUTH_TOKEN is set', () => {
      setEnv('ANTHROPIC_API_KEY', undefined);
      setEnv('ANTHROPIC_OAUTH_TOKEN', 'sk-ant-oat-test');
      const config = createDefaultConfig();
      expect(config.providers).toHaveProperty('anthropic');
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

    it('applies DEFAULT_MODEL override with unknown model as ad-hoc', async () => {
      setEnv('DEFAULT_MODEL', 'claude-opus-4-20250514');
      const config = await loadModelConfig();
      expect(config.roles.agent).toBe('custom-agent');
      const adHoc = config.models.find((m) => m.id === 'custom-agent');
      expect(adHoc).toBeDefined();
      expect(adHoc!.modelName).toBe('claude-opus-4-20250514');
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

  describe('validateConfig()', () => {
    it('throws when no providers configured', async () => {
      setEnv('ANTHROPIC_API_KEY', undefined);
      setEnv('ANTHROPIC_OAUTH_TOKEN', undefined);
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
