import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock references
// ---------------------------------------------------------------------------

const { mockExecuteJob } = vi.hoisted(() => ({
  mockExecuteJob: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @bakerst/shared — withSpan executes the function directly, extractTraceContext
// is a no-op, and we provide stubs for Subjects, codec, and logger.
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
  withSpan: vi.fn(async (_name: string, _attrs: Record<string, unknown>, fn: (span: any) => Promise<any>, _parentCtx?: any) => {
    const mockSpan = {
      spanContext: () => ({ traceId: 'test-trace-id-000', spanId: 'test-span-id' }),
    };
    return fn(mockSpan);
  }),
  extractTraceContext: vi.fn(() => undefined),
}));

// ---------------------------------------------------------------------------
// Mock the actions module
// ---------------------------------------------------------------------------

vi.mock('../actions.js', () => ({
  executeJob: mockExecuteJob,
}));

// ---------------------------------------------------------------------------
// Import module under test after mocks
// ---------------------------------------------------------------------------

import { createWorker } from '../worker.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNatsConnection() {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(),
    isClosed: vi.fn().mockReturnValue(false),
    drain: vi.fn(),
  } as any;
}

function makeModelRouter() {
  return {
    useOAuth: false,
    routerConfig: {
      roles: { agent: 'sonnet', observer: 'haiku' },
      models: [],
      providers: {},
    },
    chat: vi.fn(),
    chatStream: vi.fn(),
    updateConfig: vi.fn(),
    setOnApiCall: vi.fn(),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWorker', () => {
  let nc: ReturnType<typeof makeNatsConnection>;
  let modelRouter: ReturnType<typeof makeModelRouter>;

  beforeEach(() => {
    nc = makeNatsConnection();
    modelRouter = makeModelRouter();
    vi.clearAllMocks();
  });

  it('publishes received, running, completed statuses on success', async () => {
    mockExecuteJob.mockResolvedValue('job output');

    const worker = createWorker(nc, 'worker-1', modelRouter);
    await worker.handleJob({
      jobId: 'job-1',
      type: 'command',
      command: 'echo hello',
      createdAt: new Date().toISOString(),
    });

    // Should have published 3 status messages: received, running, completed
    expect(nc.publish).toHaveBeenCalledTimes(3);

    const calls = nc.publish.mock.calls;

    // All calls should target the correct NATS subject
    for (const call of calls) {
      expect(call[0]).toBe('bakerst.jobs.status.job-1');
    }

    // First call: received
    expect(calls[0][1]).toMatchObject({
      jobId: 'job-1',
      workerId: 'worker-1',
      status: 'received',
    });

    // Second call: running
    expect(calls[1][1]).toMatchObject({
      jobId: 'job-1',
      workerId: 'worker-1',
      status: 'running',
    });

    // Third call: completed with result
    expect(calls[2][1]).toMatchObject({
      jobId: 'job-1',
      workerId: 'worker-1',
      status: 'completed',
      result: 'job output',
    });
  });

  it('publishes received, running, failed statuses on error', async () => {
    mockExecuteJob.mockRejectedValue(new Error('something broke'));

    const worker = createWorker(nc, 'worker-1', modelRouter);
    await worker.handleJob({
      jobId: 'job-2',
      type: 'command',
      command: 'fail',
      createdAt: new Date().toISOString(),
    });

    expect(nc.publish).toHaveBeenCalledTimes(3);

    const calls = nc.publish.mock.calls;

    // First: received
    expect(calls[0][1]).toMatchObject({
      jobId: 'job-2',
      status: 'received',
    });

    // Second: running
    expect(calls[1][1]).toMatchObject({
      jobId: 'job-2',
      status: 'running',
    });

    // Third: failed with error
    expect(calls[2][1]).toMatchObject({
      jobId: 'job-2',
      status: 'failed',
      error: 'something broke',
    });
  });

  it('includes traceId in all status messages', async () => {
    mockExecuteJob.mockResolvedValue('ok');

    const worker = createWorker(nc, 'worker-1', modelRouter);
    await worker.handleJob({
      jobId: 'job-3',
      type: 'agent',
      job: 'test',
      createdAt: new Date().toISOString(),
    });

    const calls = nc.publish.mock.calls;
    for (const call of calls) {
      expect(call[1].traceId).toBe('test-trace-id-000');
    }
  });

  it('includes durationMs in completed status', async () => {
    mockExecuteJob.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('done'), 10)),
    );

    const worker = createWorker(nc, 'worker-1', modelRouter);
    await worker.handleJob({
      jobId: 'job-4',
      type: 'command',
      command: 'date',
      createdAt: new Date().toISOString(),
    });

    const completedCall = nc.publish.mock.calls[2];
    expect(completedCall[1].status).toBe('completed');
    expect(completedCall[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof completedCall[1].durationMs).toBe('number');
  });

  it('includes durationMs in failed status', async () => {
    mockExecuteJob.mockRejectedValue(new Error('fail'));

    const worker = createWorker(nc, 'worker-1', modelRouter);
    await worker.handleJob({
      jobId: 'job-5',
      type: 'command',
      command: 'fail',
      createdAt: new Date().toISOString(),
    });

    const failedCall = nc.publish.mock.calls[2];
    expect(failedCall[1].status).toBe('failed');
    expect(failedCall[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof failedCall[1].durationMs).toBe('number');
  });

  it('includes workerId in all status messages', async () => {
    mockExecuteJob.mockResolvedValue('ok');

    const worker = createWorker(nc, 'my-worker-id', modelRouter);
    await worker.handleJob({
      jobId: 'job-6',
      type: 'command',
      command: 'echo hi',
      createdAt: new Date().toISOString(),
    });

    const calls = nc.publish.mock.calls;
    for (const call of calls) {
      expect(call[1].workerId).toBe('my-worker-id');
    }
  });

  it('converts non-Error exceptions to strings', async () => {
    mockExecuteJob.mockRejectedValue('plain string error');

    const worker = createWorker(nc, 'worker-1', modelRouter);
    await worker.handleJob({
      jobId: 'job-7',
      type: 'command',
      command: 'bad',
      createdAt: new Date().toISOString(),
    });

    const failedCall = nc.publish.mock.calls[2];
    expect(failedCall[1].status).toBe('failed');
    expect(failedCall[1].error).toBe('plain string error');
  });

  it('passes traceContext from job to extractTraceContext', async () => {
    const { extractTraceContext } = await import('@bakerst/shared');
    mockExecuteJob.mockResolvedValue('ok');

    const worker = createWorker(nc, 'worker-1', modelRouter);
    await worker.handleJob({
      jobId: 'job-8',
      type: 'agent',
      job: 'test',
      createdAt: new Date().toISOString(),
      traceContext: { traceparent: '00-abc-def-01' },
    });

    expect(extractTraceContext).toHaveBeenCalledWith({ traceparent: '00-abc-def-01' });
  });
});
