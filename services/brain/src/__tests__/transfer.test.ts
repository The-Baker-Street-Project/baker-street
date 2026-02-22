import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock references
// ---------------------------------------------------------------------------

const {
  mockInsertHandoffNote,
  mockGetLatestHandoffNote,
  mockListConversations,
  mockListSchedules,
} = vi.hoisted(() => ({
  mockInsertHandoffNote: vi.fn(),
  mockGetLatestHandoffNote: vi.fn(),
  mockListConversations: vi.fn().mockReturnValue([]),
  mockListSchedules: vi.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../db.js', () => ({
  insertHandoffNote: mockInsertHandoffNote,
  getLatestHandoffNote: mockGetLatestHandoffNote,
  listConversations: mockListConversations,
  listSchedules: mockListSchedules,
}));

vi.mock('@bakerst/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bakerst/shared')>();
  return {
    ...actual,
    logger: {
      child: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { TransferHandler } from '../transfer.js';
import { BrainStateMachine } from '../brain-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNc() {
  return {
    publish: vi.fn(),
    subscribe: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}), // never resolves by default
      }),
      unsubscribe: vi.fn(),
    }),
  } as any;
}

function makeConversation(id: string, updatedAt: string) {
  return {
    id,
    title: `Conversation ${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: updatedAt,
  };
}

function makeSchedule(id: string, enabled: number) {
  return {
    id,
    name: `Schedule ${id}`,
    schedule: '0 9 * * *',
    type: 'agent',
    config: '{"job":"test"}',
    enabled,
    last_run_at: null,
    last_status: null,
    last_output: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransferHandler', () => {
  let nc: ReturnType<typeof makeNc>;
  let sm: BrainStateMachine;

  beforeEach(() => {
    nc = makeNc();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('construction', () => {
    it('creates an instance with nc, stateMachine, and version', () => {
      sm = new BrainStateMachine('active');
      const handler = new TransferHandler(nc, sm, '1.0.0');
      expect(handler).toBeDefined();
      handler.stop();
    });
  });

  describe('writeHandoffNote', () => {
    it('inserts a handoff note with recent conversations and enabled schedules', async () => {
      sm = new BrainStateMachine('active');
      const handler = new TransferHandler(nc, sm, '1.0.0');

      const now = new Date().toISOString();
      const recentConv = makeConversation('conv-1', now);
      const oldConv = makeConversation('conv-old', '2020-01-01T00:00:00.000Z');
      mockListConversations.mockReturnValue([recentConv, oldConv]);

      const enabledSched = makeSchedule('sched-1', 1);
      const disabledSched = makeSchedule('sched-2', 0);
      mockListSchedules.mockReturnValue([enabledSched, disabledSched]);

      const noteId = await handler.writeHandoffNote('2.0.0');

      expect(noteId).toBeDefined();
      expect(typeof noteId).toBe('string');
      expect(mockInsertHandoffNote).toHaveBeenCalledTimes(1);

      const insertArgs = mockInsertHandoffNote.mock.calls[0][0];
      expect(insertArgs.id).toBe(noteId);
      expect(insertArgs.fromVersion).toBe('1.0.0');
      expect(insertArgs.toVersion).toBe('2.0.0');
      expect(insertArgs.createdAt).toBeDefined();

      // Should only include recent conversation (within 24h)
      const conversations = JSON.parse(insertArgs.activeConversations);
      expect(conversations).toHaveLength(1);
      expect(conversations[0].id).toBe('conv-1');

      // Should only include enabled schedules
      const schedules = JSON.parse(insertArgs.pendingSchedules);
      expect(schedules).toHaveLength(1);
      expect(schedules[0].id).toBe('sched-1');

      handler.stop();
    });

    it('handles no conversations or schedules gracefully', async () => {
      sm = new BrainStateMachine('active');
      const handler = new TransferHandler(nc, sm, '1.0.0');

      mockListConversations.mockReturnValue([]);
      mockListSchedules.mockReturnValue([]);

      const noteId = await handler.writeHandoffNote();

      expect(noteId).toBeDefined();
      expect(mockInsertHandoffNote).toHaveBeenCalledTimes(1);

      const insertArgs = mockInsertHandoffNote.mock.calls[0][0];
      expect(insertArgs.toVersion).toBeUndefined();
      const conversations = JSON.parse(insertArgs.activeConversations);
      expect(conversations).toHaveLength(0);
      const schedules = JSON.parse(insertArgs.pendingSchedules);
      expect(schedules).toHaveLength(0);

      handler.stop();
    });
  });

  describe('readHandoffNote', () => {
    it('returns the latest handoff note from db', () => {
      sm = new BrainStateMachine('active');
      const handler = new TransferHandler(nc, sm, '1.0.0');

      const mockNote = {
        id: 'note-1',
        from_version: '1.0.0',
        to_version: '2.0.0',
        active_conversations: '[]',
        pending_schedules: '[]',
        agent_notes: null,
        created_at: '2026-01-01T00:00:00.000Z',
      };
      mockGetLatestHandoffNote.mockReturnValue(mockNote);

      const note = handler.readHandoffNote();
      expect(note).toEqual(mockNote);
      expect(mockGetLatestHandoffNote).toHaveBeenCalledTimes(1);

      handler.stop();
    });

    it('returns undefined when no handoff note exists', () => {
      sm = new BrainStateMachine('active');
      const handler = new TransferHandler(nc, sm, '1.0.0');

      mockGetLatestHandoffNote.mockReturnValue(undefined);

      const note = handler.readHandoffNote();
      expect(note).toBeUndefined();

      handler.stop();
    });
  });

  describe('startListening', () => {
    it('subscribes to TRANSFER_READY when active', async () => {
      sm = new BrainStateMachine('active');
      const handler = new TransferHandler(nc, sm, '1.0.0');

      await handler.startListening();

      expect(nc.subscribe).toHaveBeenCalledWith('bakerst.brain.transfer.ready');

      handler.stop();
    });

    it('publishes TRANSFER_READY and subscribes to TRANSFER_CLEAR when pending', async () => {
      sm = new BrainStateMachine('pending');
      const handler = new TransferHandler(nc, sm, '2.0.0');

      // Override subscribe to not block with the default never-resolving async iterator
      // but still track calls. We need to handle the activation timeout.
      const noResponseTimeout = 120_000;

      // Use fake timers to fast-forward the NO_RESPONSE_TIMEOUT
      vi.useFakeTimers();

      const listenPromise = handler.startListening();

      // The handler publishes TRANSFER_READY
      expect(nc.publish).toHaveBeenCalledWith(
        'bakerst.brain.transfer.ready',
        expect.any(Uint8Array),
      );

      // Subscribed to TRANSFER_CLEAR and TRANSFER_ABORT
      expect(nc.subscribe).toHaveBeenCalledWith('bakerst.brain.transfer.clear');
      expect(nc.subscribe).toHaveBeenCalledWith('bakerst.brain.transfer.abort');

      // Fast forward past NO_RESPONSE_TIMEOUT to trigger fresh start
      vi.advanceTimersByTime(noResponseTimeout + 100);

      await listenPromise;

      // After timeout, the pending brain should activate
      expect(sm.state).toBe('active');

      vi.useRealTimers();
      handler.stop();
    });

    it('does nothing when state is neither active nor pending', async () => {
      // Start as active, then drain to get to draining state
      sm = new BrainStateMachine('active');
      sm.drain();
      const handler = new TransferHandler(nc, sm, '1.0.0');

      await handler.startListening();

      // Should not subscribe or publish anything
      expect(nc.subscribe).not.toHaveBeenCalled();
      expect(nc.publish).not.toHaveBeenCalled();

      handler.stop();
    });
  });
});
