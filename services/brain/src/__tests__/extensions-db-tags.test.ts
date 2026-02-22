/**
 * Tests for the tags column migration in the skills table.
 *
 * This file intentionally does NOT mock db.js so that it exercises the real
 * SQLite layer, verifying that:
 *   1. The tags column is created (via idempotent ALTER TABLE migration).
 *   2. Tags can be inserted and read back as a parsed array.
 *   3. A skill with no tags is handled gracefully.
 *   4. Calling getDb() multiple times does not throw (migration is idempotent).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'bakerst-tags-test-'));
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

describe('Tags column migration', () => {
  it('getDb() creates skills table with tags column', async () => {
    const { getDb } = await import('../db.js');
    const db = getDb();

    const columns = db.prepare('PRAGMA table_info(skills)').all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('tags');
  });

  it('upsertSkill() stores tags as JSON and listSkills() returns them parsed', async () => {
    const { getDb, upsertSkill, listSkills } = await import('../db.js');
    const { SkillTier } = await import('@bakerst/shared');
    getDb();

    upsertSkill({
      id: 'tagged-skill',
      name: 'Tagged Skill',
      version: '1.0.0',
      description: 'A skill with tags',
      tier: SkillTier.Tier0,
      enabled: true,
      config: {},
      tags: ['ai', 'productivity'],
    });

    const skills = listSkills();
    const skill = skills.find((s: any) => s.id === 'tagged-skill');
    expect(skill).toBeDefined();
    expect(skill!.tags).toEqual(['ai', 'productivity']);
  });

  it('upsertSkill() handles skill with no tags gracefully', async () => {
    const { getDb, upsertSkill, listSkills } = await import('../db.js');
    const { SkillTier } = await import('@bakerst/shared');
    getDb();

    upsertSkill({
      id: 'untagged-skill',
      name: 'Untagged Skill',
      version: '1.0.0',
      description: 'A skill without tags',
      tier: SkillTier.Tier1,
      enabled: true,
      config: {},
    });

    const skills = listSkills();
    const skill = skills.find((s: any) => s.id === 'untagged-skill');
    expect(skill).toBeDefined();
    // tags should be undefined or empty array when not set
    expect(skill!.tags == null || Array.isArray(skill!.tags)).toBe(true);
  });

  it('migration is idempotent — calling getDb() twice does not throw', async () => {
    const { getDb } = await import('../db.js');
    expect(() => {
      getDb();
      getDb();
    }).not.toThrow();
  });
});
