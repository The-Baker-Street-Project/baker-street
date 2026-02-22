import { describe, it, expect, vi, afterEach } from 'vitest';
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
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createApi } from '../api.js';
import { BrainStateMachine } from '../brain-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalToken = process.env.AUTH_TOKEN;

function makeApp(opts?: {
  stateMachine?: BrainStateMachine;
  startTime?: number;
}) {
  // Run in dev mode (no auth)
  delete process.env.AUTH_TOKEN;

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
    undefined,  // skillRegistry
    undefined,  // mcpClient
    undefined,  // modelRouter
    undefined,  // nc
    undefined,  // scheduleManager
    opts?.stateMachine,
    opts?.startTime,
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
// Tests: /ping with brain state
// ---------------------------------------------------------------------------

describe('/ping with brain state', () => {
  it('returns 503 with not_ready when state is pending', async () => {
    const sm = new BrainStateMachine('pending');
    const app = makeApp({ stateMachine: sm });

    const res = await request(app).get('/ping');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.service).toBe('brain');
    expect(res.body.state).toBe('pending');
    expect(res.body.timestamp).toBeDefined();
  });

  it('returns 200 with ok when state is active', async () => {
    const sm = new BrainStateMachine('active');
    const app = makeApp({ stateMachine: sm });

    const res = await request(app).get('/ping');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('brain');
    expect(res.body.timestamp).toBeDefined();
  });

  it('returns 200 when no stateMachine is provided (legacy mode)', async () => {
    const app = makeApp();

    const res = await request(app).get('/ping');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /brain/state
// ---------------------------------------------------------------------------

describe('GET /brain/state', () => {
  it('returns state, version, and uptime when stateMachine is provided', async () => {
    const sm = new BrainStateMachine('active');
    const fixedStartTime = Date.now() - 5000; // started 5s ago
    const app = makeApp({ stateMachine: sm, startTime: fixedStartTime });

    const res = await request(app).get('/brain/state');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('active');
    expect(res.body.version).toBeDefined();
    expect(res.body.uptime).toBeGreaterThanOrEqual(5000);
  });

  it('returns active state when no stateMachine is provided', async () => {
    const app = makeApp();

    const res = await request(app).get('/brain/state');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('active');
  });

  it('uses the passed-in startTime for uptime calculation', async () => {
    const sm = new BrainStateMachine('active');
    const fixedStartTime = Date.now() - 60_000; // started 60s ago
    const app = makeApp({ stateMachine: sm, startTime: fixedStartTime });

    const res = await request(app).get('/brain/state');

    expect(res.status).toBe(200);
    expect(res.body.uptime).toBeGreaterThanOrEqual(60_000);
    expect(res.body.uptime).toBeLessThan(65_000);
  });
});

// ---------------------------------------------------------------------------
// Tests: Draining middleware
// ---------------------------------------------------------------------------

describe('Draining middleware', () => {
  it('returns 503 for normal routes when draining', async () => {
    const sm = new BrainStateMachine('active');
    sm.drain(); // transition to draining
    const app = makeApp({ stateMachine: sm });

    const res = await request(app).get('/jobs');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('service draining');
    expect(res.body.state).toBe('draining');
  });

  it('allows /ping through when draining', async () => {
    const sm = new BrainStateMachine('active');
    sm.drain();
    const app = makeApp({ stateMachine: sm });

    const res = await request(app).get('/ping');

    // /ping returns 503 not_ready because isReady() is false when draining,
    // but it is NOT blocked by the draining middleware (it reaches the /ping handler)
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.state).toBe('draining');
  });

  it('allows /brain/state through when draining', async () => {
    const sm = new BrainStateMachine('active');
    sm.drain();
    const app = makeApp({ stateMachine: sm });

    const res = await request(app).get('/brain/state');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('draining');
  });

  it('allows normal routes when active', async () => {
    const sm = new BrainStateMachine('active');
    const app = makeApp({ stateMachine: sm });

    const res = await request(app).get('/jobs');

    expect(res.status).toBe(200);
  });

  it('allows normal routes when no stateMachine is provided', async () => {
    const app = makeApp();

    const res = await request(app).get('/jobs');

    expect(res.status).toBe(200);
  });
});
