import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger, type SkillMetadata, SkillTier } from '@bakerst/shared';
import { estimateTokens } from './token-count.js';

const log = logger.child({ module: 'db' });

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const DB_PATH = path.join(DATA_DIR, 'bakerst.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;

  log.info({ path: DB_PATH }, 'opening SQLite database');
  db = new Database(DB_PATH);

  // DELETE mode is more reliable through Docker Desktop's VM file-sharing layer
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id       TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      source       TEXT,
      input        TEXT,
      status       TEXT NOT NULL DEFAULT 'dispatched',
      worker_id    TEXT,
      result       TEXT,
      error        TEXT,
      duration_ms  INTEGER,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      title      TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL
    )
  `);

  // --- Observational memory tables ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id                  TEXT PRIMARY KEY,
      conversation_id     TEXT NOT NULL REFERENCES conversations(id),
      created_at          TEXT NOT NULL,
      text                TEXT NOT NULL,
      token_count         INTEGER NOT NULL,
      tags                TEXT,
      source_message_from TEXT NOT NULL,
      source_message_to   TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS observation_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id     TEXT NOT NULL REFERENCES conversations(id),
      version             INTEGER NOT NULL DEFAULT 1,
      text                TEXT NOT NULL,
      token_count         INTEGER NOT NULL,
      created_at          TEXT NOT NULL,
      UNIQUE(conversation_id, version)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reflections (
      id                  TEXT PRIMARY KEY,
      conversation_id     TEXT NOT NULL REFERENCES conversations(id),
      created_at          TEXT NOT NULL,
      replaces_version    INTEGER NOT NULL,
      output_text         TEXT NOT NULL,
      token_count         INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_state (
      conversation_id            TEXT PRIMARY KEY REFERENCES conversations(id),
      observed_cursor_message_id TEXT,
      unobserved_token_count     INTEGER NOT NULL DEFAULT 0,
      observation_token_count    INTEGER NOT NULL DEFAULT 0,
      last_observer_run          TEXT,
      last_reflector_run         TEXT,
      lock_version               INTEGER NOT NULL DEFAULT 0
    )
  `);

  // --- Skills (MCP infrastructure) ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      version         TEXT NOT NULL,
      description     TEXT NOT NULL,
      tier            TEXT NOT NULL,
      transport       TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      config          TEXT NOT NULL DEFAULT '{}',
      stdio_command   TEXT,
      stdio_args      TEXT,
      http_url        TEXT,
      instruction_path TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    )
  `);

  // Add instruction_content column for inline Tier 0 skills (idempotent migration)
  try {
    db.exec('ALTER TABLE skills ADD COLUMN instruction_content TEXT');
  } catch {
    // Column already exists
  }

  // Add owner column for self-management (idempotent migration)
  try {
    db.exec("ALTER TABLE skills ADD COLUMN owner TEXT NOT NULL DEFAULT 'system'");
  } catch {
    // Column already exists
  }

  // Add tags column for skill categorization (idempotent migration)
  try {
    db.exec("ALTER TABLE skills ADD COLUMN tags TEXT");
  } catch {
    // Column already exists
  }

  // --- Model config persistence ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS model_config (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )
  `);

  // --- API audit logging ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      provider      TEXT NOT NULL,
      model         TEXT NOT NULL,
      input_tokens  INTEGER,
      output_tokens INTEGER,
      duration_ms   INTEGER NOT NULL,
      cost_estimate REAL,
      error         TEXT,
      trace_id      TEXT,
      created_at    TEXT NOT NULL
    )
  `);

  // --- Changelog (self-management) ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS changelog (
      version     TEXT PRIMARY KEY,
      summary     TEXT NOT NULL,
      delivered   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    )
  `);

  // --- Scheduled tasks ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      schedule      TEXT NOT NULL,
      type          TEXT NOT NULL,
      config        TEXT NOT NULL DEFAULT '{}',
      enabled       INTEGER NOT NULL DEFAULT 1,
      last_run_at   TEXT,
      last_status   TEXT,
      last_output   TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `);

  // --- Brain transfer handoff notes ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS handoff_notes (
      id                    TEXT PRIMARY KEY,
      from_version          TEXT NOT NULL,
      to_version            TEXT,
      active_conversations  TEXT,
      pending_schedules     TEXT,
      agent_notes           TEXT,
      created_at            TEXT NOT NULL
    )
  `);

  // --- Task Pods ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_pods (
      task_id TEXT PRIMARY KEY,
      recipe_id TEXT,
      toolbox TEXT NOT NULL,
      mode TEXT NOT NULL,
      goal TEXT NOT NULL,
      mounts TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      duration_ms INTEGER,
      files_changed TEXT,
      trace_id TEXT,
      job_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // --- Companions ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS companions (
      id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      version TEXT,
      capabilities TEXT NOT NULL,
      paths TEXT,
      max_concurrent INTEGER DEFAULT 1,
      platform TEXT,
      arch TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      last_seen TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_tasks (
      task_id TEXT PRIMARY KEY,
      companion_id TEXT NOT NULL REFERENCES companions(id),
      mode TEXT NOT NULL,
      goal TEXT NOT NULL,
      tools TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      duration_ms INTEGER,
      trace_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  log.info('database initialized');
  return db;
}

// --- Handoff Notes ---

export interface HandoffNoteRow {
  id: string;
  from_version: string;
  to_version: string | null;
  active_conversations: string | null;
  pending_schedules: string | null;
  agent_notes: string | null;
  created_at: string;
}

export function insertHandoffNote(params: {
  id: string;
  fromVersion: string;
  toVersion?: string;
  activeConversations?: string;
  pendingSchedules?: string;
  agentNotes?: string;
  createdAt: string;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO handoff_notes (id, from_version, to_version, active_conversations, pending_schedules, agent_notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.fromVersion,
    params.toVersion ?? null,
    params.activeConversations ?? null,
    params.pendingSchedules ?? null,
    params.agentNotes ?? null,
    params.createdAt,
  );
}

export function getLatestHandoffNote(): HandoffNoteRow | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM handoff_notes ORDER BY created_at DESC LIMIT 1',
  ).get() as HandoffNoteRow | undefined;
}

export interface JobRow {
  job_id: string;
  type: string;
  source: string | null;
  input: string | null;
  status: string;
  worker_id: string | null;
  result: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

export function insertJob(params: {
  jobId: string;
  type: string;
  source?: string;
  input?: string;
  createdAt: string;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO jobs (job_id, type, source, input, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'dispatched', ?, ?)
  `).run(params.jobId, params.type, params.source ?? null, params.input ?? null, params.createdAt, params.createdAt);
}

export function updateJobStatus(params: {
  jobId: string;
  workerId: string;
  status: string;
  result?: string;
  error?: string;
  durationMs?: number;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE jobs SET
      status = ?,
      worker_id = ?,
      result = COALESCE(?, result),
      error = COALESCE(?, error),
      duration_ms = COALESCE(?, duration_ms),
      updated_at = ?
    WHERE job_id = ?
  `).run(params.status, params.workerId, params.result ?? null, params.error ?? null, params.durationMs ?? null, now, params.jobId);
}

export function getJob(jobId: string): JobRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow | undefined;
}

export function listJobs(limit = 100): JobRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as JobRow[];
}

// --- Conversations & Messages ---

export interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

export function createConversation(id: string, title?: string): ConversationRow {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(id, title ?? null, now, now);
  return { id, title: title ?? null, created_at: now, updated_at: now };
}

export function getConversation(id: string): ConversationRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
}

export function listConversations(limit = 50): ConversationRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?').all(limit) as ConversationRow[];
}

export function addMessage(conversationId: string, role: string, content: string): MessageRow {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, conversationId, role, content, now);
  // Touch conversation updated_at
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
  // Track unobserved tokens for observational memory
  const tokens = estimateTokens(content);
  db.prepare(`
    UPDATE memory_state
    SET unobserved_token_count = unobserved_token_count + ?
    WHERE conversation_id = ?
  `).run(tokens, conversationId);
  return { id, conversation_id: conversationId, role, content, created_at: now };
}

export function getMessages(conversationId: string): MessageRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversationId) as MessageRow[];
}

// --- Observational Memory ---

export interface ObservationRow {
  id: string;
  conversation_id: string;
  created_at: string;
  text: string;
  token_count: number;
  tags: string | null;
  source_message_from: string;
  source_message_to: string;
}

export interface ObservationLogRow {
  id: number;
  conversation_id: string;
  version: number;
  text: string;
  token_count: number;
  created_at: string;
}

export interface MemoryStateRow {
  conversation_id: string;
  observed_cursor_message_id: string | null;
  unobserved_token_count: number;
  observation_token_count: number;
  last_observer_run: string | null;
  last_reflector_run: string | null;
  lock_version: number;
}

export function initMemoryState(conversationId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO memory_state (conversation_id)
    VALUES (?)
  `).run(conversationId);
}

export function getMemoryState(conversationId: string): MemoryStateRow | null {
  const db = getDb();
  return (db.prepare(
    'SELECT * FROM memory_state WHERE conversation_id = ?',
  ).get(conversationId) as MemoryStateRow | undefined) ?? null;
}

/** Allowlist of columns that may be updated in memory_state */
const ALLOWED_MEMORY_STATE_COLUMNS = new Set([
  'observed_cursor_message_id',
  'unobserved_token_count',
  'observation_token_count',
  'last_observer_run',
  'last_reflector_run',
]);

export function updateMemoryState(
  conversationId: string,
  updates: Partial<Omit<MemoryStateRow, 'conversation_id' | 'lock_version'>>,
  expectedLockVersion: number,
): boolean {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_MEMORY_STATE_COLUMNS.has(key)) {
      throw new Error(`Invalid memory_state column name: ${key}`);
    }
    sets.push(`${key} = ?`);
    values.push(value);
  }
  sets.push('lock_version = lock_version + 1');

  values.push(conversationId, expectedLockVersion);

  const result = db.prepare(`
    UPDATE memory_state
    SET ${sets.join(', ')}
    WHERE conversation_id = ? AND lock_version = ?
  `).run(...values);

  return result.changes > 0;
}

export function addObservation(
  conversationId: string,
  text: string,
  tokenCount: number,
  tags: string | null,
  fromMsgId: string,
  toMsgId: string,
): ObservationRow {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO observations (id, conversation_id, created_at, text, token_count, tags, source_message_from, source_message_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, now, text, tokenCount, tags, fromMsgId, toMsgId);
  return { id, conversation_id: conversationId, created_at: now, text, token_count: tokenCount, tags, source_message_from: fromMsgId, source_message_to: toMsgId };
}

export function getObservations(conversationId: string): ObservationRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM observations WHERE conversation_id = ? ORDER BY created_at ASC',
  ).all(conversationId) as ObservationRow[];
}

export function getActiveObservationLog(conversationId: string): ObservationLogRow | null {
  const db = getDb();
  return (db.prepare(
    'SELECT * FROM observation_log WHERE conversation_id = ? ORDER BY version DESC LIMIT 1',
  ).get(conversationId) as ObservationLogRow | undefined) ?? null;
}

export function upsertObservationLog(
  conversationId: string,
  version: number,
  text: string,
  tokenCount: number,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO observation_log (conversation_id, version, text, token_count, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id, version) DO UPDATE SET
      text = excluded.text,
      token_count = excluded.token_count,
      created_at = excluded.created_at
  `).run(conversationId, version, text, tokenCount, now);
}

// --- Skills (MCP infrastructure) ---

export interface SkillRow {
  id: string;
  name: string;
  version: string;
  description: string;
  tier: string;
  transport: string | null;
  enabled: number;
  config: string;
  stdio_command: string | null;
  stdio_args: string | null;
  http_url: string | null;
  instruction_path: string | null;
  instruction_content: string | null;
  owner: string;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

function rowToMetadata(row: SkillRow): SkillMetadata {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(row.config) as Record<string, unknown>;
  } catch {
    // Malformed config JSON, use empty default
  }

  let stdioArgs: string[] | undefined;
  if (row.stdio_args) {
    try {
      stdioArgs = JSON.parse(row.stdio_args) as string[];
    } catch {
      // Malformed stdio_args JSON, leave undefined
    }
  }

  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    tier: row.tier as SkillTier,
    transport: row.transport as SkillMetadata['transport'],
    enabled: row.enabled === 1,
    config,
    stdioCommand: row.stdio_command ?? undefined,
    stdioArgs,
    httpUrl: row.http_url ?? undefined,
    instructionPath: row.instruction_path ?? undefined,
    instructionContent: row.instruction_content ?? undefined,
    owner: (row.owner as 'system' | 'agent') ?? 'system',
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
  };
}

export function listSkills(): SkillMetadata[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM skills ORDER BY name ASC').all() as SkillRow[];
  return rows.map(rowToMetadata);
}

export function getSkill(id: string): SkillMetadata | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined;
  return row ? rowToMetadata(row) : undefined;
}

export function getEnabledSkills(): SkillMetadata[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM skills WHERE enabled = 1 ORDER BY name ASC').all() as SkillRow[];
  return rows.map(rowToMetadata);
}

export function upsertSkill(skill: SkillMetadata): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO skills (id, name, version, description, tier, transport, enabled, config, stdio_command, stdio_args, http_url, instruction_path, instruction_content, owner, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      version = excluded.version,
      description = excluded.description,
      tier = excluded.tier,
      transport = excluded.transport,
      enabled = excluded.enabled,
      config = excluded.config,
      stdio_command = excluded.stdio_command,
      stdio_args = excluded.stdio_args,
      http_url = excluded.http_url,
      instruction_path = excluded.instruction_path,
      instruction_content = excluded.instruction_content,
      owner = excluded.owner,
      tags = excluded.tags,
      updated_at = excluded.updated_at
  `).run(
    skill.id,
    skill.name,
    skill.version,
    skill.description,
    skill.tier,
    skill.transport ?? null,
    skill.enabled ? 1 : 0,
    JSON.stringify(skill.config),
    skill.stdioCommand ?? null,
    skill.stdioArgs ? JSON.stringify(skill.stdioArgs) : null,
    skill.httpUrl ?? null,
    skill.instructionPath ?? null,
    skill.instructionContent ?? null,
    skill.owner ?? 'system',
    JSON.stringify(skill.tags ?? []),
    now,
    now,
  );
}

export function deleteSkill(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- Changelog (self-management) ---

export interface ChangelogRow {
  version: string;
  summary: string;
  delivered: number;
  created_at: string;
}

export function insertChangelog(version: string, summary: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO changelog (version, summary, delivered, created_at)
    VALUES (?, ?, 0, ?)
  `).run(version, summary, now);
}

export function getUndeliveredChangelog(): { version: string; summary: string } | undefined {
  const db = getDb();
  const row = db.prepare(
    'SELECT version, summary FROM changelog WHERE delivered = 0 ORDER BY created_at DESC LIMIT 1',
  ).get() as { version: string; summary: string } | undefined;
  return row;
}

export function markChangelogDelivered(version: string): void {
  const db = getDb();
  db.prepare('UPDATE changelog SET delivered = 1 WHERE version = ?').run(version);
}

// --- Schedules ---

export interface ScheduleRow {
  id: string;
  name: string;
  schedule: string;
  type: string;
  config: string;
  enabled: number;
  last_run_at: string | null;
  last_status: string | null;
  last_output: string | null;
  created_at: string;
  updated_at: string;
}

export function listSchedules(): ScheduleRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM schedules ORDER BY name ASC').all() as ScheduleRow[];
}

export function getSchedule(id: string): ScheduleRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
}

export function insertSchedule(params: {
  id: string;
  name: string;
  schedule: string;
  type: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO schedules (id, name, schedule, type, config, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.name,
    params.schedule,
    params.type,
    JSON.stringify(params.config),
    params.enabled !== false ? 1 : 0,
    now,
    now,
  );
}

export function updateScheduleRow(id: string, updates: Partial<{
  name: string;
  schedule: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
}>): boolean {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.schedule !== undefined) { sets.push('schedule = ?'); values.push(updates.schedule); }
  if (updates.type !== undefined) { sets.push('type = ?'); values.push(updates.type); }
  if (updates.config !== undefined) { sets.push('config = ?'); values.push(JSON.stringify(updates.config)); }
  if (updates.enabled !== undefined) { sets.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }

  if (sets.length === 0) return false;

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const result = db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function updateScheduleRunStatus(id: string, status: string, output: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const truncatedOutput = output.length > 1024 ? output.slice(0, 1024) + '...(truncated)' : output;
  db.prepare(`
    UPDATE schedules SET last_run_at = ?, last_status = ?, last_output = ?, updated_at = ? WHERE id = ?
  `).run(now, status, truncatedOutput, now, id);
}

export function deleteSchedule(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  return result.changes > 0;
}

export function closeDb(): void {
  if (db) {
    db.close();
    log.info('database closed');
  }
}

// --- Task Pods ---

export interface TaskPodRow {
  task_id: string;
  recipe_id: string | null;
  toolbox: string;
  mode: string;
  goal: string;
  mounts: string | null;
  status: string;
  result: string | null;
  error: string | null;
  duration_ms: number | null;
  files_changed: string | null;
  trace_id: string | null;
  job_name: string | null;
  created_at: string;
  updated_at: string;
}

export function insertTaskPod(params: {
  taskId: string;
  recipeId?: string;
  toolbox: string;
  mode: string;
  goal: string;
  mounts?: string;
  jobName?: string;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO task_pods (task_id, recipe_id, toolbox, mode, goal, mounts, job_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.taskId,
    params.recipeId ?? null,
    params.toolbox,
    params.mode,
    params.goal,
    params.mounts ?? null,
    params.jobName ?? null,
    now,
    now,
  );
}

export function updateTaskPod(taskId: string, updates: Partial<{
  status: string;
  result: string;
  error: string;
  durationMs: number;
  filesChanged: string;
  traceId: string;
  jobName: string;
}>): boolean {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
  if (updates.result !== undefined) { sets.push('result = ?'); values.push(updates.result); }
  if (updates.error !== undefined) { sets.push('error = ?'); values.push(updates.error); }
  if (updates.durationMs !== undefined) { sets.push('duration_ms = ?'); values.push(updates.durationMs); }
  if (updates.filesChanged !== undefined) { sets.push('files_changed = ?'); values.push(updates.filesChanged); }
  if (updates.traceId !== undefined) { sets.push('trace_id = ?'); values.push(updates.traceId); }
  if (updates.jobName !== undefined) { sets.push('job_name = ?'); values.push(updates.jobName); }

  if (sets.length === 0) return false;

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(taskId);

  const result = db.prepare(`UPDATE task_pods SET ${sets.join(', ')} WHERE task_id = ?`).run(...values);
  return result.changes > 0;
}

export function getTaskPod(taskId: string): TaskPodRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM task_pods WHERE task_id = ?').get(taskId) as TaskPodRow | undefined;
}

export function listTaskPods(limit = 100): TaskPodRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM task_pods ORDER BY created_at DESC LIMIT ?').all(limit) as TaskPodRow[];
}

// --- Model config persistence ---

export function getModelConfigValue(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare('SELECT value FROM model_config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setModelConfigValue(key: string, value: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO model_config (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, now);
}

// --- API audit logging ---

export function insertApiAudit(params: {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  costEstimate?: number;
  error?: string;
  traceId?: string;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO api_audit (provider, model, input_tokens, output_tokens, duration_ms, cost_estimate, error, trace_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.provider,
    params.model,
    params.inputTokens ?? null,
    params.outputTokens ?? null,
    params.durationMs,
    params.costEstimate ?? null,
    params.error ?? null,
    params.traceId ?? null,
    new Date().toISOString(),
  );
}

// --- Companions ---

export interface CompanionRow {
  id: string;
  hostname: string;
  version: string | null;
  capabilities: string;
  paths: string | null;
  max_concurrent: number;
  platform: string | null;
  arch: string | null;
  status: string;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanionTaskRow {
  task_id: string;
  companion_id: string;
  mode: string;
  goal: string;
  tools: string | null;
  status: string;
  result: string | null;
  error: string | null;
  duration_ms: number | null;
  trace_id: string | null;
  created_at: string;
  updated_at: string;
}

export function upsertCompanion(params: {
  id: string;
  hostname: string;
  version?: string;
  capabilities: string[];
  paths?: string[];
  maxConcurrent?: number;
  platform?: string;
  arch?: string;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO companions (id, hostname, version, capabilities, paths, max_concurrent, platform, arch, status, last_seen, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      hostname = excluded.hostname,
      version = excluded.version,
      capabilities = excluded.capabilities,
      paths = excluded.paths,
      max_concurrent = excluded.max_concurrent,
      platform = excluded.platform,
      arch = excluded.arch,
      status = 'online',
      last_seen = excluded.last_seen,
      updated_at = excluded.updated_at
  `).run(
    params.id,
    params.hostname,
    params.version ?? null,
    JSON.stringify(params.capabilities),
    params.paths ? JSON.stringify(params.paths) : null,
    params.maxConcurrent ?? 1,
    params.platform ?? null,
    params.arch ?? null,
    now,
    now,
    now,
  );
}

export function updateCompanionStatus(id: string, status: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE companions SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
}

export function updateCompanionLastSeen(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE companions SET last_seen = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

export function listCompanions(): CompanionRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM companions ORDER BY id ASC').all() as CompanionRow[];
}

export function getCompanion(id: string): CompanionRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM companions WHERE id = ?').get(id) as CompanionRow | undefined;
}

export function insertCompanionTask(params: {
  taskId: string;
  companionId: string;
  mode: string;
  goal: string;
  tools?: string[];
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO companion_tasks (task_id, companion_id, mode, goal, tools, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.taskId,
    params.companionId,
    params.mode,
    params.goal,
    params.tools ? JSON.stringify(params.tools) : null,
    now,
    now,
  );
}

export function updateCompanionTask(taskId: string, updates: Partial<{
  status: string;
  result: string;
  error: string;
  durationMs: number;
  traceId: string;
}>): boolean {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
  if (updates.result !== undefined) { sets.push('result = ?'); values.push(updates.result); }
  if (updates.error !== undefined) { sets.push('error = ?'); values.push(updates.error); }
  if (updates.durationMs !== undefined) { sets.push('duration_ms = ?'); values.push(updates.durationMs); }
  if (updates.traceId !== undefined) { sets.push('trace_id = ?'); values.push(updates.traceId); }

  if (sets.length === 0) return false;

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(taskId);

  const result = db.prepare(`UPDATE companion_tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...values);
  return result.changes > 0;
}

export function listCompanionTasks(companionId: string, limit = 50): CompanionTaskRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM companion_tasks WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(companionId, limit) as CompanionTaskRow[];
}
