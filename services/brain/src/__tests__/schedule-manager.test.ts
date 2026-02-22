import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockInsertSchedule, mockListSchedules, mockGetSchedule, mockUpdateScheduleRow, mockUpdateScheduleRunStatus, mockDeleteSchedule } = vi.hoisted(() => ({
  mockInsertSchedule: vi.fn(),
  mockListSchedules: vi.fn().mockReturnValue([]),
  mockGetSchedule: vi.fn(),
  mockUpdateScheduleRow: vi.fn().mockReturnValue(true),
  mockUpdateScheduleRunStatus: vi.fn(),
  mockDeleteSchedule: vi.fn().mockReturnValue(true),
}));

vi.mock('../db.js', () => ({
  listSchedules: mockListSchedules,
  getSchedule: mockGetSchedule,
  insertSchedule: mockInsertSchedule,
  updateScheduleRow: mockUpdateScheduleRow,
  updateScheduleRunStatus: mockUpdateScheduleRunStatus,
  deleteSchedule: mockDeleteSchedule,
}));

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

import { ScheduleManager } from '../schedule-manager.js';

function makeDispatcher() {
  return {
    dispatch: vi.fn().mockResolvedValue({ jobId: 'test-job-1' }),
  } as any;
}

function makeRow(overrides?: Partial<any>) {
  return {
    id: 'test-schedule',
    name: 'Test Schedule',
    schedule: '0 9 * * *',
    type: 'agent',
    config: '{"job":"test task"}',
    enabled: 1,
    last_run_at: null,
    last_status: null,
    last_output: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ScheduleManager', () => {
  let manager: ScheduleManager;
  let dispatcher: ReturnType<typeof makeDispatcher>;

  beforeEach(() => {
    dispatcher = makeDispatcher();
    manager = new ScheduleManager(dispatcher);
  });

  afterEach(() => {
    manager.stopAll();
    vi.clearAllMocks();
  });

  it('loads enabled schedules from database', async () => {
    mockListSchedules.mockReturnValue([
      makeRow({ id: 's1', enabled: 1 }),
      makeRow({ id: 's2', enabled: 0 }),
    ]);

    const count = await manager.loadFromDatabase();
    expect(count).toBe(1); // Only enabled ones
  });

  it('rejects invalid cron expressions', () => {
    expect(() => manager.create({
      name: 'Bad Schedule',
      schedule: 'not-a-cron',
      type: 'agent',
      config: {},
    })).toThrow('Invalid cron expression');
  });

  it('rejects invalid job types', () => {
    expect(() => manager.create({
      name: 'Bad Type',
      schedule: '0 9 * * *',
      type: 'unknown' as any,
      config: {},
    })).toThrow('Invalid type');
  });

  it('creates a schedule and registers timer', () => {
    const row = makeRow();
    mockGetSchedule.mockReturnValue(row);

    manager.create({
      name: 'Daily Summary',
      schedule: '0 9 * * *',
      type: 'agent',
      config: { job: 'summarize' },
    });

    expect(mockInsertSchedule).toHaveBeenCalledTimes(1);
  });

  it('triggers a schedule and dispatches job', async () => {
    const row = makeRow();
    mockGetSchedule.mockReturnValue(row);

    const jobId = await manager.trigger('test-schedule');
    expect(jobId).toBe('test-job-1');
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent',
        source: 'schedule',
      }),
    );
    expect(mockUpdateScheduleRunStatus).toHaveBeenCalledWith('test-schedule', 'dispatched', expect.any(String));
  });

  it('deletes a schedule and cancels timer', () => {
    manager.delete('test-schedule');
    expect(mockDeleteSchedule).toHaveBeenCalledWith('test-schedule');
  });

  it('updates a schedule and re-registers timer', () => {
    const row = makeRow();
    mockGetSchedule.mockReturnValue(row);

    manager.update('test-schedule', { schedule: '0 10 * * *' });
    expect(mockUpdateScheduleRow).toHaveBeenCalledWith('test-schedule', { schedule: '0 10 * * *' });
  });
});
