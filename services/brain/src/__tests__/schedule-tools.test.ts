import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduleRow } from '../db.js';

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------

vi.mock('@bakerst/shared', async () => {
  const actual = await vi.importActual<typeof import('@bakerst/shared')>('@bakerst/shared');
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
// Import after mocks
// ---------------------------------------------------------------------------

import { executeScheduleTool, SCHEDULE_TOOLS } from '../schedule-tools.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScheduleRow(overrides?: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: 'sched-001',
    name: 'Daily Report',
    schedule: '0 9 * * *',
    type: 'agent',
    config: JSON.stringify({ job: 'Generate daily report' }),
    enabled: 1,
    last_run_at: '2026-03-01T09:00:00Z',
    last_status: 'dispatched',
    last_output: null,
    created_at: '2026-02-28T10:00:00Z',
    updated_at: '2026-02-28T10:00:00Z',
    ...overrides,
  };
}

function createMockScheduleManager() {
  return {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    trigger: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    get: vi.fn(),
    loadFromDatabase: vi.fn(),
    migrateFromFile: vi.fn(),
    stopAll: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SCHEDULE_TOOLS set', () => {
  it('contains the three expected tool names', () => {
    expect(SCHEDULE_TOOLS.has('manage_standing_order')).toBe(true);
    expect(SCHEDULE_TOOLS.has('list_standing_orders')).toBe(true);
    expect(SCHEDULE_TOOLS.has('trigger_standing_order')).toBe(true);
    expect(SCHEDULE_TOOLS.size).toBe(3);
  });
});

describe('executeScheduleTool', () => {
  let mgr: ReturnType<typeof createMockScheduleManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = createMockScheduleManager();
  });

  // -----------------------------------------------------------------------
  // manage_standing_order — create
  // -----------------------------------------------------------------------

  describe('manage_standing_order — create', () => {
    it('creates a standing order with required params', async () => {
      const row = makeScheduleRow({ id: 'new-id', name: 'Health Check' });
      mgr.create.mockReturnValue(row);

      const result = await executeScheduleTool(
        'manage_standing_order',
        {
          action: 'create',
          name: 'Health Check',
          schedule: '*/5 * * * *',
          type: 'command',
          config: { command: 'curl http://localhost/health' },
        },
        mgr as any,
      );

      expect(result.result).toContain('created successfully');
      expect(result.result).toContain('Health Check');
      expect(mgr.create).toHaveBeenCalledWith({
        name: 'Health Check',
        schedule: '*/5 * * * *',
        type: 'command',
        config: { command: 'curl http://localhost/health' },
      });
    });

    it('rejects create without required fields', async () => {
      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'create', name: 'No Schedule' },
        mgr as any,
      );

      expect(result.result).toContain('Error');
      expect(result.result).toContain('required');
      expect(mgr.create).not.toHaveBeenCalled();
    });

    it('returns error when ScheduleManager.create throws', async () => {
      mgr.create.mockImplementation(() => { throw new Error('Invalid cron expression: bad'); });

      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'create', name: 'Bad Cron', schedule: 'bad', type: 'agent', config: { job: 'test' } },
        mgr as any,
      );

      expect(result.result).toContain('Error');
      expect(result.result).toContain('Invalid cron expression');
    });

    it('defaults config to empty object when not provided', async () => {
      const row = makeScheduleRow();
      mgr.create.mockReturnValue(row);

      await executeScheduleTool(
        'manage_standing_order',
        { action: 'create', name: 'Minimal', schedule: '0 * * * *', type: 'agent' },
        mgr as any,
      );

      expect(mgr.create).toHaveBeenCalledWith(
        expect.objectContaining({ config: {} }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // manage_standing_order — update
  // -----------------------------------------------------------------------

  describe('manage_standing_order — update', () => {
    it('updates an existing standing order', async () => {
      const row = makeScheduleRow();
      mgr.get.mockReturnValue(row);
      mgr.update.mockReturnValue(row);

      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'update', id: 'sched-001', name: 'Updated Name' },
        mgr as any,
      );

      expect(result.result).toContain('updated successfully');
      expect(mgr.update).toHaveBeenCalledWith('sched-001', { name: 'Updated Name' });
    });

    it('rejects update without id', async () => {
      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'update', name: 'No ID' },
        mgr as any,
      );

      expect(result.result).toContain('Error');
      expect(result.result).toContain('id is required');
    });

    it('returns error for nonexistent id', async () => {
      mgr.get.mockReturnValue(undefined);

      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'update', id: 'nonexistent', name: 'Test' },
        mgr as any,
      );

      expect(result.result).toContain('not found');
    });

    it('returns error when update returns undefined', async () => {
      mgr.get.mockReturnValue(makeScheduleRow());
      mgr.update.mockReturnValue(undefined);

      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'update', id: 'sched-001', name: 'Test' },
        mgr as any,
      );

      expect(result.result).toContain('failed to update');
    });

    it('returns error when ScheduleManager.update throws', async () => {
      mgr.get.mockReturnValue(makeScheduleRow());
      mgr.update.mockImplementation(() => { throw new Error('Invalid cron expression: nope'); });

      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'update', id: 'sched-001', schedule: 'nope' },
        mgr as any,
      );

      expect(result.result).toContain('Error');
      expect(result.result).toContain('Invalid cron expression');
    });
  });

  // -----------------------------------------------------------------------
  // manage_standing_order — enable
  // -----------------------------------------------------------------------

  describe('manage_standing_order — enable', () => {
    it('enables a standing order', async () => {
      mgr.get.mockReturnValue(makeScheduleRow({ enabled: 0 }));
      mgr.update.mockReturnValue(makeScheduleRow({ enabled: 1 }));

      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'enable', id: 'sched-001' },
        mgr as any,
      );

      expect(result.result).toContain('enabled successfully');
      expect(mgr.update).toHaveBeenCalledWith('sched-001', { enabled: true });
    });

    it('rejects enable without id', async () => {
      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'enable' },
        mgr as any,
      );

      expect(result.result).toContain('id is required');
    });

    it('returns error for nonexistent id', async () => {
      mgr.get.mockReturnValue(undefined);

      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'enable', id: 'nonexistent' },
        mgr as any,
      );

      expect(result.result).toContain('not found');
    });
  });

  // -----------------------------------------------------------------------
  // manage_standing_order — disable
  // -----------------------------------------------------------------------

  describe('manage_standing_order — disable', () => {
    it('disables a standing order', async () => {
      mgr.get.mockReturnValue(makeScheduleRow({ enabled: 1 }));
      mgr.update.mockReturnValue(makeScheduleRow({ enabled: 0 }));

      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'disable', id: 'sched-001' },
        mgr as any,
      );

      expect(result.result).toContain('disabled successfully');
      expect(mgr.update).toHaveBeenCalledWith('sched-001', { enabled: false });
    });

    it('rejects disable without id', async () => {
      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'disable' },
        mgr as any,
      );

      expect(result.result).toContain('id is required');
    });
  });

  // -----------------------------------------------------------------------
  // manage_standing_order — delete
  // -----------------------------------------------------------------------

  describe('manage_standing_order — delete', () => {
    it('deletes a standing order', async () => {
      mgr.get.mockReturnValue(makeScheduleRow());
      mgr.delete.mockReturnValue(true);

      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'delete', id: 'sched-001' },
        mgr as any,
      );

      expect(result.result).toContain('deleted successfully');
      expect(mgr.delete).toHaveBeenCalledWith('sched-001');
    });

    it('rejects delete without id', async () => {
      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'delete' },
        mgr as any,
      );

      expect(result.result).toContain('id is required');
    });

    it('returns error for nonexistent id', async () => {
      mgr.get.mockReturnValue(undefined);

      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'delete', id: 'nonexistent' },
        mgr as any,
      );

      expect(result.result).toContain('not found');
    });

    it('returns error when delete returns false', async () => {
      mgr.get.mockReturnValue(makeScheduleRow());
      mgr.delete.mockReturnValue(false);

      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'delete', id: 'sched-001' },
        mgr as any,
      );

      expect(result.result).toContain('failed to delete');
    });
  });

  // -----------------------------------------------------------------------
  // manage_standing_order — unknown action
  // -----------------------------------------------------------------------

  describe('manage_standing_order — unknown action', () => {
    it('returns error for unknown action', async () => {
      const result = await executeScheduleTool(
        'manage_standing_order',
        { action: 'restart' },
        mgr as any,
      );

      expect(result.result).toContain("unknown action 'restart'");
    });
  });

  // -----------------------------------------------------------------------
  // list_standing_orders
  // -----------------------------------------------------------------------

  describe('list_standing_orders', () => {
    it('lists all standing orders', async () => {
      mgr.list.mockReturnValue([
        makeScheduleRow({ id: 'sched-001', name: 'Daily Report', schedule: '0 9 * * *', type: 'agent', enabled: 1 }),
        makeScheduleRow({ id: 'sched-002', name: 'Backup', schedule: '0 2 * * *', type: 'command', enabled: 0 }),
      ]);

      const result = await executeScheduleTool('list_standing_orders', {}, mgr as any);

      expect(result.result).toContain('2 standing order(s)');
      expect(result.result).toContain('Daily Report');
      expect(result.result).toContain('sched-001');
      expect(result.result).toContain('0 9 * * *');
      expect(result.result).toContain('agent');
      expect(result.result).toContain('enabled');
      expect(result.result).toContain('Backup');
      expect(result.result).toContain('disabled');
    });

    it('filters by enabled status', async () => {
      mgr.list.mockReturnValue([
        makeScheduleRow({ id: 'sched-001', name: 'Active', enabled: 1 }),
        makeScheduleRow({ id: 'sched-002', name: 'Inactive', enabled: 0 }),
      ]);

      const result = await executeScheduleTool(
        'list_standing_orders',
        { status: 'enabled' },
        mgr as any,
      );

      expect(result.result).toContain('1 standing order(s)');
      expect(result.result).toContain('Active');
      expect(result.result).not.toContain('Inactive');
    });

    it('filters by disabled status', async () => {
      mgr.list.mockReturnValue([
        makeScheduleRow({ id: 'sched-001', name: 'Active', enabled: 1 }),
        makeScheduleRow({ id: 'sched-002', name: 'Inactive', enabled: 0 }),
      ]);

      const result = await executeScheduleTool(
        'list_standing_orders',
        { status: 'disabled' },
        mgr as any,
      );

      expect(result.result).toContain('1 standing order(s)');
      expect(result.result).toContain('Inactive');
      expect(result.result).not.toContain('Active');
    });

    it('returns message when no orders exist', async () => {
      mgr.list.mockReturnValue([]);

      const result = await executeScheduleTool('list_standing_orders', {}, mgr as any);

      expect(result.result).toContain('No standing orders found');
    });

    it('returns message for filtered empty set', async () => {
      mgr.list.mockReturnValue([
        makeScheduleRow({ id: 'sched-001', name: 'Active', enabled: 1 }),
      ]);

      const result = await executeScheduleTool(
        'list_standing_orders',
        { status: 'disabled' },
        mgr as any,
      );

      expect(result.result).toContain('No disabled standing orders found');
    });

    it('shows last_run_at and last_status', async () => {
      mgr.list.mockReturnValue([
        makeScheduleRow({
          id: 'sched-001',
          name: 'Check',
          last_run_at: '2026-03-01T10:00:00Z',
          last_status: 'dispatched',
        }),
      ]);

      const result = await executeScheduleTool('list_standing_orders', {}, mgr as any);

      expect(result.result).toContain('2026-03-01T10:00:00Z');
      expect(result.result).toContain('dispatched');
    });

    it('shows "never" and "n/a" when last run fields are null', async () => {
      mgr.list.mockReturnValue([
        makeScheduleRow({
          id: 'sched-001',
          name: 'New Order',
          last_run_at: null,
          last_status: null,
        }),
      ]);

      const result = await executeScheduleTool('list_standing_orders', {}, mgr as any);

      expect(result.result).toContain('never');
      expect(result.result).toContain('n/a');
    });
  });

  // -----------------------------------------------------------------------
  // trigger_standing_order
  // -----------------------------------------------------------------------

  describe('trigger_standing_order', () => {
    it('triggers a standing order and returns the job ID', async () => {
      mgr.trigger.mockResolvedValue('job-abc-123');

      const result = await executeScheduleTool(
        'trigger_standing_order',
        { id: 'sched-001' },
        mgr as any,
      );

      expect(result.result).toContain('triggered');
      expect(result.result).toContain('job-abc-123');
      expect(mgr.trigger).toHaveBeenCalledWith('sched-001');
    });

    it('rejects trigger without id', async () => {
      const result = await executeScheduleTool(
        'trigger_standing_order',
        {},
        mgr as any,
      );

      expect(result.result).toContain('id is required');
    });

    it('returns error when trigger throws', async () => {
      mgr.trigger.mockRejectedValue(new Error('Schedule sched-999 not found'));

      const result = await executeScheduleTool(
        'trigger_standing_order',
        { id: 'sched-999' },
        mgr as any,
      );

      expect(result.result).toContain('Error');
      expect(result.result).toContain('not found');
    });
  });

  // -----------------------------------------------------------------------
  // unknown tool name
  // -----------------------------------------------------------------------

  describe('unknown tool name', () => {
    it('returns error for unknown tool', async () => {
      const result = await executeScheduleTool('unknown_tool', {}, mgr as any);
      expect(result.result).toContain('Unknown schedule tool');
    });
  });
});
