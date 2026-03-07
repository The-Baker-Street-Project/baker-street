import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point DATA_DIR at a temp directory so tests use an isolated DB
const testDir = mkdtempSync(path.join(tmpdir(), 'bakerst-test-'));
process.env.DATA_DIR = testDir;

// Import after setting DATA_DIR
const { getDb, updateScheduleRunStatus } = await import('./db.js');
const { validateWebhookUrl } = await import('./schedule-tools.js');

// Initialize DB for tests
beforeAll(() => {
  getDb();
});

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best-effort cleanup */ }
});

describe('Schedule self-healing columns', () => {
  it('schedules table has consecutive_failures column', () => {
    const db = getDb();
    const info = db.prepare("PRAGMA table_info(schedules)").all() as { name: string }[];
    const names = info.map(c => c.name);
    expect(names).toContain('consecutive_failures');
    expect(names).toContain('max_consecutive_failures');
    expect(names).toContain('case_file');
  });
});

describe('Schedule delivery config', () => {
  it('stores delivery config in schedule config JSON', () => {
    const db = getDb();
    const id = 'test-delivery-' + Date.now();
    const config = JSON.stringify({
      job: 'check news',
      delivery: { mode: 'announce', channel: 'telegram' },
    });
    db.prepare(
      "INSERT INTO schedules (id, name, schedule, type, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))"
    ).run(id, 'Test', '0 * * * *', 'agent', config);

    const row = db.prepare("SELECT config FROM schedules WHERE id = ?").get(id) as { config: string };
    const parsed = JSON.parse(row.config);
    expect(parsed.delivery.mode).toBe('announce');
    expect(parsed.delivery.channel).toBe('telegram');
  });
});

describe('Schedule self-healing logic', () => {
  it('updateScheduleRunStatus resets consecutive_failures on success', () => {
    const db = getDb();
    const id = 'test-heal-success-' + Date.now();
    db.prepare(
      "INSERT INTO schedules (id, name, schedule, type, config, enabled, consecutive_failures, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', 1, 3, datetime('now'), datetime('now'))"
    ).run(id, 'Test Success', '0 * * * *', 'agent');

    updateScheduleRunStatus(id, 'success', 'ok', 0);

    const row = db.prepare("SELECT consecutive_failures FROM schedules WHERE id = ?").get(id) as { consecutive_failures: number };
    expect(row.consecutive_failures).toBe(0);
  });

  it('updateScheduleRunStatus increments consecutive_failures on failure', () => {
    const db = getDb();
    const id = 'test-heal-fail-' + Date.now();
    db.prepare(
      "INSERT INTO schedules (id, name, schedule, type, config, enabled, consecutive_failures, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', 1, 2, datetime('now'), datetime('now'))"
    ).run(id, 'Test Fail', '0 * * * *', 'agent');

    updateScheduleRunStatus(id, 'failed', 'error msg', 3);

    const row = db.prepare("SELECT consecutive_failures FROM schedules WHERE id = ?").get(id) as { consecutive_failures: number };
    expect(row.consecutive_failures).toBe(3);
  });

  it('default max_consecutive_failures is 5', () => {
    const db = getDb();
    const id = 'test-default-max-' + Date.now();
    db.prepare(
      "INSERT INTO schedules (id, name, schedule, type, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', 1, datetime('now'), datetime('now'))"
    ).run(id, 'Test Default Max', '0 * * * *', 'agent');

    const row = db.prepare("SELECT max_consecutive_failures FROM schedules WHERE id = ?").get(id) as { max_consecutive_failures: number };
    expect(row.max_consecutive_failures).toBe(5);
  });

  it('default case_file is sitting-room', () => {
    const db = getDb();
    const id = 'test-default-case-' + Date.now();
    db.prepare(
      "INSERT INTO schedules (id, name, schedule, type, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', 1, datetime('now'), datetime('now'))"
    ).run(id, 'Test Default Case', '0 * * * *', 'agent');

    const row = db.prepare("SELECT case_file FROM schedules WHERE id = ?").get(id) as { case_file: string };
    expect(row.case_file).toBe('sitting-room');
  });
});

describe('SSRF protection for webhook delivery', () => {
  it('rejects non-HTTPS webhook URLs', () => {
    expect(validateWebhookUrl('http://example.com/hook')).toBe('Webhook URL must use HTTPS');
  });

  it('accepts valid HTTPS webhook URLs', () => {
    expect(validateWebhookUrl('https://example.com/hook')).toBeNull();
  });

  it('rejects localhost URLs', () => {
    expect(validateWebhookUrl('https://localhost/hook')).toBe('Webhook URL must not target private/internal addresses');
  });

  it('rejects private IP ranges', () => {
    expect(validateWebhookUrl('https://10.0.0.1/hook')).toBe('Webhook URL must not target private/internal addresses');
    expect(validateWebhookUrl('https://192.168.1.1/hook')).toBe('Webhook URL must not target private/internal addresses');
    expect(validateWebhookUrl('https://172.16.0.1/hook')).toBe('Webhook URL must not target private/internal addresses');
  });

  it('rejects internal K8s DNS', () => {
    expect(validateWebhookUrl('https://my-service.default.svc.cluster.local/hook')).toBe('Webhook URL must not target private/internal addresses');
  });

  it('rejects invalid URLs', () => {
    expect(validateWebhookUrl('not-a-url')).toBe('Invalid webhook URL');
  });
});
