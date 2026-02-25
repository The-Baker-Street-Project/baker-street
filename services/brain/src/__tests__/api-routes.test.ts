import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Hoisted mock references
// ---------------------------------------------------------------------------

const {
  mockListSkills,
  mockGetSkill,
  mockUpsertSkill,
  mockDeleteSkill,
  mockGetDb,
  mockGetModelConfigValue,
  mockSetModelConfigValue,
  mockListConversations,
  mockGetConversation,
  mockGetMessages,
} = vi.hoisted(() => ({
  mockListSkills: vi.fn().mockReturnValue([]),
  mockGetSkill: vi.fn(),
  mockUpsertSkill: vi.fn(),
  mockDeleteSkill: vi.fn().mockReturnValue(true),
  mockGetDb: vi.fn().mockReturnValue({}),
  mockGetModelConfigValue: vi.fn(),
  mockSetModelConfigValue: vi.fn(),
  mockListConversations: vi.fn().mockReturnValue([]),
  mockGetConversation: vi.fn(),
  mockGetMessages: vi.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Mock modules that createApi imports
// ---------------------------------------------------------------------------

vi.mock('../db.js', () => ({
  listConversations: mockListConversations,
  getConversation: mockGetConversation,
  getMessages: mockGetMessages,
  listSkills: mockListSkills,
  getSkill: mockGetSkill,
  upsertSkill: mockUpsertSkill,
  deleteSkill: mockDeleteSkill,
  getDb: mockGetDb,
  getModelConfigValue: mockGetModelConfigValue,
  setModelConfigValue: mockSetModelConfigValue,
}));

vi.mock('../k8s-client.js', () => ({
  getSecrets: vi.fn().mockResolvedValue({}),
  updateSecrets: vi.fn().mockResolvedValue(undefined),
  restartDeployment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../skill-loader.js', () => ({
  reloadInstructionSkills: vi.fn(),
}));

vi.mock('../agent.js', () => ({
  clearSystemPromptCache: vi.fn(),
  clearToolsCache: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createApi } from '../api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalToken = process.env.AUTH_TOKEN;

function makeApp(opts?: {
  token?: string;
  modelRouter?: any;
  nc?: any;
  mcpClient?: any;
  skillRegistry?: any;
}) {
  // Run in dev mode (no auth) unless token specified
  if (opts?.token !== undefined) {
    process.env.AUTH_TOKEN = opts.token;
  } else {
    delete process.env.AUTH_TOKEN;
  }

  const mockDispatcher = {
    dispatch: vi.fn().mockResolvedValue({ jobId: 'j1' }),
  } as any;

  const mockStatusTracker = {
    getAllStatuses: vi.fn().mockReturnValue([]),
    getStatus: vi.fn(),
  } as any;

  const mockAgent = {
    chat: vi.fn().mockResolvedValue({ response: 'hi', conversationId: 'c1', jobIds: [], toolCallCount: 0 }),
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

  return createApi(
    mockDispatcher,
    mockStatusTracker,
    mockAgent,
    mockMemoryService,
    mockPluginRegistry,
    opts?.skillRegistry,
    opts?.mcpClient,
    opts?.modelRouter,
    opts?.nc,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  if (originalToken !== undefined) {
    process.env.AUTH_TOKEN = originalToken;
  } else {
    delete process.env.AUTH_TOKEN;
  }
});

// ---------------------------------------------------------------------------
// Tests: Skills CRUD
// ---------------------------------------------------------------------------

describe('Skills API', () => {
  it('GET /skills returns list of skills', async () => {
    mockListSkills.mockReturnValue([
      {
        id: 'skill-1',
        name: 'Test Skill',
        version: '1.0.0',
        description: 'A skill',
        tier: 'stdio',
        enabled: true,
        config: {},
      },
    ]);

    const app = makeApp();
    const res = await request(app).get('/skills');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('skill-1');
    expect(res.body[0].connected).toBe(false);
    expect(res.body[0].toolCount).toBe(0);
  });

  it('POST /skills creates a new skill', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/skills')
      .send({
        name: 'New Skill',
        description: 'A new skill',
        tier: 'stdio',
        transport: 'stdio',
        stdioCommand: 'node',
        stdioArgs: ['server.js'],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('new-skill');
    expect(res.body.name).toBe('New Skill');
    expect(mockUpsertSkill).toHaveBeenCalled();
  });

  it('POST /skills returns 400 when required fields missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/skills')
      .send({ name: 'Incomplete' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name, description, and tier are required');
  });

  it('POST /skills returns 400 for invalid tier', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/skills')
      .send({ name: 'Bad Tier', description: 'test', tier: 'invalid' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('tier must be one of');
  });

  it('GET /skills/:id returns skill by ID', async () => {
    mockGetSkill.mockReturnValue({
      id: 'skill-1',
      name: 'Test',
      version: '1.0.0',
      description: 'desc',
      tier: 'stdio',
      enabled: true,
      config: {},
    });

    const app = makeApp();
    const res = await request(app).get('/skills/skill-1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('skill-1');
  });

  it('GET /skills/:id returns 404 for nonexistent skill', async () => {
    mockGetSkill.mockReturnValue(undefined);

    const app = makeApp();
    const res = await request(app).get('/skills/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('skill not found');
  });

  it('DELETE /skills/:id deletes skill', async () => {
    mockGetSkill.mockReturnValue({
      id: 'skill-1',
      name: 'Test',
      tier: 'stdio',
    });
    mockDeleteSkill.mockReturnValue(true);

    const app = makeApp();
    const res = await request(app).delete('/skills/skill-1');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockDeleteSkill).toHaveBeenCalledWith('skill-1');
  });

  it('DELETE /skills/:id returns 404 for nonexistent skill', async () => {
    mockDeleteSkill.mockReturnValue(false);

    const app = makeApp();
    const res = await request(app).delete('/skills/nonexistent');

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests: Models config
// ---------------------------------------------------------------------------

describe('Models API', () => {
  it('GET /models returns empty array when no model router', async () => {
    const app = makeApp();
    const res = await request(app).get('/models');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /models/config returns router config with masked credentials', async () => {
    const mockRouter = {
      routerConfig: {
        providers: {
          anthropic: { provider: 'anthropic', apiKey: 'sk-secret-key-123' },
        },
        models: [{ id: 'sonnet', modelName: 'claude-sonnet-4', provider: 'anthropic', maxTokens: 4096 }],
        roles: { agent: 'sonnet', observer: 'sonnet' },
        fallbackChain: ['sonnet'],
      },
      updateConfig: vi.fn(),
    };

    const app = makeApp({ modelRouter: mockRouter });
    const res = await request(app).get('/models/config');

    expect(res.status).toBe(200);
    expect(res.body.providers.anthropic.apiKey).toBe('***');
    expect(res.body.models).toHaveLength(1);
    expect(res.body.roles.agent).toBe('sonnet');
  });

  it('GET /models/config returns empty object when no router', async () => {
    const app = makeApp();
    const res = await request(app).get('/models/config');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Tests: System health
// ---------------------------------------------------------------------------

describe('System health', () => {
  it('GET /system/health returns brain healthy and unknown for others when no nc', async () => {
    const app = makeApp();
    const res = await request(app).get('/system/health');

    expect(res.status).toBe(200);
    expect(res.body.brain.status).toBe('healthy');
    expect(res.body.nats.status).toBe('unknown');
  });

  it('GET /system/health reports NATS as healthy when connection open', async () => {
    const mockNc = {
      isClosed: vi.fn().mockReturnValue(false),
      subscribe: vi.fn(),
    };

    const app = makeApp({ nc: mockNc });
    const res = await request(app).get('/system/health');

    expect(res.status).toBe(200);
    expect(res.body.nats.status).toBe('healthy');
  });

  it('GET /system/health reports NATS as unhealthy when connection closed', async () => {
    const mockNc = {
      isClosed: vi.fn().mockReturnValue(true),
      subscribe: vi.fn(),
    };

    const app = makeApp({ nc: mockNc });
    const res = await request(app).get('/system/health');

    expect(res.status).toBe(200);
    expect(res.body.nats.status).toBe('unhealthy');
    expect(res.body.nats.detail).toBe('connection closed');
  });
});

// ---------------------------------------------------------------------------
// Tests: CORS headers
// ---------------------------------------------------------------------------

describe('CORS', () => {
  it('sets CORS headers on responses', async () => {
    const app = makeApp();
    const res = await request(app).get('/ping');

    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('OPTIONS returns 204 with CORS headers', async () => {
    const app = makeApp();
    const res = await request(app).options('/skills');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
  });
});

// ---------------------------------------------------------------------------
// Tests: Auth middleware (brief, since auth-middleware.test.ts covers it deeply)
// ---------------------------------------------------------------------------

describe('Auth integration', () => {
  it('returns 401 for protected route without token', async () => {
    const app = makeApp({ token: 'secret-token' });
    const res = await request(app).get('/skills');
    expect(res.status).toBe(401);
  });

  it('allows access with valid Bearer token', async () => {
    const app = makeApp({ token: 'secret-token' });
    const res = await request(app)
      .get('/skills')
      .set('Authorization', 'Bearer secret-token');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: MCP Registry Proxy
// ---------------------------------------------------------------------------

describe('GET /mcps/registry', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('rejects searches shorter than 2 characters', async () => {
    const app = makeApp();
    const res = await request(app).get('/mcps/registry?search=a');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('2-200 characters');
  });

  it('rejects missing search parameter', async () => {
    const app = makeApp();
    const res = await request(app).get('/mcps/registry');
    expect(res.status).toBe(400);
  });

  it('proxies to registry and returns results', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({ servers: [{ name: 'test-mcp', description: 'A test server' }] }),
    });

    const app = makeApp();
    const res = await request(app).get('/mcps/registry?search=test');
    expect(res.status).toBe(200);
    expect(res.body.servers).toHaveLength(1);
    expect(res.body.servers[0].name).toBe('test-mcp');
  });

  it('returns 502 when registry is unavailable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
    });

    const app = makeApp();
    const res = await request(app).get('/mcps/registry?search=test');
    expect(res.status).toBe(502);
  });

  it('returns 504 when registry times out', async () => {
    const err = new Error('Timeout');
    err.name = 'TimeoutError';
    globalThis.fetch = vi.fn().mockRejectedValue(err);
    const app = makeApp();
    const res = await request(app).get('/mcps/registry?search=test');
    expect(res.status).toBe(504);
  });
});

// ---------------------------------------------------------------------------
// Tests: Promote endpoint
// ---------------------------------------------------------------------------

describe('POST /skills/:id/promote', () => {
  it('promotes an agent-owned skill to system-owned', async () => {
    mockGetSkill.mockReturnValue({
      id: 'agent-skill',
      name: 'Agent Skill',
      version: '1.0.0',
      description: 'An agent skill',
      tier: 'instruction',
      enabled: true,
      config: {},
      owner: 'agent',
    });

    const app = makeApp();
    const res = await request(app).post('/skills/agent-skill/promote');

    expect(res.status).toBe(200);
    expect(res.body.owner).toBe('system');
    expect(mockUpsertSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-skill', owner: 'system' }),
    );
  });

  it('returns 404 for nonexistent skill', async () => {
    mockGetSkill.mockReturnValue(undefined);

    const app = makeApp();
    const res = await request(app).post('/skills/nonexistent/promote');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('skill not found');
  });

  it('returns 400 for already system-owned skill', async () => {
    mockGetSkill.mockReturnValue({
      id: 'sys-skill',
      name: 'System Skill',
      version: '1.0.0',
      description: 'A system skill',
      tier: 'stdio',
      enabled: true,
      config: {},
      owner: 'system',
    });

    const app = makeApp();
    const res = await request(app).post('/skills/sys-skill/promote');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('agent-owned');
    expect(mockUpsertSkill).not.toHaveBeenCalled();
  });
});
