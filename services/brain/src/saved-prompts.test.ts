// services/brain/src/saved-prompts.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from './db.js';

// Initialize DB for tests
beforeAll(() => { getDb(); });

import {
  savePrompt,
  listSavedPrompts,
  getSavedPrompt,
  deleteSavedPrompt,
} from './saved-prompts.js';

describe('saved-prompts', () => {
  it('saves a prompt and returns it with an id', () => {
    const result = savePrompt('Write a haiku about testing');
    expect(result.id).toBeDefined();
    expect(result.text).toBe('Write a haiku about testing');
    expect(result.created_at).toBeDefined();
  });

  it('lists saved prompts in reverse chronological order', () => {
    savePrompt('First prompt');
    savePrompt('Second prompt');
    const list = listSavedPrompts();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const idx1 = list.findIndex(p => p.text === 'First prompt');
    const idx2 = list.findIndex(p => p.text === 'Second prompt');
    expect(idx2).toBeLessThan(idx1);
  });

  it('gets a prompt by id', () => {
    const saved = savePrompt('Specific prompt');
    const fetched = getSavedPrompt(saved.id);
    expect(fetched).toBeDefined();
    expect(fetched!.text).toBe('Specific prompt');
  });

  it('deletes a prompt', () => {
    const saved = savePrompt('To be deleted');
    const deleted = deleteSavedPrompt(saved.id);
    expect(deleted).toBe(true);
    expect(getSavedPrompt(saved.id)).toBeUndefined();
  });

  it('returns undefined for non-existent id', () => {
    expect(getSavedPrompt('nonexistent')).toBeUndefined();
  });
});
