// services/brain/src/saved-prompts.ts
import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

export interface SavedPrompt {
  id: string;
  text: string;
  label: string | null;
  created_at: string;
}

const MAX_PROMPT_LENGTH = 10_000;
const MAX_LABEL_LENGTH = 200;

export function savePrompt(text: string, label?: string): SavedPrompt {
  if (text.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt text exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
  }
  if (label && label.length > MAX_LABEL_LENGTH) {
    throw new Error(`Label exceeds maximum length of ${MAX_LABEL_LENGTH} characters`);
  }

  const db = getDb();
  const id = randomUUID();
  const created_at = new Date().toISOString();

  db.prepare(
    'INSERT INTO saved_prompts (id, text, label, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, text, label ?? null, created_at);

  return { id, text, label: label ?? null, created_at };
}

export function listSavedPrompts(limit = 50): SavedPrompt[] {
  const db = getDb();
  return db
    .prepare('SELECT id, text, label, created_at FROM saved_prompts ORDER BY created_at DESC LIMIT ?')
    .all(limit) as SavedPrompt[];
}

export function getSavedPrompt(id: string): SavedPrompt | undefined {
  const db = getDb();
  return db
    .prepare('SELECT id, text, label, created_at FROM saved_prompts WHERE id = ?')
    .get(id) as SavedPrompt | undefined;
}

export function deleteSavedPrompt(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM saved_prompts WHERE id = ?').run(id);
  return result.changes > 0;
}
