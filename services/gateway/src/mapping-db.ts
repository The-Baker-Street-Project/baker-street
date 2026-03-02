import path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '@bakerst/shared';

const log = logger.child({ module: 'mapping-db' });

let db: Database.Database | null = null;

export function initMappingDb(dataDir: string): void {
  const dbPath = path.join(dataDir, 'gateway.db');
  log.info({ path: dbPath }, 'opening mapping database');

  db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_conversations (
      platform TEXT NOT NULL,
      platform_thread TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, platform_thread)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS door_policy (
      platform TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      paired_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, sender_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_challenges (
      code TEXT NOT NULL PRIMARY KEY,
      platform TEXT DEFAULT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function getConversationId(platform: string, platformThread: string): string | undefined {
  if (!db) throw new Error('mapping DB not initialized');
  const row = db
    .prepare('SELECT conversation_id FROM channel_conversations WHERE platform = ? AND platform_thread = ?')
    .get(platform, platformThread) as { conversation_id: string } | undefined;
  return row?.conversation_id;
}

export function setConversationId(
  platform: string,
  platformThread: string,
  conversationId: string,
): void {
  if (!db) throw new Error('mapping DB not initialized');
  db.prepare(`
    INSERT INTO channel_conversations (platform, platform_thread, conversation_id)
    VALUES (?, ?, ?)
    ON CONFLICT (platform, platform_thread) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      updated_at = datetime('now')
  `).run(platform, platformThread, conversationId);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('mapping DB not initialized');
  return db;
}

export function closeMappingDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
