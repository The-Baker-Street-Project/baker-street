import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Mock @bakerst/shared — logger
// ---------------------------------------------------------------------------

vi.mock('@bakerst/shared', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Import module under test after mocks
// ---------------------------------------------------------------------------

import { DoorPolicyManager } from '../door-policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
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
  return db;
}

// ---------------------------------------------------------------------------
// Tests: Sender management
// ---------------------------------------------------------------------------

describe('DoorPolicyManager — sender management', () => {
  let db: Database.Database;
  let policy: DoorPolicyManager;

  beforeEach(() => {
    db = createTestDb();
    policy = new DoorPolicyManager(db, 'card');
  });

  afterEach(() => {
    db.close();
  });

  it('isApproved returns false for unknown senders', () => {
    expect(policy.isApproved('telegram', 'user1')).toBe(false);
  });

  it('approveSender makes isApproved return true', () => {
    policy.approveSender('telegram', 'user1');
    expect(policy.isApproved('telegram', 'user1')).toBe(true);
  });

  it('blockSender makes isBlocked return true', () => {
    policy.blockSender('telegram', 'user1');
    expect(policy.isBlocked('telegram', 'user1')).toBe(true);
    expect(policy.isApproved('telegram', 'user1')).toBe(false);
  });

  it('getStatus returns correct status', () => {
    expect(policy.getStatus('telegram', 'user1')).toBe(null);
    policy.setPending('telegram', 'user1');
    expect(policy.getStatus('telegram', 'user1')).toBe('pending');
    policy.approveSender('telegram', 'user1');
    expect(policy.getStatus('telegram', 'user1')).toBe('approved');
    policy.blockSender('telegram', 'user1');
    expect(policy.getStatus('telegram', 'user1')).toBe('blocked');
  });

  it('listApproved returns approved senders', () => {
    policy.approveSender('telegram', 'user1');
    policy.approveSender('discord', 'user2');
    policy.blockSender('telegram', 'user3');

    const approved = policy.listApproved();
    expect(approved).toHaveLength(2);
    expect(approved.map((a) => a.senderId).sort()).toEqual(['user1', 'user2']);
  });

  it('revokeSender removes a sender', () => {
    policy.approveSender('telegram', 'user1');
    expect(policy.isApproved('telegram', 'user1')).toBe(true);

    const revoked = policy.revokeSender('telegram', 'user1');
    expect(revoked).toBe(true);
    expect(policy.isApproved('telegram', 'user1')).toBe(false);
  });

  it('revokeSender returns false for non-existent sender', () => {
    const revoked = policy.revokeSender('telegram', 'nobody');
    expect(revoked).toBe(false);
  });

  it('approveSender can upgrade a blocked sender', () => {
    policy.blockSender('telegram', 'user1');
    expect(policy.isBlocked('telegram', 'user1')).toBe(true);

    policy.approveSender('telegram', 'user1');
    expect(policy.isApproved('telegram', 'user1')).toBe(true);
    expect(policy.isBlocked('telegram', 'user1')).toBe(false);
  });

  it('senders are scoped by platform', () => {
    policy.approveSender('telegram', 'user1');
    expect(policy.isApproved('telegram', 'user1')).toBe(true);
    expect(policy.isApproved('discord', 'user1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Pairing codes
// ---------------------------------------------------------------------------

describe('DoorPolicyManager — pairing codes', () => {
  let db: Database.Database;
  let policy: DoorPolicyManager;

  beforeEach(() => {
    db = createTestDb();
    policy = new DoorPolicyManager(db, 'card');
  });

  afterEach(() => {
    db.close();
  });

  it('generatePairingCode returns an 8-char alphanumeric code', () => {
    const code = policy.generatePairingCode();
    expect(code).toHaveLength(8);
    expect(/^[A-Z0-9]+$/.test(code)).toBe(true);
  });

  it('generatePairingCode with platform restriction', () => {
    const code = policy.generatePairingCode('telegram');
    expect(code).toHaveLength(8);

    // Verify it's stored with the platform
    const row = db.prepare('SELECT platform FROM pairing_challenges WHERE code = ?').get(code) as { platform: string };
    expect(row.platform).toBe('telegram');
  });

  it('generatePairingCode throws when max pending codes reached', () => {
    policy.generatePairingCode();
    policy.generatePairingCode();
    policy.generatePairingCode();

    expect(() => policy.generatePairingCode()).toThrow('Maximum of 3 pending pairing codes');
  });

  it('attemptPairing succeeds with valid code', () => {
    const code = policy.generatePairingCode();
    const result = policy.attemptPairing('telegram', 'user1', code);

    expect(result.success).toBe(true);
    expect(result.message).toContain('successful');
    expect(policy.isApproved('telegram', 'user1')).toBe(true);
  });

  it('attemptPairing fails with invalid code', () => {
    const result = policy.attemptPairing('telegram', 'user1', 'BADCODE1');

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid or expired');
  });

  it('attemptPairing is case-insensitive', () => {
    const code = policy.generatePairingCode();
    const result = policy.attemptPairing('telegram', 'user1', code.toLowerCase());

    expect(result.success).toBe(true);
  });

  it('attemptPairing rejects code for wrong platform', () => {
    const code = policy.generatePairingCode('telegram');
    const result = policy.attemptPairing('discord', 'user1', code);

    expect(result.success).toBe(false);
    expect(result.message).toContain('different platform');
  });

  it('attemptPairing rejects expired code', () => {
    // Insert a code that's already expired
    db.prepare(`
      INSERT INTO pairing_challenges (code, platform, expires_at)
      VALUES (?, NULL, datetime('now', '-1 minute'))
    `).run('EXPIRED1');

    const result = policy.attemptPairing('telegram', 'user1', 'EXPIRED1');
    expect(result.success).toBe(false);
  });

  it('pairing code is consumed after successful use', () => {
    const code = policy.generatePairingCode();
    policy.attemptPairing('telegram', 'user1', code);

    // Same code should fail for a different user
    const result = policy.attemptPairing('telegram', 'user2', code);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: importAllowlist
// ---------------------------------------------------------------------------

describe('DoorPolicyManager — importAllowlist', () => {
  let db: Database.Database;
  let policy: DoorPolicyManager;

  beforeEach(() => {
    db = createTestDb();
    policy = new DoorPolicyManager(db, 'card');
  });

  afterEach(() => {
    db.close();
  });

  it('imports IDs as approved senders', () => {
    policy.importAllowlist('telegram', ['123', '456']);

    expect(policy.isApproved('telegram', '123')).toBe(true);
    expect(policy.isApproved('telegram', '456')).toBe(true);
  });

  it('does not overwrite existing entries', () => {
    policy.blockSender('telegram', '123');
    policy.importAllowlist('telegram', ['123', '456']);

    // 123 was already blocked, should stay blocked (ON CONFLICT DO NOTHING)
    expect(policy.isBlocked('telegram', '123')).toBe(true);
    // 456 is new, should be approved
    expect(policy.isApproved('telegram', '456')).toBe(true);
  });

  it('does nothing with empty array', () => {
    policy.importAllowlist('telegram', []);
    expect(policy.listApproved()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: checkMessage — open mode
// ---------------------------------------------------------------------------

describe('DoorPolicyManager — checkMessage (open mode)', () => {
  let db: Database.Database;
  let policy: DoorPolicyManager;

  beforeEach(() => {
    db = createTestDb();
    policy = new DoorPolicyManager(db, 'open');
  });

  afterEach(() => {
    db.close();
  });

  it('allows all messages', () => {
    const result = policy.checkMessage('telegram', 'anyone', 'hello');
    expect(result.action).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Tests: checkMessage — list mode
// ---------------------------------------------------------------------------

describe('DoorPolicyManager — checkMessage (list mode)', () => {
  let db: Database.Database;
  let policy: DoorPolicyManager;

  beforeEach(() => {
    db = createTestDb();
    policy = new DoorPolicyManager(db, 'list');
  });

  afterEach(() => {
    db.close();
  });

  it('allows when no static list configured', () => {
    const result = policy.checkMessage('telegram', 'anyone', 'hello');
    expect(result.action).toBe('allow');
  });

  it('allows sender in static list', () => {
    const result = policy.checkMessage('telegram', '123', 'hello', ['123', '456']);
    expect(result.action).toBe('allow');
  });

  it('denies sender not in static list', () => {
    const result = policy.checkMessage('telegram', '789', 'hello', ['123', '456']);
    expect(result.action).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Tests: checkMessage — landlord mode
// ---------------------------------------------------------------------------

describe('DoorPolicyManager — checkMessage (landlord mode)', () => {
  let db: Database.Database;
  let policy: DoorPolicyManager;

  beforeEach(() => {
    db = createTestDb();
    policy = new DoorPolicyManager(db, 'landlord');
  });

  afterEach(() => {
    db.close();
  });

  it('auto-approves first sender as owner', () => {
    const result = policy.checkMessage('telegram', 'user1', 'hello');
    expect(result.action).toBe('allow');
    expect(policy.isApproved('telegram', 'user1')).toBe(true);
  });

  it('denies subsequent senders', () => {
    policy.checkMessage('telegram', 'user1', 'hello');

    const result = policy.checkMessage('telegram', 'user2', 'hello');
    expect(result.action).toBe('deny');
  });

  it('allows owner on subsequent messages', () => {
    policy.checkMessage('telegram', 'user1', 'first');
    const result = policy.checkMessage('telegram', 'user1', 'second');
    expect(result.action).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Tests: checkMessage — card mode
// ---------------------------------------------------------------------------

describe('DoorPolicyManager — checkMessage (card mode)', () => {
  let db: Database.Database;
  let policy: DoorPolicyManager;

  beforeEach(() => {
    db = createTestDb();
    policy = new DoorPolicyManager(db, 'card');
  });

  afterEach(() => {
    db.close();
  });

  it('allows approved senders', () => {
    policy.approveSender('telegram', 'user1');
    const result = policy.checkMessage('telegram', 'user1', 'hello');
    expect(result.action).toBe('allow');
  });

  it('denies blocked senders', () => {
    policy.blockSender('telegram', 'user1');
    const result = policy.checkMessage('telegram', 'user1', 'hello');
    expect(result.action).toBe('deny');
  });

  it('challenges unknown senders', () => {
    const result = policy.checkMessage('telegram', 'newuser', 'hello');
    expect(result.action).toBe('challenge');
    if (result.action === 'challenge') {
      expect(result.message).toContain('pairing code');
    }
  });

  it('sets unknown sender to pending after challenge', () => {
    policy.checkMessage('telegram', 'newuser', 'hello');
    expect(policy.getStatus('telegram', 'newuser')).toBe('pending');
  });

  it('detects pairing code from pending sender', () => {
    // First message — sets pending
    policy.checkMessage('telegram', 'newuser', 'hello');

    // Second message that looks like a code
    const result = policy.checkMessage('telegram', 'newuser', 'ABCD1234');
    expect(result.action).toBe('validate_code');
    if (result.action === 'validate_code') {
      expect(result.code).toBe('ABCD1234');
    }
  });

  it('re-challenges pending sender with non-code message', () => {
    // First message — sets pending
    policy.checkMessage('telegram', 'newuser', 'hello');

    // Second message that doesn't look like a code
    const result = policy.checkMessage('telegram', 'newuser', 'this is a regular message');
    expect(result.action).toBe('challenge');
  });

  it('full pairing flow: challenge -> code -> approved', () => {
    // Step 1: Unknown sender sends message -> challenge
    const r1 = policy.checkMessage('telegram', 'newuser', 'hello');
    expect(r1.action).toBe('challenge');

    // Step 2: Admin generates pairing code
    const code = policy.generatePairingCode();

    // Step 3: Sender submits code -> validate_code
    const r2 = policy.checkMessage('telegram', 'newuser', code);
    expect(r2.action).toBe('validate_code');

    // Step 4: Code is validated
    if (r2.action === 'validate_code') {
      const result = policy.attemptPairing('telegram', 'newuser', r2.code);
      expect(result.success).toBe(true);
    }

    // Step 5: Next message should be allowed
    const r3 = policy.checkMessage('telegram', 'newuser', 'hello again');
    expect(r3.action).toBe('allow');
  });
});
