import cron from 'node-cron';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { logger } from '@bakerst/shared';
import type { Dispatcher } from './dispatcher.js';
import {
  listSchedules,
  getSchedule,
  insertSchedule,
  updateScheduleRow,
  updateScheduleRunStatus,
  deleteSchedule as deleteScheduleDb,
  type ScheduleRow,
} from './db.js';

const log = logger.child({ module: 'schedule-manager' });

interface ScheduleConfig {
  job?: string;
  command?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  vars?: Record<string, unknown>;
}

export class ScheduleManager {
  private tasks = new Map<string, cron.ScheduledTask>();
  private dispatcher: Dispatcher;

  constructor(dispatcher: Dispatcher) {
    this.dispatcher = dispatcher;
  }

  /** Load all enabled schedules from DB and register timers */
  async loadFromDatabase(): Promise<number> {
    const rows = listSchedules();
    let count = 0;
    for (const row of rows) {
      if (row.enabled) {
        this.registerTimer(row);
        count++;
      }
    }
    log.info({ count, total: rows.length }, 'loaded schedules from database');
    return count;
  }

  /** One-time migration: seed DB from CRONS.json if it exists */
  async migrateFromFile(path?: string): Promise<number> {
    const cronPath = path ?? process.env.CRONS_PATH ?? '/etc/bakerst/CRONS.json';
    let raw: string;
    try {
      raw = await readFile(cronPath, 'utf-8');
    } catch {
      return 0; // File doesn't exist, nothing to migrate
    }

    const existing = listSchedules();
    if (existing.length > 0) {
      log.info('schedules already exist in DB, skipping CRONS.json migration');
      return 0;
    }

    let entries: Array<{
      name: string;
      schedule: string;
      type: string;
      job?: string;
      command?: string;
      url?: string;
      method?: string;
    }>;

    try {
      entries = JSON.parse(raw);
    } catch {
      log.warn('invalid CRONS.json format, skipping migration');
      return 0;
    }

    if (!Array.isArray(entries)) return 0;

    let migrated = 0;
    for (const entry of entries) {
      try {
        if (!cron.validate(entry.schedule)) {
          log.warn({ name: entry.name, schedule: entry.schedule }, 'invalid cron schedule in CRONS.json, skipping');
          continue;
        }

        const id = randomUUID();
        const config: ScheduleConfig = {};
        if (entry.job) config.job = entry.job;
        if (entry.command) config.command = entry.command;
        if (entry.url) config.url = entry.url;
        if (entry.method) config.method = entry.method;

        insertSchedule({
          id,
          name: entry.name,
          schedule: entry.schedule,
          type: entry.type,
          config: config as Record<string, unknown>,
        });
        migrated++;
      } catch (err) {
        log.warn({ err, name: entry.name }, 'failed to migrate CRONS.json entry, skipping');
      }
    }

    log.info({ migrated }, 'migrated CRONS.json entries to schedules table');
    return migrated;
  }

  /** Create a new schedule */
  create(params: {
    name: string;
    schedule: string;
    type: string;
    config: ScheduleConfig;
    enabled?: boolean;
  }): ScheduleRow {
    if (!cron.validate(params.schedule)) {
      throw new Error(`Invalid cron expression: ${params.schedule}`);
    }
    if (!['agent', 'command', 'http'].includes(params.type)) {
      throw new Error(`Invalid type: ${params.type}. Must be agent, command, or http`);
    }

    const id = randomUUID();
    insertSchedule({
      id,
      name: params.name,
      schedule: params.schedule,
      type: params.type,
      config: params.config as Record<string, unknown>,
      enabled: params.enabled,
    });

    const row = getSchedule(id)!;
    if (row.enabled) {
      this.registerTimer(row);
    }
    return row;
  }

  /** Update an existing schedule */
  update(id: string, updates: Partial<{
    name: string;
    schedule: string;
    type: string;
    config: ScheduleConfig;
    enabled: boolean;
  }>): ScheduleRow | undefined {
    if (updates.schedule && !cron.validate(updates.schedule)) {
      throw new Error(`Invalid cron expression: ${updates.schedule}`);
    }
    if (updates.type) {
      const VALID_TYPES = ['agent', 'command', 'http'];
      if (!VALID_TYPES.includes(updates.type)) {
        throw new Error(`Invalid schedule type: ${updates.type}. Must be one of: ${VALID_TYPES.join(', ')}`);
      }
    }

    // Cancel existing timer
    this.cancelTimer(id);

    const ok = updateScheduleRow(id, updates as Parameters<typeof updateScheduleRow>[1]);
    if (!ok) return undefined;

    const row = getSchedule(id)!;
    if (row.enabled) {
      this.registerTimer(row);
    }
    return row;
  }

  /** Delete a schedule */
  delete(id: string): boolean {
    this.cancelTimer(id);
    return deleteScheduleDb(id);
  }

  /** Trigger a schedule immediately */
  async trigger(id: string): Promise<string> {
    const row = getSchedule(id);
    if (!row) throw new Error(`Schedule ${id} not found`);
    return this.executeSchedule(row);
  }

  /** List all schedules */
  list(): ScheduleRow[] {
    return listSchedules();
  }

  /** Get a single schedule */
  get(id: string): ScheduleRow | undefined {
    return getSchedule(id);
  }

  /** Stop all timers (for shutdown) */
  stopAll(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
      log.info({ id }, 'stopped schedule timer');
    }
    this.tasks.clear();
  }

  private registerTimer(row: ScheduleRow): void {
    if (this.tasks.has(row.id)) {
      this.tasks.get(row.id)!.stop();
    }

    const task = cron.schedule(row.schedule, async () => {
      log.info({ id: row.id, name: row.name }, 'cron triggered');
      await this.executeSchedule(row);
    });

    this.tasks.set(row.id, task);
    log.info({ id: row.id, name: row.name, schedule: row.schedule }, 'registered schedule timer');
  }

  private cancelTimer(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
  }

  private async executeSchedule(row: ScheduleRow): Promise<string> {
    const current = getSchedule(row.id);
    if (!current || !current.enabled) {
      log.info({ id: row.id }, 'schedule no longer active, skipping execution');
      return 'skipped';
    }

    let config: ScheduleConfig;
    try {
      config = JSON.parse(current.config) as ScheduleConfig;
    } catch {
      config = {};
    }

    try {
      const dispatched = await this.dispatcher.dispatch({
        type: current.type as 'agent' | 'command' | 'http',
        job: config.job,
        command: config.command,
        url: config.url,
        method: config.method,
        headers: config.headers,
        vars: config.vars,
        source: 'schedule',
      });

      updateScheduleRunStatus(current.id, 'dispatched', `Job ${dispatched.jobId} dispatched`);
      return dispatched.jobId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateScheduleRunStatus(current.id, 'failed', msg);
      log.error({ err, scheduleId: current.id }, 'schedule execution failed');
      throw err;
    }
  }
}
