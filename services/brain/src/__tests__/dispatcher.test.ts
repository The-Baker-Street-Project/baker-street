import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock references
// ---------------------------------------------------------------------------

const { mockInsertJob } = vi.hoisted(() => ({
  mockInsertJob: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock db.js
// ---------------------------------------------------------------------------

vi.mock('../db.js', () => ({
  insertJob: mockInsertJob,
}));

// ---------------------------------------------------------------------------
// Mock @bakerst/shared — provide Subjects, codec, logger, getTraceHeaders
// ---------------------------------------------------------------------------

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
    getTraceHeaders: vi.fn().mockReturnValue({ traceparent: '00-trace-span-01' }),
  };
});

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import { createDispatcher } from '../dispatcher.js';
import { Subjects, codec } from '@bakerst/shared';

// ---------------------------------------------------------------------------
// Mock NATS connection
// ---------------------------------------------------------------------------

function makeJs() {
  return {
    publish: vi.fn().mockResolvedValue({ stream: 'BAKERST_JOBS', seq: 1, duplicate: false }),
  } as any;
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDispatcher', () => {
  it('generates a unique jobId (UUID format)', async () => {
    const js = makeJs();
    const dispatcher = createDispatcher(js);

    const result = await dispatcher.dispatch({
      type: 'command',
      command: 'echo hello',
      source: 'test',
    });

    // UUID v4 format: 8-4-4-4-12 hex
    expect(result.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('generates different jobIds for different dispatches', async () => {
    const js = makeJs();
    const dispatcher = createDispatcher(js);

    const r1 = await dispatcher.dispatch({ type: 'command', command: 'a', source: 'test' });
    const r2 = await dispatcher.dispatch({ type: 'command', command: 'b', source: 'test' });

    expect(r1.jobId).not.toBe(r2.jobId);
  });

  it('persists job to SQLite via insertJob before publishing to NATS', async () => {
    const js = makeJs();
    const dispatcher = createDispatcher(js);

    await dispatcher.dispatch({
      type: 'agent',
      job: 'do something',
      source: 'webhook',
    });

    // insertJob should be called
    expect(mockInsertJob).toHaveBeenCalledTimes(1);
    const insertArgs = mockInsertJob.mock.calls[0][0];
    expect(insertArgs.type).toBe('agent');
    expect(insertArgs.source).toBe('webhook');
    expect(insertArgs.input).toBe('do something');
    expect(insertArgs.jobId).toBeDefined();
    expect(insertArgs.createdAt).toBeDefined();

    // JetStream publish should also be called
    expect(js.publish).toHaveBeenCalledTimes(1);
  });

  it('attaches trace context from getTraceHeaders', async () => {
    const js = makeJs();
    const dispatcher = createDispatcher(js);

    const result = await dispatcher.dispatch({
      type: 'command',
      command: 'date',
      source: 'test',
    });

    expect(result.traceContext).toEqual({ traceparent: '00-trace-span-01' });
  });

  it('publishes to the correct NATS subject', async () => {
    const js = makeJs();
    const dispatcher = createDispatcher(js);

    await dispatcher.dispatch({
      type: 'http',
      url: 'https://example.com',
      source: 'api',
    });

    expect(js.publish).toHaveBeenCalledWith(
      Subjects.JOBS_DISPATCH,
      expect.anything(),
      expect.objectContaining({ msgID: expect.any(String) }),
    );
  });

  it('encodes the job with codec before publishing', async () => {
    const js = makeJs();
    const dispatcher = createDispatcher(js);

    await dispatcher.dispatch({
      type: 'command',
      command: 'uptime',
      source: 'test',
    });

    const publishCall = js.publish.mock.calls[0];
    const encoded = publishCall[1];
    // codec.encode returns a Uint8Array — verify it's a buffer-like value
    expect(encoded).toBeInstanceOf(Uint8Array);
    // Round-trip decode to verify the content
    const decoded = codec.decode(encoded) as Record<string, unknown>;
    expect(decoded.type).toBe('command');
    expect(decoded.command).toBe('uptime');
    expect(decoded.jobId).toBeDefined();
  });

  it('returns a complete JobDispatch with createdAt timestamp', async () => {
    const js = makeJs();
    const dispatcher = createDispatcher(js);

    const before = new Date().toISOString();
    const result = await dispatcher.dispatch({
      type: 'agent',
      job: 'test',
      source: 'webhook',
    });
    const after = new Date().toISOString();

    expect(result.createdAt).toBeDefined();
    expect(result.createdAt >= before).toBe(true);
    expect(result.createdAt <= after).toBe(true);
    expect(result.type).toBe('agent');
    expect(result.source).toBe('webhook');
  });

  it('uses command as input fallback, then url', async () => {
    const js = makeJs();
    const dispatcher = createDispatcher(js);

    // Command job: input should be the command
    await dispatcher.dispatch({ type: 'command', command: 'kubectl get pods', source: 'test' });
    expect(mockInsertJob.mock.calls[0][0].input).toBe('kubectl get pods');

    mockInsertJob.mockClear();

    // HTTP job: input should be the url
    await dispatcher.dispatch({ type: 'http', url: 'https://example.com', source: 'test' });
    expect(mockInsertJob.mock.calls[0][0].input).toBe('https://example.com');
  });
});
