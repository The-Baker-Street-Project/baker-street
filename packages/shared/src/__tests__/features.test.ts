import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need fresh module state per test since features.ts exports a singleton.
// Use vi.resetModules() + dynamic import() in each test.

// Mock the logger to avoid pino output in tests
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

describe('features', () => {
  beforeEach(() => {
    vi.resetModules();
    // Clean all FEATURE_* and BAKERST_MODE env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('FEATURE_') || key === 'BAKERST_MODE') {
        delete process.env[key];
      }
    }
  });

  describe('mode resolution', () => {
    it('defaults to prod when BAKERST_MODE is unset', async () => {
      delete process.env.BAKERST_MODE;
      const { createFeatures } = await import('../features.js');
      const f = createFeatures();
      // In prod mode, all flags should be true
      expect(f.isEnabled('telegram')).toBe(true);
    });

    it('respects BAKERST_MODE=dev', async () => {
      process.env.BAKERST_MODE = 'dev';
      const { createFeatures } = await import('../features.js');
      const f = createFeatures();
      // telegram is off in dev
      expect(f.isEnabled('telegram')).toBe(false);
    });

    it('respects BAKERST_MODE=prod', async () => {
      process.env.BAKERST_MODE = 'prod';
      const { createFeatures } = await import('../features.js');
      const f = createFeatures();
      expect(f.isEnabled('telegram')).toBe(true);
    });
  });

  describe('prod defaults', () => {
    it('established flags are true in prod mode', async () => {
      process.env.BAKERST_MODE = 'prod';
      const { createFeatures } = await import('../features.js');
      const f = createFeatures();
      // Core established flags should all be true in prod
      expect(f.isEnabled('telegram')).toBe(true);
      expect(f.isEnabled('discord')).toBe(true);
      expect(f.isEnabled('mcp')).toBe(true);
      expect(f.isEnabled('scheduler')).toBe(true);
      expect(f.isEnabled('observer')).toBe(true);
      expect(f.isEnabled('memory')).toBe(true);
      expect(f.isEnabled('transferProtocol')).toBe(true);
      expect(f.isEnabled('telemetry')).toBe(true);
      // Opt-in flags default to false even in prod
      expect(f.isEnabled('taskPods')).toBe(false);
      expect(f.isEnabled('companions')).toBe(false);
    });
  });

  describe('dev defaults', () => {
    it('external services are off in dev mode', async () => {
      process.env.BAKERST_MODE = 'dev';
      const { createFeatures } = await import('../features.js');
      const f = createFeatures();
      expect(f.isEnabled('telegram')).toBe(false);
      expect(f.isEnabled('discord')).toBe(false);
      expect(f.isEnabled('mcp')).toBe(false);
      expect(f.isEnabled('scheduler')).toBe(false);
      expect(f.isEnabled('transferProtocol')).toBe(false);
      expect(f.isEnabled('telemetry')).toBe(false);
    });

    it('core features are on in dev mode', async () => {
      process.env.BAKERST_MODE = 'dev';
      const { createFeatures } = await import('../features.js');
      const f = createFeatures();
      expect(f.isEnabled('observer')).toBe(true);
      expect(f.isEnabled('memory')).toBe(true);
    });
  });

  describe('env var overrides', () => {
    it('FEATURE_TELEGRAM=true overrides dev default', async () => {
      process.env.BAKERST_MODE = 'dev';
      process.env.FEATURE_TELEGRAM = 'true';
      const { createFeatures } = await import('../features.js');
      const f = createFeatures();
      expect(f.isEnabled('telegram')).toBe(true);
    });

    it('FEATURE_MEMORY=false overrides prod default', async () => {
      process.env.BAKERST_MODE = 'prod';
      process.env.FEATURE_MEMORY = 'false';
      const { createFeatures } = await import('../features.js');
      const f = createFeatures();
      expect(f.isEnabled('memory')).toBe(false);
    });

    it('FEATURE_TRANSFER_PROTOCOL=true tests camelCase to SCREAMING_SNAKE conversion', async () => {
      process.env.BAKERST_MODE = 'dev';
      process.env.FEATURE_TRANSFER_PROTOCOL = 'true';
      const { createFeatures } = await import('../features.js');
      const f = createFeatures();
      expect(f.isEnabled('transferProtocol')).toBe(true);
    });
  });

  describe('allFlags()', () => {
    it('returns all resolved flag values', async () => {
      process.env.BAKERST_MODE = 'prod';
      const { createFeatures } = await import('../features.js');
      const f = createFeatures();
      const all = f.allFlags();
      expect(all).toEqual({
        telegram: true,
        discord: true,
        mcp: true,
        scheduler: true,
        observer: true,
        memory: true,
        transferProtocol: true,
        telemetry: true,
        taskPods: false,
        companions: false,
      });
    });

    it('returns dev values with overrides applied', async () => {
      process.env.BAKERST_MODE = 'dev';
      process.env.FEATURE_TELEGRAM = 'true';
      process.env.FEATURE_MEMORY = 'false';
      const { createFeatures } = await import('../features.js');
      const f = createFeatures();
      const all = f.allFlags();
      expect(all).toEqual({
        telegram: true,       // overridden
        discord: false,
        mcp: false,
        scheduler: false,
        observer: true,
        memory: false,         // overridden
        transferProtocol: false,
        telemetry: false,
        taskPods: false,
        companions: false,
      });
    });
  });

  describe('toEnvKey()', () => {
    it('converts camelCase flag names to FEATURE_SCREAMING_SNAKE', async () => {
      const { toEnvKey } = await import('../features.js');
      expect(toEnvKey('transferProtocol')).toBe('FEATURE_TRANSFER_PROTOCOL');
      expect(toEnvKey('telegram')).toBe('FEATURE_TELEGRAM');
    });
  });

  describe('unknown FEATURE_* env vars', () => {
    it('warns about unknown FEATURE_* env vars', async () => {
      process.env.FEATURE_NONEXISTENT = 'true';
      const { logger } = await import('../logger.js');
      const { createFeatures } = await import('../features.js');
      createFeatures();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ unknownVars: expect.arrayContaining(['FEATURE_NONEXISTENT']) }),
        expect.stringContaining('unknown'),
      );
    });
  });

  describe('singleton export', () => {
    it('exports a features singleton', async () => {
      const mod = await import('../features.js');
      expect(mod.features).toBeDefined();
      expect(typeof mod.features.isEnabled).toBe('function');
      expect(typeof mod.features.allFlags).toBe('function');
    });
  });
});
