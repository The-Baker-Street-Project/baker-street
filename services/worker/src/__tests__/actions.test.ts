import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock references — vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------

const { mockExecFileAsync, mockReadFile } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  mockReadFile: vi.fn().mockRejectedValue(new Error('not found')),
}));

// ---------------------------------------------------------------------------
// Mock @bakerst/shared — must come before imports of the module under test
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
// Mock node:child_process
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: mockExecFileAsync,
  });
  return { execFile };
});

// ---------------------------------------------------------------------------
// Mock node:fs/promises (for loadSystemPrompt inside executeAgent)
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

// ---------------------------------------------------------------------------
// Import module under test after mocks
// ---------------------------------------------------------------------------

import { executeCommand, executeHttp, executeAgent, executeJob } from '../actions.js';
import type { JobDispatch } from '@bakerst/shared';

// ---------------------------------------------------------------------------
// Mock global fetch for executeHttp tests
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helper: create a minimal JobDispatch
// ---------------------------------------------------------------------------

function makeJob(overrides?: Partial<JobDispatch>): JobDispatch {
  return {
    jobId: 'test-job-1',
    type: 'command',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: mock ModelRouter
// ---------------------------------------------------------------------------

function makeModelRouter(overrides?: Record<string, unknown>) {
  return {
    useOAuth: false,
    routerConfig: {
      roles: { agent: 'sonnet', observer: 'haiku' },
      models: [],
      providers: {},
    },
    chat: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'agent response' }],
      stopReason: 'end_turn',
      model: 'test-model',
    }),
    chatStream: vi.fn(),
    updateConfig: vi.fn(),
    setOnApiCall: vi.fn(),
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests: executeCommand
// ---------------------------------------------------------------------------

describe('executeCommand', () => {
  it('throws when command field is missing', async () => {
    const job = makeJob({ command: undefined });
    await expect(executeCommand(job)).rejects.toThrow('command job requires a "command" field');
  });

  it('rejects commands not in the allowlist', async () => {
    const job = makeJob({ command: 'rm -rf /' });
    await expect(executeCommand(job)).rejects.toThrow("'rm' is not in the allowed commands list");
  });

  it('rejects commands exceeding max length', async () => {
    const longCmd = 'curl ' + 'x'.repeat(1100);
    const job = makeJob({ command: longCmd });
    await expect(executeCommand(job)).rejects.toThrow('exceeds max length');
  });

  it('rejects empty commands (only env vars)', async () => {
    const job = makeJob({ command: 'FOO=bar' });
    await expect(executeCommand(job)).rejects.toThrow('empty command');
  });

  it('strips path prefixes from binary names', async () => {
    const job = makeJob({ command: '/usr/bin/curl https://example.com' });

    mockExecFileAsync.mockResolvedValue({ stdout: 'response body', stderr: '' });

    const result = await executeCommand(job);
    expect(result).toBe('response body');
    expect(mockExecFileAsync).toHaveBeenCalled();
  });

  it('allows env var prefixed commands', async () => {
    const job = makeJob({ command: 'FOO=bar curl https://example.com' });

    mockExecFileAsync.mockResolvedValue({ stdout: 'ok', stderr: '' });

    const result = await executeCommand(job);
    expect(result).toBe('ok');
  });

  it('resolves with trimmed stdout on success', async () => {
    const job = makeJob({ command: 'kubectl get pods' });

    mockExecFileAsync.mockResolvedValue({ stdout: '  pod-1 Running  \n', stderr: '' });

    const result = await executeCommand(job);
    expect(result).toBe('pod-1 Running');
  });

  it('rejects with error message when exec fails', async () => {
    const job = makeJob({ command: 'kubectl get pods' });

    const err = new Error('connection refused') as Error & { stderr: string };
    err.stderr = 'error output';
    mockExecFileAsync.mockRejectedValue(err);

    await expect(executeCommand(job)).rejects.toThrow('command failed: connection refused');
  });
});

// ---------------------------------------------------------------------------
// Tests: executeHttp
// ---------------------------------------------------------------------------

describe('executeHttp', () => {
  it('throws when url field is missing', async () => {
    const job = makeJob({ type: 'http', url: undefined });
    await expect(executeHttp(job)).rejects.toThrow('http job requires a "url" field');
  });

  it('returns HTTP status and body on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('{"ok":true}'),
    });

    const job = makeJob({ type: 'http', url: 'https://example.com/api' });
    const result = await executeHttp(job);

    expect(result).toBe('HTTP 200: {"ok":true}');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/api',
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('uses specified method and sends body from vars', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 201,
      text: () => Promise.resolve('created'),
    });

    const job = makeJob({
      type: 'http',
      url: 'https://example.com/api',
      method: 'POST',
      headers: { 'X-Custom': 'value' },
      vars: { key: 'value' },
    });

    const result = await executeHttp(job);
    expect(result).toBe('HTTP 201: created');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/api',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Custom': 'value' },
        body: JSON.stringify({ key: 'value' }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: executeAgent
// ---------------------------------------------------------------------------

describe('executeAgent', () => {
  it('throws when job field is missing', async () => {
    const job = makeJob({ type: 'agent', job: undefined });
    const router = makeModelRouter();
    await expect(executeAgent(job, router)).rejects.toThrow('agent job requires a "job" field');
  });

  it('calls modelRouter.chat and returns text response', async () => {
    const job = makeJob({ type: 'agent', job: 'summarize this' });
    const router = makeModelRouter();

    const result = await executeAgent(job, router);
    expect(result).toBe('agent response');
    expect(router.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'summarize this' }],
        maxTokens: 1024,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: executeJob (routing)
// ---------------------------------------------------------------------------

describe('executeJob', () => {
  it('throws on unknown job type', async () => {
    const job = makeJob({ type: 'unknown' as any });
    const router = makeModelRouter();
    await expect(executeJob(job, router)).rejects.toThrow('unknown job type: unknown');
  });

  it('routes agent type to executeAgent', async () => {
    const job = makeJob({ type: 'agent', job: 'do something' });
    const router = makeModelRouter();

    const result = await executeJob(job, router);
    expect(result).toBe('agent response');
  });

  it('routes command type to executeCommand', async () => {
    const job = makeJob({ type: 'command', command: 'echo hello' });
    const router = makeModelRouter();

    mockExecFileAsync.mockResolvedValue({ stdout: 'hello', stderr: '' });

    const result = await executeJob(job, router);
    expect(result).toBe('hello');
  });

  it('routes http type to executeHttp', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('ok'),
    });

    const job = makeJob({ type: 'http', url: 'https://example.com' });
    const router = makeModelRouter();

    const result = await executeJob(job, router);
    expect(result).toBe('HTTP 200: ok');
  });
});
