import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillTier } from '@bakerst/shared';
import type { SkillMetadata } from '@bakerst/shared';

// ---------------------------------------------------------------------------
// Each test gets a fresh temp directory + fresh module import
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'bakerst-test-'));
  process.env.DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const { closeDb } = await import('../db.js');
    closeDb();
  } catch {
    // may not have been opened
  }
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: make a SkillMetadata object
// ---------------------------------------------------------------------------

function makeSkill(overrides?: Partial<SkillMetadata>): SkillMetadata {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    version: '1.0.0',
    description: 'A test skill',
    tier: SkillTier.Tier1,
    transport: 'stdio',
    enabled: true,
    config: { foo: 'bar' },
    stdioCommand: 'node',
    stdioArgs: ['server.js'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Skills DB CRUD', () => {
  it('getDb() creates tables on first call', async () => {
    const { getDb } = await import('../db.js');
    const db = getDb();
    // The skills table should exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skills'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('listSkills() returns empty array initially', async () => {
    const { listSkills, getDb } = await import('../db.js');
    getDb(); // ensure init
    const skills = listSkills();
    expect(skills).toEqual([]);
  });

  it('upsertSkill() inserts a new skill', async () => {
    const { upsertSkill, listSkills, getDb } = await import('../db.js');
    getDb();
    const skill = makeSkill();
    upsertSkill(skill);
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('test-skill');
    expect(skills[0].name).toBe('Test Skill');
    expect(skills[0].enabled).toBe(true);
    expect(skills[0].config).toEqual({ foo: 'bar' });
    expect(skills[0].stdioCommand).toBe('node');
    expect(skills[0].stdioArgs).toEqual(['server.js']);
  });

  it('upsertSkill() updates existing skill on conflict', async () => {
    const { upsertSkill, getSkill, getDb } = await import('../db.js');
    getDb();
    upsertSkill(makeSkill());
    upsertSkill(makeSkill({ name: 'Updated Skill', version: '2.0.0' }));
    const skill = getSkill('test-skill');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('Updated Skill');
    expect(skill!.version).toBe('2.0.0');
  });

  it('getSkill() returns skill by ID', async () => {
    const { upsertSkill, getSkill, getDb } = await import('../db.js');
    getDb();
    upsertSkill(makeSkill());
    const skill = getSkill('test-skill');
    expect(skill).toBeDefined();
    expect(skill!.id).toBe('test-skill');
    expect(skill!.tier).toBe(SkillTier.Tier1);
  });

  it('getSkill() returns undefined for non-existent ID', async () => {
    const { getSkill, getDb } = await import('../db.js');
    getDb();
    const skill = getSkill('nonexistent');
    expect(skill).toBeUndefined();
  });

  it('getEnabledSkills() only returns enabled skills', async () => {
    const { upsertSkill, getEnabledSkills, getDb } = await import('../db.js');
    getDb();
    upsertSkill(makeSkill({ id: 'enabled-skill', enabled: true }));
    upsertSkill(makeSkill({ id: 'disabled-skill', enabled: false }));
    const enabled = getEnabledSkills();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe('enabled-skill');
  });

  it('deleteSkill() removes skill and returns true', async () => {
    const { upsertSkill, deleteSkill, listSkills, getDb } = await import('../db.js');
    getDb();
    upsertSkill(makeSkill());
    const result = deleteSkill('test-skill');
    expect(result).toBe(true);
    expect(listSkills()).toHaveLength(0);
  });

  it('deleteSkill() returns false for non-existent ID', async () => {
    const { deleteSkill, getDb } = await import('../db.js');
    getDb();
    const result = deleteSkill('nonexistent');
    expect(result).toBe(false);
  });

  it('rowToMetadata() handles malformed config JSON gracefully', async () => {
    const { getDb, listSkills } = await import('../db.js');
    const db = getDb();
    // Insert a row with bad JSON in config column
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO skills (id, name, version, description, tier, transport, enabled, config, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('bad-config', 'Bad Config', '1.0.0', 'desc', 'stdio', 'stdio', 1, '{bad json', now, now);

    const skills = listSkills();
    const skill = skills.find((s) => s.id === 'bad-config');
    expect(skill).toBeDefined();
    expect(skill!.config).toEqual({}); // Falls back to empty object
  });

  it('rowToMetadata() handles malformed stdio_args JSON gracefully', async () => {
    const { getDb, listSkills } = await import('../db.js');
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO skills (id, name, version, description, tier, transport, enabled, config, stdio_args, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('bad-args', 'Bad Args', '1.0.0', 'desc', 'stdio', 'stdio', 1, '{}', 'not-json', now, now);

    const skills = listSkills();
    const skill = skills.find((s) => s.id === 'bad-args');
    expect(skill).toBeDefined();
    expect(skill!.stdioArgs).toBeUndefined(); // Falls back to undefined
  });

  describe('updateMemoryState() optimistic locking', () => {
    it('succeeds with correct version', async () => {
      const { getDb, initMemoryState, updateMemoryState, createConversation } = await import('../db.js');
      getDb();
      createConversation('conv1', 'Test');
      initMemoryState('conv1');

      const result = updateMemoryState('conv1', { unobserved_token_count: 100 }, 0);
      expect(result).toBe(true);
    });

    it('fails with wrong version', async () => {
      const { getDb, initMemoryState, updateMemoryState, createConversation } = await import('../db.js');
      getDb();
      createConversation('conv1', 'Test');
      initMemoryState('conv1');

      const result = updateMemoryState('conv1', { unobserved_token_count: 100 }, 999);
      expect(result).toBe(false);
    });
  });
});
