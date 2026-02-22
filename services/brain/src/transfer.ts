import { randomUUID } from 'node:crypto';
import type { NatsConnection, Subscription } from 'nats';
import {
  codec,
  Subjects,
  logger,
  type TransferReady,
  type TransferClear,
  type TransferAck,
  type TransferAbort,
} from '@bakerst/shared';
import type { BrainStateMachine } from './brain-state.js';
import {
  insertHandoffNote,
  getLatestHandoffNote,
  listConversations,
  listSchedules,
  type HandoffNoteRow,
} from './db.js';

const log = logger.child({ module: 'transfer' });

/** Timeout for a pending brain waiting for a TRANSFER_CLEAR from the active brain.
 *  Set to 120s to allow the active brain time to drain in-flight requests before sending CLEAR. */
const NO_RESPONSE_TIMEOUT = 120_000;
/** Timeout for the active brain to finish draining in-flight requests. */
const DRAIN_TIMEOUT = 60_000;
/** Timeout for the active brain waiting for ACK from the new brain. */
const ACK_TIMEOUT = 30_000;

export class TransferHandler {
  private nc: NatsConnection;
  private stateMachine: BrainStateMachine;
  private version: string;
  private subscriptions: Subscription[] = [];
  private timers: NodeJS.Timeout[] = [];

  /** The handoff note read by the new brain after receiving TRANSFER_CLEAR. */
  public lastHandoffNote: HandoffNoteRow | undefined;

  constructor(nc: NatsConnection, stateMachine: BrainStateMachine, version: string) {
    this.nc = nc;
    this.stateMachine = stateMachine;
    this.version = version;
  }

  /**
   * Start listening on transfer subjects based on current role.
   * - If active: subscribe to TRANSFER_READY (incoming new brain announcements)
   * - If pending: publish TRANSFER_READY and subscribe to TRANSFER_CLEAR
   */
  async startListening(): Promise<void> {
    if (this.stateMachine.state === 'active') {
      await this.startAsActive();
    } else if (this.stateMachine.state === 'pending') {
      await this.startAsPending();
    }
  }

  /**
   * Active brain: listen for a new brain announcing itself.
   */
  private async startAsActive(): Promise<void> {
    log.info({ version: this.version }, 'active brain listening for transfer requests');

    const sub = this.nc.subscribe(Subjects.TRANSFER_READY);
    this.subscriptions.push(sub);

    // Process incoming TRANSFER_READY messages
    (async () => {
      for await (const msg of sub) {
        try {
          const data = codec.decode(msg.data) as TransferReady;
          log.info({ newBrainId: data.id, newVersion: data.version }, 'received TRANSFER_READY from new brain');
          await this.handleTransferReady(data);
        } catch (err) {
          log.error({ err }, 'error handling TRANSFER_READY');
        }
        // Only handle the first TRANSFER_READY, then unsubscribe
        break;
      }
    })();
  }

  /**
   * Handle TRANSFER_READY: drain, write handoff note, publish CLEAR, wait for ACK.
   */
  private async handleTransferReady(data: TransferReady): Promise<void> {
    try {
      // Transition to draining
      this.stateMachine.drain();
      log.info('brain entering draining state');

      // Wait for in-flight requests to complete (simple delay)
      await this.waitForDrain();

      // Write handoff note
      const noteId = await this.writeHandoffNote(data.version);
      log.info({ noteId }, 'handoff note written');

      // Publish TRANSFER_CLEAR
      const clearMsg: TransferClear = {
        id: this.version,
        handoffNoteId: noteId,
        timestamp: new Date().toISOString(),
      };
      this.nc.publish(Subjects.TRANSFER_CLEAR, codec.encode(clearMsg));
      log.info('published TRANSFER_CLEAR');

      // Wait for ACK from new brain
      const ackReceived = await this.waitForAck();
      if (ackReceived) {
        log.info('received TRANSFER_ACK, shutting down');
        this.stateMachine.shutdown();
      } else {
        log.warn('ACK timeout, shutting down anyway');
        this.stateMachine.shutdown();
      }
    } catch (err) {
      log.error({ err }, 'transfer handoff failed, aborting');
      const abortMsg: TransferAbort = {
        id: this.version,
        reason: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      };
      this.nc.publish(Subjects.TRANSFER_ABORT, codec.encode(abortMsg));
    }
  }

  /**
   * Pending brain: announce ourselves and wait for CLEAR from active brain.
   */
  private async startAsPending(): Promise<void> {
    log.info({ version: this.version }, 'pending brain announcing and waiting for handoff');

    // Subscribe to TRANSFER_CLEAR before publishing READY
    const clearSub = this.nc.subscribe(Subjects.TRANSFER_CLEAR);
    this.subscriptions.push(clearSub);

    // Also subscribe to TRANSFER_ABORT
    const abortSub = this.nc.subscribe(Subjects.TRANSFER_ABORT);
    this.subscriptions.push(abortSub);

    // Publish TRANSFER_READY
    const readyMsg: TransferReady = {
      id: randomUUID(),
      version: this.version,
      timestamp: new Date().toISOString(),
    };
    this.nc.publish(Subjects.TRANSFER_READY, codec.encode(readyMsg));
    log.info('published TRANSFER_READY');

    // Race: wait for TRANSFER_CLEAR or timeout (fresh start)
    const clearReceived = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        log.info('no active brain responded, assuming fresh start');
        resolve(false);
      }, NO_RESPONSE_TIMEOUT);
      this.timers.push(timeout);

      // Process TRANSFER_CLEAR
      (async () => {
        for await (const msg of clearSub) {
          clearTimeout(timeout);
          try {
            const data = codec.decode(msg.data) as TransferClear;
            log.info({ fromId: data.id, handoffNoteId: data.handoffNoteId }, 'received TRANSFER_CLEAR');

            // Read the handoff note left by the old brain
            const note = this.readHandoffNote();
            if (note) {
              this.lastHandoffNote = note;
              const conversations = note.active_conversations ? JSON.parse(note.active_conversations) : [];
              const schedules = note.pending_schedules ? JSON.parse(note.pending_schedules) : [];
              log.info(
                { handoffNoteId: note.id, conversationCount: conversations.length, scheduleCount: schedules.length },
                'read handoff note from previous brain',
              );
            } else {
              log.warn({ handoffNoteId: data.handoffNoteId }, 'handoff note not found in database');
            }
          } catch (err) {
            log.error({ err }, 'error decoding TRANSFER_CLEAR');
          }
          resolve(true);
          break;
        }
      })();

      // Process TRANSFER_ABORT
      (async () => {
        for await (const msg of abortSub) {
          clearTimeout(timeout);
          try {
            const data = codec.decode(msg.data) as TransferAbort;
            log.warn({ fromId: data.id, reason: data.reason }, 'received TRANSFER_ABORT');
          } catch (err) {
            log.error({ err }, 'error decoding TRANSFER_ABORT');
          }
          // On abort, still activate (fresh start)
          resolve(false);
          break;
        }
      })();
    });

    // Activate
    this.stateMachine.activate();
    log.info({ fromHandoff: clearReceived }, 'brain activated');

    // If we got a CLEAR, send ACK
    if (clearReceived) {
      const ackMsg: TransferAck = {
        id: randomUUID(),
        version: this.version,
        timestamp: new Date().toISOString(),
      };
      this.nc.publish(Subjects.TRANSFER_ACK, codec.encode(ackMsg));
      log.info('published TRANSFER_ACK');
    }

    // Clean up subscriptions
    this.cleanup();
  }

  /**
   * Write a handoff note with current state context.
   */
  async writeHandoffNote(toVersion?: string): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Gather recent conversations (last 24h)
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const conversations = listConversations(100).filter(
      (c) => c.updated_at >= cutoff,
    );

    // Gather enabled schedules
    const schedules = listSchedules().filter((s) => s.enabled === 1);

    insertHandoffNote({
      id,
      fromVersion: this.version,
      toVersion,
      activeConversations: JSON.stringify(
        conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at })),
      ),
      pendingSchedules: JSON.stringify(
        schedules.map((s) => ({ id: s.id, name: s.name, schedule: s.schedule })),
      ),
      createdAt: now,
    });

    return id;
  }

  /**
   * Read the latest handoff note.
   */
  readHandoffNote(): HandoffNoteRow | undefined {
    return getLatestHandoffNote();
  }

  /**
   * Wait for in-flight requests to complete.
   * Simple implementation: wait a fixed period to let in-flight requests drain.
   */
  private waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(DRAIN_TIMEOUT, 5_000));
      this.timers.push(timer);
    });
  }

  /**
   * Wait for ACK from the new brain within the ACK_TIMEOUT.
   */
  private waitForAck(): Promise<boolean> {
    return new Promise((resolve) => {
      const ackSub = this.nc.subscribe(Subjects.TRANSFER_ACK);
      this.subscriptions.push(ackSub);

      const timeout = setTimeout(() => {
        ackSub.unsubscribe();
        resolve(false);
      }, ACK_TIMEOUT);
      this.timers.push(timeout);

      (async () => {
        for await (const msg of ackSub) {
          clearTimeout(timeout);
          try {
            const data = codec.decode(msg.data) as TransferAck;
            log.info({ ackId: data.id, ackVersion: data.version }, 'received TRANSFER_ACK');
          } catch (err) {
            log.error({ err }, 'error decoding TRANSFER_ACK');
          }
          resolve(true);
          break;
        }
      })();
    });
  }

  /**
   * Cleanup all subscriptions and timers.
   */
  private cleanup(): void {
    for (const sub of this.subscriptions) {
      try {
        sub.unsubscribe();
      } catch {
        // already unsubscribed
      }
    }
    this.subscriptions = [];
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }

  /**
   * Stop the transfer handler, cleaning up resources.
   */
  stop(): void {
    this.cleanup();
  }
}
