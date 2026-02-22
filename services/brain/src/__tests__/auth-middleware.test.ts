import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mock modules that createApi imports
// ---------------------------------------------------------------------------

vi.mock('../db.js', () => ({
  listConversations: vi.fn().mockReturnValue([]),
  getConversation: vi.fn(),
  getMessages: vi.fn().mockReturnValue([]),
}));

vi.mock('../k8s-client.js', () => ({
  getSecrets: vi.fn().mockResolvedValue({}),
  updateSecrets: vi.fn().mockResolvedValue(undefined),
  restartDeployment: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createApi } from '../api.js';

// ---------------------------------------------------------------------------
// Stubs for createApi dependencies
// ---------------------------------------------------------------------------

function makeApp(token?: string) {
  // Set AUTH_TOKEN before creating app
  if (token !== undefined) {
    process.env.AUTH_TOKEN = token;
  } else {
    delete process.env.AUTH_TOKEN;
  }

  const mockDispatcher = { dispatch: vi.fn().mockResolvedValue({ jobId: 'j1' }) } as any;
  const mockStatusTracker = {
    getAllStatuses: vi.fn().mockReturnValue([]),
    getStatus: vi.fn(),
  } as any;
  const mockAgent = {
    chat: vi.fn().mockResolvedValue({ content: 'hi' }),
    chatStream: vi.fn(),
  } as any;
  const mockMemoryService = {
    search: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    store: vi.fn(),
    remove: vi.fn(),
  } as any;
  const mockPluginRegistry = {
    allTools: vi.fn().mockReturnValue([]),
    hasPlugin: vi.fn().mockReturnValue(false),
    execute: vi.fn(),
    handleTrigger: vi.fn(),
    shutdown: vi.fn(),
  } as any;

  return createApi(mockDispatcher, mockStatusTracker, mockAgent, mockMemoryService, mockPluginRegistry);
}

// ---------------------------------------------------------------------------
// Environment management
// ---------------------------------------------------------------------------

const originalToken = process.env.AUTH_TOKEN;

afterEach(() => {
  if (originalToken !== undefined) {
    process.env.AUTH_TOKEN = originalToken;
  } else {
    delete process.env.AUTH_TOKEN;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth middleware', () => {
  const TOKEN = 'test-token-abc123';

  describe('when AUTH_TOKEN is set', () => {
    it('returns 401 when no Authorization header', async () => {
      const app = makeApp(TOKEN);
      const res = await request(app).get('/jobs');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 401 when Authorization header has wrong format (not Bearer)', async () => {
      const app = makeApp(TOKEN);
      const res = await request(app)
        .get('/jobs')
        .set('Authorization', `Basic ${TOKEN}`);
      expect(res.status).toBe(401);
    });

    it('returns 401 when token is invalid', async () => {
      const app = makeApp(TOKEN);
      const res = await request(app)
        .get('/jobs')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(401);
    });

    it('returns 200 for valid token', async () => {
      const app = makeApp(TOKEN);
      const res = await request(app)
        .get('/jobs')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
    });
  });

  describe('/ping bypass', () => {
    it('/ping returns 200 without token', async () => {
      const app = makeApp(TOKEN);
      const res = await request(app).get('/ping');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('brain');
    });
  });

  describe('dev mode', () => {
    it('allows requests when AUTH_TOKEN not set', async () => {
      const app = makeApp(undefined);
      const res = await request(app).get('/jobs');
      expect(res.status).toBe(200);
    });
  });

  describe('CORS', () => {
    it('CORS headers are set on responses', async () => {
      const app = makeApp(TOKEN);
      const res = await request(app)
        .get('/ping');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('GET');
    });

    it('OPTIONS requests return 204', async () => {
      const app = makeApp(TOKEN);
      const res = await request(app).options('/jobs');
      expect(res.status).toBe(204);
    });
  });

  describe('safeCompare (tested via behavior)', () => {
    it('rejects different-length tokens', async () => {
      const app = makeApp(TOKEN);
      const res = await request(app)
        .get('/jobs')
        .set('Authorization', 'Bearer x');
      expect(res.status).toBe(401);
    });

    it('accepts matching tokens', async () => {
      const app = makeApp(TOKEN);
      const res = await request(app)
        .get('/jobs')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
    });
  });
});
