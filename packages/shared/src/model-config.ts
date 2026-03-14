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
import { discoverOllamaModels } from './ollama-discovery.js';
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    providers['anthropic'] = {
      provider: 'anthropic',
      apiKey,
    };
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    providers['openrouter'] = {
      provider: 'openrouter',
      apiKey: openRouterKey,
    };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    providers['openai'] = {
      provider: 'openai',
      apiKey: openaiKey,
    };
  }

  // Ollama endpoints — OLLAMA_ENDPOINTS=host1:port1,host2:port2
  const OLLAMA_ENDPOINT_PATTERN = /^[\w.-]+:\d{1,5}$/;

  const ollamaEndpoints = process.env.OLLAMA_ENDPOINTS;
  if (ollamaEndpoints) {
    const endpoints = ollamaEndpoints.split(',').map(e => e.trim()).filter(Boolean);
    const seenHosts = new Set<string>();
    for (const endpoint of endpoints) {
      if (!OLLAMA_ENDPOINT_PATTERN.test(endpoint)) {
        log.warn({ endpoint }, 'skipping invalid OLLAMA_ENDPOINTS entry (expected host:port)');
        continue;
      }
      const host = endpoint.split(':')[0];
      const isLocalhost = host === 'localhost' || host === '127.0.0.1';
      // Include port in key when multiple endpoints share the same host
      const needsPort = seenHosts.has(host);
      seenHosts.add(host);
      const key = isLocalhost
        ? (needsPort ? `ollama:${endpoint.split(':')[1]}` : 'ollama')
        : `ollama@${needsPort ? endpoint : host}`;
      providers[key] = {
        provider: 'ollama',
        baseURL: `http://${endpoint}/v1`,
      };
    }
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
      id: 'opus-4',
      modelName: 'claude-opus-4-20250514',
      provider: 'anthropic',
      maxTokens: 4096,
      costPer1MInput: 15,
      costPer1MOutput: 75,
    },
    {
      id: 'haiku-4.5',
      modelName: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      maxTokens: 2048,
      costPer1MInput: 0.8,
      costPer1MOutput: 4,
    },
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
    // OpenRouter models (only included when OPENROUTER_API_KEY is set)
    ...(process.env.OPENROUTER_API_KEY
      ? [
          {
            id: 'gemini-flash',
            modelName: 'google/gemini-2.5-flash',
            provider: 'openrouter' as const,
            maxTokens: 8192,
            costPer1MInput: 0.3,
            costPer1MOutput: 2.5,
          },
          {
            id: 'gemini-pro',
            modelName: 'google/gemini-2.5-pro-preview',
            provider: 'openrouter' as const,
            maxTokens: 8192,
            costPer1MInput: 1.25,
            costPer1MOutput: 10,
          },
          {
            id: 'or-sonnet-4',
            modelName: 'anthropic/claude-sonnet-4',
            provider: 'openrouter' as const,
            maxTokens: 4096,
            costPer1MInput: 3,
            costPer1MOutput: 15,
          },
          {
            id: 'or-haiku-4.5',
            modelName: 'anthropic/claude-haiku-4-5',
            provider: 'openrouter' as const,
            maxTokens: 2048,
            costPer1MInput: 0.8,
            costPer1MOutput: 4,
          },
        ]
      : []),
  ];
}

function defaultRoles(): ModelRoles {
  return {
    agent: 'sonnet-4',
    observer: 'haiku-4.5',
    reflector: 'sonnet-4',
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

  // REFLECTOR_MODEL overrides the reflector role
  const reflectorModel = process.env.REFLECTOR_MODEL;
  if (reflectorModel) {
    const existing = config.models.find(
      (m) => m.id === reflectorModel || m.modelName === reflectorModel,
    );
    if (existing) {
      config.roles.reflector = existing.id;
    } else {
      const adHocId = `custom-reflector`;
      config.models.push({
        id: adHocId,
        modelName: reflectorModel,
        provider: guessProvider(reflectorModel, config),
        maxTokens: 4096,
      });
      config.roles.reflector = adHocId;
    }
    log.info({ reflectorModel, reflectorRole: config.roles.reflector }, 'REFLECTOR_MODEL override applied');
  }

  // WORKER_MODEL overrides the worker role
  const workerModel = process.env.WORKER_MODEL;
  if (workerModel) {
    const existing = config.models.find(
      (m) => m.id === workerModel || m.modelName === workerModel,
    );
    if (existing) {
      config.roles.worker = existing.id;
    } else {
      // When multiple ollama endpoints exist, prefer one not already used by agent
      const agentModel = config.models.find(m => m.id === config.roles.agent);
      const agentProvider = agentModel?.provider;
      const adHocId = `custom-worker`;
      config.models.push({
        id: adHocId,
        modelName: workerModel,
        provider: guessProvider(workerModel, config, agentProvider),
        maxTokens: 4096,
      });
      config.roles.worker = adHocId;
    }
    log.info({ workerModel, workerRole: config.roles.worker }, 'WORKER_MODEL override applied');
  }

  // OPENROUTER_API_KEY — ensure provider entry exists
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey && !config.providers['openrouter']) {
    config.providers['openrouter'] = {
      provider: 'openrouter',
      apiKey: openRouterKey,
    };
  }

  // FALLBACK_STRATEGY — set fallback ordering
  const fallbackStrategy = process.env.FALLBACK_STRATEGY;
  if (fallbackStrategy === 'cheapest-first' || fallbackStrategy === 'configured') {
    config.fallbackStrategy = fallbackStrategy;
    log.info({ fallbackStrategy }, 'FALLBACK_STRATEGY override applied');
  }

  return config;
}

/**
 * Best-effort guess of provider based on model name, validated against config.
 * When excludeProvider is set, prefers a different ollama endpoint (for worker
 * routing to a separate model server than the agent).
 */
function guessProvider(
  modelName: string,
  config: ModelRouterConfig,
  excludeProvider?: string,
): string {
  let guessed: string;

  if (modelName.startsWith('claude') && !modelName.includes('/')) {
    guessed = 'anthropic';
  } else if (modelName.startsWith('gpt-') || modelName.startsWith('o1') || modelName.startsWith('o3')) {
    guessed = 'openai';
  } else if (modelName.includes('/') || modelName.startsWith('gemini') || modelName.startsWith('google/')) {
    // Slash-prefixed model names (e.g. google/gemini-2.5-flash) or gemini-* → OpenRouter
    guessed = 'openrouter';
  } else if (config.providers['openrouter']) {
    guessed = 'openrouter';
  } else if (Object.keys(config.providers).find(k => k.startsWith('ollama'))) {
    const ollamaKeys = Object.keys(config.providers).filter(k => k.startsWith('ollama'));
    // Prefer an ollama provider that isn't already taken by the agent
    const preferred = excludeProvider
      ? ollamaKeys.find(k => k !== excludeProvider) ?? ollamaKeys[0]
      : ollamaKeys[0];
    guessed = preferred;
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
// Pruning — remove models whose provider is not configured
// ---------------------------------------------------------------------------

function pruneUnavailableModels(config: ModelRouterConfig): ModelRouterConfig {
  const availableProviders = new Set(Object.keys(config.providers));

  // Remove models whose provider is missing
  const prunedModels = config.models.filter((m) => {
    if (availableProviders.has(m.provider)) return true;
    log.info(
      { model: m.id, provider: m.provider },
      'pruning model — provider not configured',
    );
    return false;
  });

  const availableModelIds = new Set(prunedModels.map((m) => m.id));

  // Reassign roles that pointed to pruned models
  const prunedRoles = { ...config.roles };
  const firstAvailable = prunedModels[0]?.id;
  for (const [role, modelId] of Object.entries(prunedRoles)) {
    if (modelId && !availableModelIds.has(modelId)) {
      const fallback = firstAvailable ?? null;
      log.info(
        { role, was: modelId, now: fallback },
        'reassigning role — model was pruned',
      );
      (prunedRoles as Record<string, string | undefined>)[role] = fallback ?? undefined;
    }
  }

  // Prune fallback chain
  const prunedFallback = config.fallbackChain?.filter((id) =>
    availableModelIds.has(id),
  );

  return {
    ...config,
    models: prunedModels,
    roles: prunedRoles,
    fallbackChain: prunedFallback,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateConfig(config: ModelRouterConfig): void {
  if (Object.keys(config.providers).length === 0) {
    throw new Error(
      'model-config: no providers configured. Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, OLLAMA_ENDPOINTS.',
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
 * Discover models from all configured ollama/OpenAI-compatible endpoints.
 * Runs before env overrides so DEFAULT_MODEL / WORKER_MODEL can match
 * discovered models by name and get the correct provider automatically.
 */
async function discoverEndpointModels(config: ModelRouterConfig): Promise<ModelRouterConfig> {
  const ollamaProviders = Object.entries(config.providers).filter(
    ([, p]) => p.provider === 'ollama' && 'baseURL' in p,
  );
  if (ollamaProviders.length === 0) return config;

  const discoveryResults = await Promise.all(
    ollamaProviders.map(([key, p]) =>
      discoverOllamaModels((p as { baseURL: string }).baseURL, key),
    ),
  );
  const discovered = discoveryResults.flat();
  if (discovered.length === 0) return config;

  const models = [...config.models];
  for (const model of discovered) {
    if (!models.find((m) => m.id === model.id)) {
      models.push(model);
    }
  }
  return { ...config, models };
}

/**
 * Load and return a fully resolved ModelRouterConfig.
 *
 * Resolution order:
 *   1. If MODEL_ROUTER_CONFIG_PATH is set, load from that JSON file
 *   2. Otherwise use built-in defaults (current hardcoded models)
 *   3. Discover models from ollama/OpenAI-compatible endpoints
 *   4. Apply env-var overrides (DEFAULT_MODEL, OBSERVER_MODEL, OPENROUTER_API_KEY)
 *   5. Validate the final config
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

  config = await discoverEndpointModels(config);
  config = applyEnvOverrides(config);
  config = pruneUnavailableModels(config);
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
