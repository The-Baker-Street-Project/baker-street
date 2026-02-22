import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Flag registry — single source of truth for all feature flags
// ---------------------------------------------------------------------------

const FLAG_REGISTRY = {
  telegram:         { prod: true,  dev: false, desc: 'Telegram gateway adapter' },
  discord:          { prod: true,  dev: false, desc: 'Discord gateway adapter' },
  mcp:              { prod: true,  dev: false, desc: 'MCP plugin infrastructure' },
  scheduler:        { prod: true,  dev: false, desc: 'Cron schedule manager' },
  observer:         { prod: true,  dev: true,  desc: 'Post-turn memory compression' },
  memory:           { prod: true,  dev: true,  desc: 'Qdrant + Voyage vector memory' },
  transferProtocol: { prod: true,  dev: false, desc: 'Blue/green transfer protocol' },
  telemetry:        { prod: true,  dev: false, desc: 'OpenTelemetry tracing' },
  taskPods:         { prod: false, dev: false, desc: 'K8s Job-based task pod system' },
  companions:       { prod: false, dev: false, desc: 'Distributed Companions agent network' },
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Union of all known flag names. */
export type FeatureFlag = keyof typeof FLAG_REGISTRY;

/** Operating mode: prod (default) or dev. */
export type BakerstMode = 'prod' | 'dev';

/** Resolved feature flag interface. */
export interface Features {
  /** The active operating mode (prod or dev). */
  readonly mode: BakerstMode;
  /** Check if a specific feature flag is enabled. */
  isEnabled(flag: FeatureFlag): boolean;
  /** Return a snapshot of all resolved flag values. */
  allFlags(): Record<FeatureFlag, boolean>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a camelCase flag name to FEATURE_SCREAMING_SNAKE env var name.
 *
 * e.g. transferProtocol → FEATURE_TRANSFER_PROTOCOL
 */
export function toEnvKey(flag: string): string {
  const snake = flag.replace(/[A-Z]/g, (ch) => `_${ch}`).toUpperCase();
  return `FEATURE_${snake}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build a set of known env keys for detection of unknown FEATURE_* vars. */
function knownEnvKeys(): Set<string> {
  const keys = new Set<string>();
  for (const flag of Object.keys(FLAG_REGISTRY)) {
    keys.add(toEnvKey(flag));
  }
  return keys;
}

/**
 * Create a Features instance by resolving flags from:
 * 1. FEATURE_<SCREAMING_SNAKE> env var override (if set)
 * 2. Mode profile default from FLAG_REGISTRY
 *
 * Mode is determined by BAKERST_MODE env var; defaults to 'prod'.
 */
export function createFeatures(): Features {
  const mode: BakerstMode = (process.env.BAKERST_MODE as BakerstMode) || 'prod';

  const resolved: Record<string, boolean> = {};
  const known = knownEnvKeys();

  for (const [flag, config] of Object.entries(FLAG_REGISTRY)) {
    const envKey = toEnvKey(flag);
    const envVal = process.env[envKey];

    if (envVal !== undefined) {
      // Env var override: treat 'true'/'1' as true, everything else as false
      resolved[flag] = envVal === 'true' || envVal === '1';
    } else {
      // Mode profile default
      resolved[flag] = config[mode];
    }
  }

  // Warn about unknown FEATURE_* env vars
  const unknownVars: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FEATURE_') && !known.has(key)) {
      unknownVars.push(key);
    }
  }
  if (unknownVars.length > 0) {
    logger.warn({ unknownVars }, 'unknown FEATURE_* env vars detected — these have no effect');
  }

  // Log resolved flags
  logger.info({ mode, flags: resolved }, 'feature flags resolved');

  return {
    mode,
    isEnabled(flag: FeatureFlag): boolean {
      return resolved[flag] ?? false;
    },
    allFlags(): Record<FeatureFlag, boolean> {
      return { ...resolved } as Record<FeatureFlag, boolean>;
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton (convenience export)
// ---------------------------------------------------------------------------

export const features: Features = createFeatures();
