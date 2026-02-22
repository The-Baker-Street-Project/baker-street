import { readFileSync } from 'node:fs';

export interface CompanionConfig {
  id: string;
  nats: {
    url: string;
    credentials?: string;
  };
  capabilities: string[];
  paths: string[];
  maxConcurrent: number;
  anthropic?: {
    apiKey?: string;
  };
  otel?: {
    endpoint?: string;
  };
}

export function loadConfig(configPath?: string): CompanionConfig {
  const filePath = configPath ?? process.env.COMPANION_CONFIG ?? '/config/companion.json';
  const raw = readFileSync(filePath, 'utf-8');
  const config = JSON.parse(raw) as CompanionConfig;

  // Resolve env var references (e.g., "${ANTHROPIC_API_KEY}")
  if (config.anthropic?.apiKey?.startsWith('${') && config.anthropic.apiKey.endsWith('}')) {
    const envVar = config.anthropic.apiKey.slice(2, -1);
    config.anthropic.apiKey = process.env[envVar];
  }

  // Defaults
  config.maxConcurrent = config.maxConcurrent ?? 2;
  config.capabilities = config.capabilities ?? ['filesystem'];
  config.paths = config.paths ?? [];

  return config;
}
