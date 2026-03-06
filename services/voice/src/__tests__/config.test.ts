import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@bakerst/shared', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reads port from PORT env', async () => {
    process.env.PORT = '9999';
    process.env.BRAIN_URL = 'http://brain:3000';
    process.env.AUTH_TOKEN = 'test-token';
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();
    expect(config.port).toBe(9999);
  });

  it('defaults port to 3001', async () => {
    process.env.BRAIN_URL = 'http://brain:3000';
    process.env.AUTH_TOKEN = 'test-token';
    delete process.env.PORT;
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();
    expect(config.port).toBe(3001);
  });

  it('reads brainUrl from BRAIN_URL env', async () => {
    process.env.BRAIN_URL = 'http://custom-brain:4000';
    process.env.AUTH_TOKEN = 'test-token';
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();
    expect(config.brainUrl).toBe('http://custom-brain:4000');
  });

  it('reads authToken from AUTH_TOKEN env', async () => {
    process.env.BRAIN_URL = 'http://brain:3000';
    process.env.AUTH_TOKEN = 'secret-token';
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();
    expect(config.authToken).toBe('secret-token');
  });
});
