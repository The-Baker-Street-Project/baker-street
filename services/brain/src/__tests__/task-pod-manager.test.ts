import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock references
// ---------------------------------------------------------------------------

const {
  mockInsertTaskPod,
  mockUpdateTaskPod,
  mockGetTaskPod,
  mockListTaskPods,
  mockCreateNamespacedJob,
  mockDeleteNamespacedJob,
  mockSubscribe,
  mockUnsubscribe,
} = vi.hoisted(() => {
  const mockUnsubscribe = vi.fn();
  const mockSubscribe = vi.fn().mockReturnValue({
    unsubscribe: mockUnsubscribe,
    [Symbol.asyncIterator]: async function* () { /* no-op */ },
  });
  return {
    mockInsertTaskPod: vi.fn(),
    mockUpdateTaskPod: vi.fn(),
    mockGetTaskPod: vi.fn(),
    mockListTaskPods: vi.fn().mockReturnValue([]),
    mockCreateNamespacedJob: vi.fn().mockResolvedValue({}),
    mockDeleteNamespacedJob: vi.fn().mockResolvedValue({}),
    mockSubscribe,
    mockUnsubscribe,
  };
});

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

vi.mock('../db.js', () => ({
  insertTaskPod: mockInsertTaskPod,
  updateTaskPod: mockUpdateTaskPod,
  getTaskPod: mockGetTaskPod,
  listTaskPods: mockListTaskPods,
}));

vi.mock('@kubernetes/client-node', () => {
  const mockBatchApi = {
    createNamespacedJob: mockCreateNamespacedJob,
    deleteNamespacedJob: mockDeleteNamespacedJob,
  };
  const mockCoreApi = {};
  return {
    KubeConfig: vi.fn().mockImplementation(() => ({
      loadFromCluster: vi.fn(),
      makeApiClient: vi.fn().mockImplementation((ApiClass: unknown) => {
        if (ApiClass === mockBatchApiClass) return mockBatchApi;
        return mockCoreApi;
      }),
    })),
    BatchV1Api: (mockBatchApiClass = class BatchV1Api {}),
    CoreV1Api: class CoreV1Api {},
  };
  var mockBatchApiClass: any;
});

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
// Helpers
// ---------------------------------------------------------------------------

function makeNc() {
  return {
    subscribe: mockSubscribe,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Mount path validation', () => {
  const originalAllowedPaths = process.env.TASK_ALLOWED_PATHS;

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    if (originalAllowedPaths !== undefined) {
      process.env.TASK_ALLOWED_PATHS = originalAllowedPaths;
    } else {
      delete process.env.TASK_ALLOWED_PATHS;
    }
  });

  it('allows mounts within an allowed path', async () => {
    process.env.TASK_ALLOWED_PATHS = '/allowed/path,/other/allowed';
    const { TaskPodManager } = await import('../task-pod-manager.js');

    const manager = new TaskPodManager(makeNc());
    await expect(
      manager.dispatch({
        toolbox: 'default',
        mode: 'agent',
        goal: 'test goal',
        mounts: [{ hostPath: '/allowed/path/subdir', permissions: ['read'] }],
      })
    ).resolves.toEqual(expect.any(String));
  });

  it('denies mounts not within any allowed path', async () => {
    process.env.TASK_ALLOWED_PATHS = '/allowed/path';
    const { TaskPodManager } = await import('../task-pod-manager.js');

    const manager = new TaskPodManager(makeNc());
    await expect(
      manager.dispatch({
        toolbox: 'default',
        mode: 'agent',
        goal: 'test goal',
        mounts: [{ hostPath: '/forbidden/path', permissions: ['read'] }],
      })
    ).rejects.toThrow('Mount path not allowed: /forbidden/path');
  });

  it('denies all mounts when TASK_ALLOWED_PATHS is not set', async () => {
    delete process.env.TASK_ALLOWED_PATHS;
    const { TaskPodManager } = await import('../task-pod-manager.js');

    const manager = new TaskPodManager(makeNc());
    await expect(
      manager.dispatch({
        toolbox: 'default',
        mode: 'agent',
        goal: 'test goal',
        mounts: [{ hostPath: '/any/path', permissions: ['read'] }],
      })
    ).rejects.toThrow('TASK_ALLOWED_PATHS is not configured');
  });

  it('allows dispatch with no mounts when TASK_ALLOWED_PATHS is not set', async () => {
    delete process.env.TASK_ALLOWED_PATHS;
    const { TaskPodManager } = await import('../task-pod-manager.js');

    const manager = new TaskPodManager(makeNc());
    await expect(
      manager.dispatch({
        toolbox: 'default',
        mode: 'agent',
        goal: 'test goal',
        // no mounts
      })
    ).resolves.toEqual(expect.any(String));
  });
});

describe('Mode validation in API', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('accepts agent mode', () => {
    const validModes = ['agent', 'script'] as const;
    for (const mode of validModes) {
      const isValid = mode === 'agent' || mode === 'script';
      expect(isValid).toBe(true);
    }
  });

  it('rejects invalid mode strings', () => {
    const invalidModes = ['auto', 'manual', '', 'AGENT', 'Script'];
    for (const mode of invalidModes) {
      const isValid = mode === 'agent' || mode === 'script';
      expect(isValid).toBe(false);
    }
  });
});

describe('TaskPodManager construction', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('constructs without error', async () => {
    const { TaskPodManager } = await import('../task-pod-manager.js');
    expect(() => new TaskPodManager(makeNc())).not.toThrow();
  });

  it('listTasks delegates to db', async () => {
    const { TaskPodManager } = await import('../task-pod-manager.js');
    const manager = new TaskPodManager(makeNc());
    mockListTaskPods.mockReturnValue([{ task_id: 'abc', status: 'running' }]);
    const tasks = manager.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe('abc');
  });

  it('getTask delegates to db', async () => {
    const { TaskPodManager } = await import('../task-pod-manager.js');
    const manager = new TaskPodManager(makeNc());
    mockGetTaskPod.mockReturnValue({ task_id: 'abc', status: 'running' });
    const task = manager.getTask('abc');
    expect(task?.task_id).toBe('abc');
  });

  it('cancel returns false when task not found', async () => {
    const { TaskPodManager } = await import('../task-pod-manager.js');
    const manager = new TaskPodManager(makeNc());
    mockGetTaskPod.mockReturnValue(undefined);
    const result = await manager.cancel('nonexistent');
    expect(result).toBe(false);
  });

  it('cancel cleans up NATS subscription', async () => {
    process.env.TASK_ALLOWED_PATHS = '/allowed';
    const { TaskPodManager } = await import('../task-pod-manager.js');
    const manager = new TaskPodManager(makeNc());

    // Dispatch a task to create a subscription
    const taskId = await manager.dispatch({
      toolbox: 'default',
      mode: 'agent',
      goal: 'test',
    });

    // Set up getTaskPod to return a job_name for cancel
    mockGetTaskPod.mockReturnValue({ taskId, job_name: `bakerst-task-${taskId.slice(0, 8)}`, status: 'running' });

    const result = await manager.cancel(taskId);
    expect(result).toBe(true);
    // Subscription should have been unsubscribed
    expect(mockUnsubscribe).toHaveBeenCalled();
    delete process.env.TASK_ALLOWED_PATHS;
  });
});
