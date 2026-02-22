/**
 * Tests for the companions system:
 *  - DB functions (real SQLite, temp DATA_DIR per test)
 *  - API route mode validation (mocked DB)
 *  - CompanionManager basic construction
 *
 * NOTE: vi.mock() is hoisted to file top by Vitest. To keep real-DB tests and
 * mocked-API tests in one file we split them into separate describe() suites
 * and use vi.importActual() for the DB suite imports.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Hoisted mock stubs for the API-level tests
// ---------------------------------------------------------------------------

const {
  mockListConversations,
  mockGetConversation,
  mockGetMessages,
  mockListSkills,
  mockGetSkill,
  mockUpsertSkill,
  mockDeleteSkill,
  mockGetDb,
  mockGetModelConfigValue,
  mockSetModelConfigValue,
  mockDispatchTask,
  mockGetCompanions,
  mockGetCompanion,
  mockGetCompanionTasks,
} = vi.hoisted(() => ({
  mockListConversations: vi.fn().mockReturnValue([]),
  mockGetConversation: vi.fn(),
  mockGetMessages: vi.fn().mockReturnValue([]),
  mockListSkills: vi.fn().mockReturnValue([]),
  mockGetSkill: vi.fn(),
  mockUpsertSkill: vi.fn(),
  mockDeleteSkill: vi.fn().mockReturnValue(true),
  mockGetDb: vi.fn().mockReturnValue({}),
  mockGetModelConfigValue: vi.fn(),
  mockSetModelConfigValue: vi.fn(),
  mockDispatchTask: vi.fn().mockResolvedValue('task-uuid-1'),
  mockGetCompanions: vi.fn().mockReturnValue([]),
  mockGetCompanion: vi.fn(),
  mockGetCompanionTasks: vi.fn().mockReturnValue([]),
}));

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
// Part 1: DB functions – use vi.importActual to bypass the mock above
// ---------------------------------------------------------------------------

describe('Companions DB', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'bakerst-companions-db-test-'));
    process.env.DATA_DIR = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      // importActual bypasses vi.mock so we get the real module to close the DB
      const mod = await vi.importActual<typeof import('../db.js')>('../db.js');
      (mod as any).closeDb?.();
    } catch {
      // ignore
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function realDb() {
    return vi.importActual<typeof import('../db.js')>('../db.js');
  }

  it('listCompanions() returns empty array initially', async () => {
    const { getDb, listCompanions } = await realDb();
    getDb();
    expect(listCompanions()).toEqual([]);
  });

  it('upsertCompanion() inserts a new companion', async () => {
    const { getDb, upsertCompanion, listCompanions } = await realDb();
    getDb();
    upsertCompanion({
      id: 'irr-1',
      hostname: 'desktop-01',
      capabilities: ['filesystem', 'script'],
      maxConcurrent: 2,
      platform: 'linux',
      arch: 'x64',
    });
    const rows = listCompanions();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('irr-1');
    expect(rows[0].hostname).toBe('desktop-01');
    expect(rows[0].status).toBe('online');
    expect(JSON.parse(rows[0].capabilities)).toEqual(['filesystem', 'script']);
  });

  it('upsertCompanion() updates an existing companion on conflict', async () => {
    const { getDb, upsertCompanion, listCompanions } = await realDb();
    getDb();
    upsertCompanion({ id: 'irr-1', hostname: 'desktop-01', capabilities: ['filesystem'] });
    upsertCompanion({ id: 'irr-1', hostname: 'desktop-01-renamed', capabilities: ['filesystem', 'agent'] });
    const rows = listCompanions();
    expect(rows).toHaveLength(1);
    expect(rows[0].hostname).toBe('desktop-01-renamed');
    expect(JSON.parse(rows[0].capabilities)).toContain('agent');
  });

  it('updateCompanionStatus() changes the status field', async () => {
    const { getDb, upsertCompanion, updateCompanionStatus, listCompanions } = await realDb();
    getDb();
    upsertCompanion({ id: 'irr-2', hostname: 'laptop', capabilities: ['agent'] });
    updateCompanionStatus('irr-2', 'offline');
    const rows = listCompanions();
    expect(rows[0].status).toBe('offline');
  });

  it('updateCompanionStatus() is a no-op for unknown id', async () => {
    const { getDb, updateCompanionStatus, listCompanions } = await realDb();
    getDb();
    // Should not throw
    updateCompanionStatus('no-such-id', 'offline');
    expect(listCompanions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Part 2: API route – mode enum validation (mocked DB via vi.mock above)
// ---------------------------------------------------------------------------

import { createApi } from '../api.js';

function makeCompanionManager() {
  return {
    getCompanions: mockGetCompanions,
    getCompanion: mockGetCompanion,
    dispatchTask: mockDispatchTask,
    getCompanionTasks: mockGetCompanionTasks,
    getCapabilitiesSummary: vi.fn().mockReturnValue(''),
  } as any;
}

function makeApp(companionManager?: any) {
  delete process.env.AUTH_TOKEN; // dev mode – no auth

  const mockDispatcher = { dispatch: vi.fn().mockResolvedValue({ jobId: 'j1' }) } as any;
  const mockStatusTracker = { getAllStatuses: vi.fn().mockReturnValue([]), getStatus: vi.fn() } as any;
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
    undefined, // skillRegistry
    undefined, // mcpClient
    undefined, // modelRouter
    undefined, // nc
    undefined, // scheduleManager
    undefined, // stateMachine
    undefined, // startTime
    undefined, // taskPodManager
    companionManager,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /companions/:id/task – mode validation', () => {
  it('returns 503 when no companionManager is configured', async () => {
    const app = makeApp(undefined);
    const res = await request(app).post('/companions/irr-1/task').send({ mode: 'agent', goal: 'do something' });
    expect(res.status).toBe(503);
  });

  it('returns 400 when mode is missing', async () => {
    const app = makeApp(makeCompanionManager());
    const res = await request(app).post('/companions/irr-1/task').send({ goal: 'do something' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mode and goal are required/);
  });

  it('returns 400 when goal is missing', async () => {
    const app = makeApp(makeCompanionManager());
    const res = await request(app).post('/companions/irr-1/task').send({ mode: 'agent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mode and goal are required/);
  });

  it('returns 400 when mode is an invalid enum value', async () => {
    const app = makeApp(makeCompanionManager());
    const res = await request(app).post('/companions/irr-1/task').send({ mode: 'invalid', goal: 'do something' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agent|script/i);
  });

  it('accepts mode=agent and dispatches task', async () => {
    mockDispatchTask.mockResolvedValueOnce('task-uuid-1');
    const app = makeApp(makeCompanionManager());
    const res = await request(app).post('/companions/irr-1/task').send({ mode: 'agent', goal: 'do something' });
    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe('task-uuid-1');
    expect(mockDispatchTask).toHaveBeenCalledWith('irr-1', {
      mode: 'agent',
      goal: 'do something',
      tools: undefined,
      timeout: undefined,
    });
  });

  it('accepts mode=script and dispatches task', async () => {
    mockDispatchTask.mockResolvedValueOnce('task-uuid-1');
    const app = makeApp(makeCompanionManager());
    const res = await request(app).post('/companions/irr-1/task').send({ mode: 'script', goal: 'run script' });
    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe('task-uuid-1');
  });
});

// ---------------------------------------------------------------------------
// Part 3: CompanionManager basic construction
// ---------------------------------------------------------------------------

describe('CompanionManager construction', () => {
  it('can be constructed with a NATS connection', async () => {
    const { CompanionManager } = await import('../companion-manager.js');
    const mockNc = {
      subscribe: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: vi.fn().mockReturnValue({ next: vi.fn().mockResolvedValue({ done: true }) }),
        unsubscribe: vi.fn(),
      }),
      publish: vi.fn(),
    } as any;
    const manager = new CompanionManager(mockNc);
    expect(manager).toBeDefined();
    expect(typeof manager.getCompanions).toBe('function');
    expect(typeof manager.dispatchTask).toBe('function');
    expect(typeof manager.shutdown).toBe('function');
  });
});
