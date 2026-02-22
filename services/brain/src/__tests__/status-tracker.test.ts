import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock references
// ---------------------------------------------------------------------------

const { mockUpdateJobStatus, mockGetJob, mockListJobs } = vi.hoisted(() => ({
  mockUpdateJobStatus: vi.fn(),
  mockGetJob: vi.fn(),
  mockListJobs: vi.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Mock db.js
// ---------------------------------------------------------------------------

vi.mock('../db.js', () => ({
  updateJobStatus: mockUpdateJobStatus,
  getJob: mockGetJob,
  listJobs: mockListJobs,
}));

// ---------------------------------------------------------------------------
// Mock @bakerst/shared — need Subjects, codec, logger
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
  Subjects: {
    JOBS_DISPATCH: 'bakerst.jobs.dispatch',
    JOBS_STATUS: 'bakerst.jobs.status',
    jobStatus: (jobId: string) => `bakerst.jobs.status.${jobId}`,
  },
  codec: {
    encode: vi.fn((data: unknown) => data),
    decode: vi.fn((data: unknown) => data),
  },
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import { createStatusTracker } from '../status-tracker.js';
import type { JobRow } from '../db.js';

// ---------------------------------------------------------------------------
// Helpers: create a mock NATS subscription with controllable message delivery
// ---------------------------------------------------------------------------

type MessageHandler = (msg: { data: unknown }) => void;

function createMockSubscription() {
  const handlers: MessageHandler[] = [];

  // Make the subscription async-iterable so createStatusTracker's
  // `for await (const msg of sub)` loop works.
  const messages: Array<{ data: unknown }> = [];
  let resolveNext: ((value: IteratorResult<{ data: unknown }>) => void) | null = null;

  const sub = {
    unsubscribe: vi.fn(),
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (messages.length > 0) {
            return Promise.resolve({ value: messages.shift()!, done: false });
          }
          return new Promise<IteratorResult<{ data: unknown }>>((resolve) => {
            resolveNext = resolve;
          });
        },
        return() {
          return Promise.resolve({ value: undefined, done: true as const });
        },
      };
    },
    // Helper to push messages into the subscription
    push(msg: { data: unknown }) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: msg, done: false });
      } else {
        messages.push(msg);
      }
    },
  };

  return sub;
}

function makeNc(sub: ReturnType<typeof createMockSubscription>) {
  return {
    subscribe: vi.fn().mockReturnValue(sub),
    publish: vi.fn(),
    isClosed: vi.fn().mockReturnValue(false),
    drain: vi.fn(),
  } as any;
}

function makeJobRow(overrides?: Partial<JobRow>): JobRow {
  const now = new Date().toISOString();
  return {
    job_id: 'job-1',
    type: 'command',
    source: 'test',
    input: 'echo hello',
    status: 'dispatched',
    worker_id: null,
    result: null,
    error: null,
    duration_ms: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createStatusTracker', () => {
  let sub: ReturnType<typeof createMockSubscription>;
  let nc: ReturnType<typeof makeNc>;

  beforeEach(() => {
    vi.useFakeTimers();
    sub = createMockSubscription();
    nc = makeNc(sub);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists status updates to DB via updateJobStatus', async () => {
    const tracker = createStatusTracker(nc);

    // Push a status message into the subscription
    sub.push({
      data: {
        jobId: 'job-1',
        workerId: 'w1',
        status: 'running',
      },
    });

    // Let the async iterator process
    await vi.advanceTimersByTimeAsync(10);

    expect(mockUpdateJobStatus).toHaveBeenCalledWith({
      jobId: 'job-1',
      workerId: 'w1',
      status: 'running',
      result: undefined,
      error: undefined,
      durationMs: undefined,
    });

    tracker.close();
  });

  it('emits events for terminal statuses (completed/failed)', async () => {
    const tracker = createStatusTracker(nc);

    // Set up a waiter before the event
    mockGetJob.mockReturnValue(undefined); // Not yet in DB

    const waitPromise = tracker.waitForCompletion('job-2', 5000);

    // Push a completed status
    sub.push({
      data: {
        jobId: 'job-2',
        workerId: 'w1',
        status: 'completed',
        result: 'done',
      },
    });

    await vi.advanceTimersByTimeAsync(10);

    const result = await waitPromise;
    expect(result.status).toBe('completed');
    expect(result.result).toBe('done');

    tracker.close();
  });

  it('waitForCompletion resolves immediately if job already completed in DB', async () => {
    mockGetJob.mockReturnValue(
      makeJobRow({
        job_id: 'job-3',
        status: 'completed',
        result: 'already done',
        updated_at: new Date().toISOString(),
      }),
    );

    const tracker = createStatusTracker(nc);

    const result = await tracker.waitForCompletion('job-3', 5000);
    expect(result.status).toBe('completed');
    expect(result.result).toBe('already done');

    tracker.close();
  });

  it('waitForCompletion resolves for failed status in DB', async () => {
    mockGetJob.mockReturnValue(
      makeJobRow({
        job_id: 'job-4',
        status: 'failed',
        error: 'something broke',
        updated_at: new Date().toISOString(),
      }),
    );

    const tracker = createStatusTracker(nc);

    const result = await tracker.waitForCompletion('job-4', 5000);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('something broke');

    tracker.close();
  });

  it('waitForCompletion times out and marks job as failed', async () => {
    // Job not in DB, and no status update will arrive
    mockGetJob.mockReturnValue(undefined);

    const tracker = createStatusTracker(nc);

    const waitPromise = tracker.waitForCompletion('job-5', 1000);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(1100);

    const result = await waitPromise;
    expect(result.status).toBe('timeout');
    expect(result.error).toContain('did not complete within');

    // Should also mark as failed in DB
    expect(mockUpdateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-5',
        workerId: 'timeout',
        status: 'failed',
      }),
    );

    tracker.close();
  });

  it('getStatus returns undefined for unknown job', () => {
    mockGetJob.mockReturnValue(undefined);

    const tracker = createStatusTracker(nc);
    const status = tracker.getStatus('nonexistent');
    expect(status).toBeUndefined();

    tracker.close();
  });

  it('getStatus returns mapped job status from DB', () => {
    mockGetJob.mockReturnValue(
      makeJobRow({
        job_id: 'job-6',
        status: 'running',
        worker_id: 'w1',
      }),
    );

    const tracker = createStatusTracker(nc);
    const status = tracker.getStatus('job-6');

    expect(status).toBeDefined();
    expect(status!.jobId).toBe('job-6');
    expect(status!.status).toBe('running');
    expect(status!.workerId).toBe('w1');

    tracker.close();
  });

  it('getAllStatuses returns all jobs from DB', () => {
    mockListJobs.mockReturnValue([
      makeJobRow({ job_id: 'job-a', status: 'completed' }),
      makeJobRow({ job_id: 'job-b', status: 'failed' }),
    ]);

    const tracker = createStatusTracker(nc);
    const statuses = tracker.getAllStatuses();

    expect(statuses).toHaveLength(2);
    expect(statuses[0].jobId).toBe('job-a');
    expect(statuses[1].jobId).toBe('job-b');

    tracker.close();
  });

  it('zombie reaper marks stuck jobs as failed', async () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();

    mockListJobs.mockReturnValue([
      makeJobRow({
        job_id: 'zombie-1',
        status: 'running',
        worker_id: 'w1',
        updated_at: sixMinutesAgo,
      }),
      makeJobRow({
        job_id: 'zombie-2',
        status: 'dispatched',
        updated_at: sixMinutesAgo,
      }),
      makeJobRow({
        job_id: 'alive',
        status: 'completed',
        updated_at: new Date().toISOString(),
      }),
    ]);

    const tracker = createStatusTracker(nc);

    // Advance past the zombie check interval (60s)
    await vi.advanceTimersByTimeAsync(61_000);

    // Both zombie jobs should be reaped, but not the completed one
    expect(mockUpdateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'zombie-1',
        status: 'failed',
        error: expect.stringContaining('reaped'),
      }),
    );

    expect(mockUpdateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'zombie-2',
        status: 'failed',
        error: expect.stringContaining('reaped'),
      }),
    );

    tracker.close();
  });

  it('close unsubscribes and clears intervals', () => {
    const tracker = createStatusTracker(nc);
    tracker.close();

    expect(sub.unsubscribe).toHaveBeenCalled();
  });
});
