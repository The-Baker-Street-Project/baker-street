import { logger } from './logger.js';
import type { ModelDefinition } from './model-types.js';

const log = logger.child({ module: 'ollama-discovery' });

const DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TOKENS = 4096;

interface OllamaTagsResponse {
  models: Array<{ name: string; size: number }>;
}

interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
}

/**
 * Query an Ollama endpoint's /api/tags to discover locally-available models,
 * then return them as ModelDefinition[] ready to merge into the ModelRouter config.
 *
 * Non-fatal: returns [] on any network or API error so the brain can start
 * even if Ollama is unreachable.
 */
export async function discoverOllamaModels(
  baseURL: string,
  providerKey: string,
): Promise<ModelDefinition[]> {
  // Strip /v1 suffix if present — Ollama native API lives at /api/*
  const ollamaBase = baseURL.replace(/\/v1\/?$/, '');

  let tagsResponse: OllamaTagsResponse;
  try {
    const res = await fetch(`${ollamaBase}/api/tags`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn({ baseURL, status: res.status }, 'Ollama /api/tags returned non-OK');
      return [];
    }
    tagsResponse = (await res.json()) as OllamaTagsResponse;
  } catch (err) {
    log.warn({ baseURL, err: (err as Error).message }, 'Ollama endpoint unreachable — skipping discovery');
    return [];
  }

  if (!tagsResponse.models || tagsResponse.models.length === 0) {
    log.info({ baseURL }, 'Ollama endpoint has no models');
    return [];
  }

  const models: ModelDefinition[] = [];

  for (const model of tagsResponse.models) {
    const shortName = model.name.split(':')[0];
    const id = `${providerKey}:${shortName}`;

    // Attempt to fetch context length via /api/show (non-fatal)
    try {
      const showRes = await fetch(`${ollamaBase}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model.name }),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (showRes.ok) {
        const showData = (await showRes.json()) as OllamaShowResponse;
        const ctx = showData.model_info?.['context_length'];
        if (typeof ctx === 'number') {
          // We have context_length but still use DEFAULT_MAX_TOKENS for response maxTokens
          // (context_length is the window size, not the output limit)
        }
      }
    } catch {
      // Non-fatal — use defaults
    }

    models.push({
      id,
      modelName: model.name,
      provider: providerKey,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  }

  log.info(
    { baseURL, providerKey, modelCount: models.length, models: models.map((m) => m.id) },
    'discovered Ollama models',
  );

  return models;
}
