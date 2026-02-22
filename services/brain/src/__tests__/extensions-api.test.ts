import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

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

function makeApp() {
  delete process.env.AUTH_TOKEN; // dev mode: no auth

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
    undefined,
    undefined,
    undefined,
    undefined,
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
// Tests: GET /toolboxes
// ---------------------------------------------------------------------------

describe('GET /toolboxes', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.TOOLBOX_MANIFEST_URL;
  });

  it('returns empty array when TOOLBOX_MANIFEST_URL is not set', async () => {
    delete process.env.TOOLBOX_MANIFEST_URL;
    const app = makeApp();
    const res = await request(app).get('/toolboxes');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('returns toolboxes array from manifest URL', async () => {
    process.env.TOOLBOX_MANIFEST_URL = 'https://example.com/manifest.json';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        toolboxes: [
          { name: 'node-toolbox', description: 'Node.js tools', image: 'node:22', packages: ['node'] },
        ],
      }),
    }) as any;

    const app = makeApp();
    const res = await request(app).get('/toolboxes');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('node-toolbox');
    expect(res.body[0].status).toBe('not_built');
  });

  it('returns 502 when manifest URL fetch fails', async () => {
    process.env.TOOLBOX_MANIFEST_URL = 'https://example.com/manifest.json';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }) as any;

    const app = makeApp();
    const res = await request(app).get('/toolboxes');

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Failed to fetch toolbox manifest');
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /skills/upload — non-zip rejection (with temp-file cleanup)
// ---------------------------------------------------------------------------

describe('POST /skills/upload', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'bakerst-upload-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects non-zip files with 400', async () => {
    const txtFile = path.join(tmpDir, 'readme.txt');
    await writeFile(txtFile, 'hello');

    const app = makeApp();
    const res = await request(app)
      .post('/skills/upload')
      .attach('file', txtFile, { filename: 'readme.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('.zip');
  });

  it('returns 400 when no file is attached', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/skills/upload');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No file uploaded');
  });

  it('returns 400 for zip without SKILL.md', async () => {
    const zip = new AdmZip();
    zip.addFile('README.txt', Buffer.from('no skill here'));
    const zipPath = path.join(tmpDir, 'empty-skill.zip');
    zip.writeZip(zipPath);

    const app = makeApp();
    const res = await request(app)
      .post('/skills/upload')
      .attach('file', zipPath, { filename: 'empty-skill.zip', contentType: 'application/zip' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('SKILL.md');
  });

  it('accepts a valid zip with SKILL.md and upserts the skill', async () => {
    const skillMd = `---
name: My Test Skill
description: A skill for testing
tags: [testing, demo]
---
You are a test skill.
`;
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from(skillMd));
    const zipPath = path.join(tmpDir, 'my-test-skill.zip');
    zip.writeZip(zipPath);

    const app = makeApp();
    const res = await request(app)
      .post('/skills/upload')
      .attach('file', zipPath, { filename: 'my-test-skill.zip', contentType: 'application/zip' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('My Test Skill');
    expect(res.body.description).toBe('A skill for testing');
    expect(res.body.tags).toEqual(['testing', 'demo']);
    expect(mockUpsertSkill).toHaveBeenCalled();
  });
});
