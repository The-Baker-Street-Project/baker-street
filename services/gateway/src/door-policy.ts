import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { logger } from '@bakerst/shared';
import type { DoorPolicyMode, DoorPolicyEntry, SenderStatus, DoorPolicyCheckResult } from './types.js';

const log = logger.child({ module: 'door-policy' });

const PAIRING_CODE_LENGTH = 8;
const PAIRING_TTL_MINUTES = 5;
const MAX_PENDING_CODES = 3;

// Alphanumeric charset for readable pairing codes (no ambiguous chars)
const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += CODE_CHARSET[bytes[i] % CODE_CHARSET.length];
  }
  return code;
}

export class DoorPolicyManager {
  private db: Database.Database;
  private mode: DoorPolicyMode;

  constructor(db: Database.Database, mode: DoorPolicyMode = 'open') {
    this.db = db;
    this.mode = mode;
    log.info({ mode }, 'door policy initialized');
  }

  getMode(): DoorPolicyMode {
    return this.mode;
  }

  // ---------------------------------------------------------------------------
  // Sender management
  // ---------------------------------------------------------------------------

  isApproved(platform: string, senderId: string): boolean {
    const row = this.db
      .prepare('SELECT status FROM door_policy WHERE platform = ? AND sender_id = ?')
      .get(platform, senderId) as { status: SenderStatus } | undefined;
    return row?.status === 'approved';
  }

  isBlocked(platform: string, senderId: string): boolean {
    const row = this.db
      .prepare('SELECT status FROM door_policy WHERE platform = ? AND sender_id = ?')
      .get(platform, senderId) as { status: SenderStatus } | undefined;
    return row?.status === 'blocked';
  }

  getStatus(platform: string, senderId: string): SenderStatus | null {
    const row = this.db
      .prepare('SELECT status FROM door_policy WHERE platform = ? AND sender_id = ?')
      .get(platform, senderId) as { status: SenderStatus } | undefined;
    return row?.status ?? null;
  }

  approveSender(platform: string, senderId: string): void {
    this.db.prepare(`
      INSERT INTO door_policy (platform, sender_id, status, paired_at)
      VALUES (?, ?, 'approved', datetime('now'))
      ON CONFLICT (platform, sender_id) DO UPDATE SET
        status = 'approved',
        paired_at = datetime('now')
    `).run(platform, senderId);
    log.info({ platform, senderId }, 'sender approved');
  }

  blockSender(platform: string, senderId: string): void {
    this.db.prepare(`
      INSERT INTO door_policy (platform, sender_id, status)
      VALUES (?, ?, 'blocked')
      ON CONFLICT (platform, sender_id) DO UPDATE SET
        status = 'blocked'
    `).run(platform, senderId);
    log.info({ platform, senderId }, 'sender blocked');
  }

  setPending(platform: string, senderId: string): void {
    this.db.prepare(`
      INSERT INTO door_policy (platform, sender_id, status)
      VALUES (?, ?, 'pending')
      ON CONFLICT (platform, sender_id) DO UPDATE SET
        status = 'pending'
    `).run(platform, senderId);
  }

  listApproved(): Array<{ platform: string; senderId: string; pairedAt: string }> {
    const rows = this.db
      .prepare("SELECT platform, sender_id, paired_at FROM door_policy WHERE status = 'approved' ORDER BY paired_at DESC")
      .all() as Array<{ platform: string; sender_id: string; paired_at: string }>;
    return rows.map((r) => ({
      platform: r.platform,
      senderId: r.sender_id,
      pairedAt: r.paired_at,
    }));
  }

  revokeSender(platform: string, senderId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM door_policy WHERE platform = ? AND sender_id = ?')
      .run(platform, senderId);
    if (result.changes > 0) {
      log.info({ platform, senderId }, 'sender revoked');
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Pairing codes
  // ---------------------------------------------------------------------------

  generatePairingCode(platform?: string): string {
    // Clean up expired codes first
    this.db.prepare("DELETE FROM pairing_challenges WHERE expires_at < datetime('now')").run();

    // Check max pending codes
    const count = this.db
      .prepare('SELECT COUNT(*) as cnt FROM pairing_challenges')
      .get() as { cnt: number };
    if (count.cnt >= MAX_PENDING_CODES) {
      throw new Error(`Maximum of ${MAX_PENDING_CODES} pending pairing codes reached`);
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MINUTES * 60 * 1000).toISOString();

    this.db.prepare(`
      INSERT INTO pairing_challenges (code, platform, expires_at)
      VALUES (?, ?, ?)
    `).run(code, platform ?? null, expiresAt);

    log.info({ code, platform: platform ?? 'any', expiresAt }, 'pairing code generated');
    return code;
  }

  attemptPairing(
    platform: string,
    senderId: string,
    code: string,
  ): { success: boolean; message: string } {
    // Clean up expired codes
    this.db.prepare("DELETE FROM pairing_challenges WHERE expires_at < datetime('now')").run();

    // Normalize code to uppercase for comparison
    const normalizedCode = code.trim().toUpperCase();

    const challenge = this.db
      .prepare('SELECT code, platform, expires_at FROM pairing_challenges WHERE code = ?')
      .get(normalizedCode) as { code: string; platform: string | null; expires_at: string } | undefined;

    if (!challenge) {
      return { success: false, message: 'Invalid or expired pairing code.' };
    }

    // Check platform restriction
    if (challenge.platform && challenge.platform !== platform) {
      return { success: false, message: 'This pairing code is for a different platform.' };
    }

    // Check expiration (belt and suspenders — cleanup above should handle this)
    if (new Date(challenge.expires_at) < new Date()) {
      this.db.prepare('DELETE FROM pairing_challenges WHERE code = ?').run(normalizedCode);
      return { success: false, message: 'Pairing code has expired.' };
    }

    // Pairing successful — approve sender, delete the code
    this.approveSender(platform, senderId);
    this.db.prepare('DELETE FROM pairing_challenges WHERE code = ?').run(normalizedCode);

    log.info({ platform, senderId, code: normalizedCode }, 'pairing successful');
    return { success: true, message: 'Pairing successful! You are now approved.' };
  }

  // ---------------------------------------------------------------------------
  // Auto-import static allowlists
  // ---------------------------------------------------------------------------

  importAllowlist(platform: string, allowedIds: string[]): void {
    if (allowedIds.length === 0) return;

    const insert = this.db.prepare(`
      INSERT INTO door_policy (platform, sender_id, status, paired_at)
      VALUES (?, ?, 'approved', datetime('now'))
      ON CONFLICT (platform, sender_id) DO NOTHING
    `);

    const importMany = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        insert.run(platform, id);
      }
    });

    importMany(allowedIds);
    log.info({ platform, count: allowedIds.length }, 'imported static allowlist as pre-approved senders');
  }

  // ---------------------------------------------------------------------------
  // Policy check — main entry point for message handling
  // ---------------------------------------------------------------------------

  checkMessage(
    platform: string,
    senderId: string,
    messageText: string,
    staticAllowed?: string[],
  ): DoorPolicyCheckResult {
    switch (this.mode) {
      case 'open':
        return { action: 'allow' };

      case 'list':
        if (!staticAllowed || staticAllowed.length === 0) {
          // No list configured = allow all (matches current behavior)
          return { action: 'allow' };
        }
        return staticAllowed.includes(senderId)
          ? { action: 'allow' }
          : { action: 'deny' };

      case 'landlord': {
        // First approved sender becomes the owner
        const approved = this.listApproved();
        if (approved.length === 0) {
          // No one approved yet — first sender becomes owner
          this.approveSender(platform, senderId);
          return { action: 'allow' };
        }
        return this.isApproved(platform, senderId)
          ? { action: 'allow' }
          : { action: 'deny' };
      }

      case 'card': {
        // Check if approved
        if (this.isApproved(platform, senderId)) {
          return { action: 'allow' };
        }

        // Check if blocked
        if (this.isBlocked(platform, senderId)) {
          return { action: 'deny' };
        }

        const status = this.getStatus(platform, senderId);

        if (status === 'pending') {
          // Sender is pending — check if message looks like a pairing code
          const trimmed = messageText.trim().toUpperCase();
          if (/^[A-Z0-9]{6,10}$/.test(trimmed)) {
            return { action: 'validate_code', code: trimmed };
          }
          // Not a code — re-challenge
          return {
            action: 'challenge',
            message: 'Please enter your pairing code to continue. You can get a code from the system administrator.',
          };
        }

        // Unknown sender — set pending and challenge
        this.setPending(platform, senderId);
        return {
          action: 'challenge',
          message:
            'Welcome! This system requires a pairing code to access. ' +
            'Please enter your pairing code, or contact the system administrator to get one.',
        };
      }

      default:
        log.warn({ mode: this.mode }, 'unknown door policy mode, defaulting to open');
        return { action: 'allow' };
    }
  }
}
