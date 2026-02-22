/**
 * Model configuration loader.
 *
 * Builds a ModelRouterConfig from:
 *   1. A JSON file at MODEL_ROUTER_CONFIG_PATH (optional)
 *   2. Environment variable overrides: DEFAULT_MODEL, OBSERVER_MODEL, OPENROUTER_API_KEY
 *   3. Sensible defaults that exactly reproduce the current hardcoded behaviour
 */

import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import type {
  ModelRouterConfig,
  ModelDefinition,
  ProviderConfig,
  ModelRoles,
} from './model-types.js';

const log = logger.child({ module: 'model-config' });

// ---------------------------------------------------------------------------
// Default configuration — matches the pre-router hardcoded behaviour
// ---------------------------------------------------------------------------

function defaultProviders(): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};

  const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (oauthToken || apiKey) {
    providers['anthropic'] = {
      provider: 'anthropic',
      oauthToken: oauthToken || undefined,
      apiKey: apiKey || undefined,
    };
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    providers['openrouter'] = {
      provider: 'openrouter',
      apiKey: openRouterKey,
    };
  }

  return providers;
}

function defaultModels(): ModelDefinition[] {
  return [
    {
      id: 'sonnet-4',
      modelName: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      maxTokens: 4096,
      costPer1MInput: 3,
      costPer1MOutput: 15,
    },
    {
      id: 'haiku-4.5',
      modelName: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      maxTokens: 2048,
      costPer1MInput: 0.8,
      costPer1MOutput: 4,
    },
  ];
}

function defaultRoles(): ModelRoles {
  return {
    agent: 'sonnet-4',
    observer: 'haiku-4.5',
  };
}

export function createDefaultConfig(): ModelRouterConfig {
  return {
    providers: defaultProviders(),
    models: defaultModels(),
    roles: defaultRoles(),
  };
}

// ---------------------------------------------------------------------------
// Runtime config shape validation (Finding 3 fix)
// ---------------------------------------------------------------------------

function validateConfigShape(parsed: unknown): parsed is ModelRouterConfig {
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  if (!obj.providers || typeof obj.providers !== 'object') return false;
  if (!Array.isArray(obj.models)) return false;
  if (!obj.roles || typeof obj.roles !== 'object') return false;
  // Check each model has required fields
  for (const m of obj.models) {
    if (!m || typeof m !== 'object') return false;
    const model = m as Record<string, unknown>;
    if (!model.name && !model.id) return false;
    if (!model.provider) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// File-based config loading
// ---------------------------------------------------------------------------

async function loadConfigFromFile(path: string): Promise<ModelRouterConfig> {
  const raw = await readFile(path, 'utf-8');
  const parsed: unknown = JSON.parse(raw);

  if (!validateConfigShape(parsed)) {
    throw new Error(
      `model-config: invalid config file at '${path}'. ` +
        'Expected an object with "providers" (object), "models" (array of objects with id/name and provider), and "roles" (object).',
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Environment variable overrides
// ---------------------------------------------------------------------------

function applyEnvOverrides(config: ModelRouterConfig): ModelRouterConfig {
  // DEFAULT_MODEL overrides the agent role — can be a model ID or raw model name
  const defaultModel = process.env.DEFAULT_MODEL;
  if (defaultModel) {
    const existing = config.models.find(
      (m) => m.id === defaultModel || m.modelName === defaultModel,
    );
    if (existing) {
      config.roles.agent = existing.id;
    } else {
      // Treat as a raw model name and add an ad-hoc model definition
      const adHocId = `custom-agent`;
      config.models.push({
        id: adHocId,
        modelName: defaultModel,
        provider: guessProvider(defaultModel, config),
        maxTokens: 4096,
      });
      config.roles.agent = adHocId;
    }
    log.info({ defaultModel, agentRole: config.roles.agent }, 'DEFAULT_MODEL override applied');
  }

  // OBSERVER_MODEL overrides the observer role
  const observerModel = process.env.OBSERVER_MODEL;
  if (observerModel) {
    const existing = config.models.find(
      (m) => m.id === observerModel || m.modelName === observerModel,
    );
    if (existing) {
      config.roles.observer = existing.id;
    } else {
      const adHocId = `custom-observer`;
      config.models.push({
        id: adHocId,
        modelName: observerModel,
        provider: guessProvider(observerModel, config),
        maxTokens: 2048,
      });
      config.roles.observer = adHocId;
    }
    log.info({ observerModel, observerRole: config.roles.observer }, 'OBSERVER_MODEL override applied');
  }

  // OPENROUTER_API_KEY — ensure provider entry exists
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey && !config.providers['openrouter']) {
    config.providers['openrouter'] = {
      provider: 'openrouter',
      apiKey: openRouterKey,
    };
  }

  return config;
}

/** Best-effort guess of provider based on model name, validated against config */
function guessProvider(
  modelName: string,
  config: ModelRouterConfig,
): 'anthropic' | 'openrouter' | 'ollama' | 'openai-compatible' {
  let guessed: 'anthropic' | 'openrouter' | 'ollama' | 'openai-compatible';

  if (modelName.startsWith('claude')) {
    guessed = 'anthropic';
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateConfig(config: ModelRouterConfig): void {
  if (Object.keys(config.providers).length === 0) {
    throw new Error(
      'model-config: no providers configured. Set ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY at minimum.',
    );
  }

  // Verify each role points to a known model
  for (const [role, modelId] of Object.entries(config.roles)) {
    if (!modelId) continue;
    const model = config.models.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(
        `model-config: role '${role}' references unknown model id '${modelId}'. ` +
          `Available models: ${config.models.map((m) => m.id).join(', ')}`,
      );
    }
    // Verify the model's provider is configured
    if (!config.providers[model.provider]) {
      throw new Error(
        `model-config: model '${model.id}' uses provider '${model.provider}' but no config exists for that provider.`,
      );
    }
  }

  // Verify fallback chain references valid models
  if (config.fallbackChain) {
    for (const modelId of config.fallbackChain) {
      if (!config.models.find((m) => m.id === modelId)) {
        throw new Error(
          `model-config: fallback chain references unknown model id '${modelId}'.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and return a fully resolved ModelRouterConfig.
 *
 * Resolution order:
 *   1. If MODEL_ROUTER_CONFIG_PATH is set, load from that JSON file
 *   2. Otherwise use built-in defaults (current hardcoded models)
 *   3. Apply env-var overrides (DEFAULT_MODEL, OBSERVER_MODEL, OPENROUTER_API_KEY)
 *   4. Validate the final config
 */
export async function loadModelConfig(): Promise<ModelRouterConfig> {
  let config: ModelRouterConfig;

  const configPath = process.env.MODEL_ROUTER_CONFIG_PATH;
  if (configPath) {
    log.info({ configPath }, 'loading model router config from file');
    config = await loadConfigFromFile(configPath);
  } else {
    log.info('using default model router config');
    config = createDefaultConfig();
  }

  config = applyEnvOverrides(config);
  validateConfig(config);

  log.info(
    {
      providers: Object.keys(config.providers),
      models: config.models.map((m) => m.id),
      roles: config.roles,
    },
    'model router config loaded',
  );

  return config;
}
