import { EventEmitter } from 'node:events';
import type { NatsConnection } from 'nats';
import { type JobStatus, Subjects, codec, logger } from '@bakerst/shared';
import { updateJobStatus, getJob, listJobs, type JobRow } from './db.js';

const log = logger.child({ module: 'status-tracker' });

const ZOMBIE_CHECK_INTERVAL_MS = 60_000;
const ZOMBIE_THRESHOLD_MS = 2 * 60_000; // 2 minutes (reduced from 5m — JetStream redelivery handles retries)

function rowToJobStatus(row: JobRow): JobStatus & Record<string, unknown> {
  const isTerminal = row.status === 'completed' || row.status === 'failed';
  return {
    jobId: row.job_id,
    type: row.type,
    workerId: row.worker_id ?? '',
    status: row.status as JobStatus['status'],
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    receivedAt: row.created_at,
    completedAt: isTerminal ? row.updated_at : undefined,
  };
}

export function createStatusTracker(nc: NatsConnection) {
  const sub = nc.subscribe(`${Subjects.JOBS_STATUS}.*`);
  const emitter = new EventEmitter();

  (async () => {
    for await (const msg of sub) {
      try {
        const status = codec.decode(msg.data) as JobStatus;

        // Persist to SQLite
        updateJobStatus({
          jobId: status.jobId,
          workerId: status.workerId,
          status: status.status,
          result: status.result,
          error: status.error,
          durationMs: status.durationMs,
        });

        log.info(
          {
            jobId: status.jobId,
            status: status.status,
            workerId: status.workerId,
            ...(status.durationMs !== undefined && { durationMs: status.durationMs }),
            ...(status.result !== undefined && { result: status.result.slice(0, 500) }),
            ...(status.error !== undefined && { error: status.error }),
          },
          'job status update',
        );

        // Emit event for terminal statuses so waiters resolve immediately
        if (status.status === 'completed' || status.status === 'failed') {
          emitter.emit(`job:${status.jobId}`, status);
        }
      } catch (err) {
        log.error({ err }, 'failed to decode job status');
      }
    }
  })();

  // Zombie reaper: find jobs stuck in received/running for too long
  const reaperInterval = setInterval(() => {
    try {
      const now = Date.now();
      const allJobs = listJobs(500);

      for (const row of allJobs) {
        if (row.status !== 'dispatched' && row.status !== 'received' && row.status !== 'running') {
          continue;
        }
        const updatedAt = new Date(row.updated_at).getTime();
        if (now - updatedAt > ZOMBIE_THRESHOLD_MS) {
          log.warn({ jobId: row.job_id, status: row.status, updatedAt: row.updated_at }, 'reaping zombie job');
          updateJobStatus({
            jobId: row.job_id,
            workerId: row.worker_id ?? 'reaper',
            status: 'failed',
            error: `job stuck in '${row.status}' for over ${ZOMBIE_THRESHOLD_MS / 1000}s — reaped`,
          });
          emitter.emit(`job:${row.job_id}`, {
            jobId: row.job_id,
            workerId: row.worker_id ?? 'reaper',
            status: 'failed',
            error: `job stuck in '${row.status}' — reaped`,
          });
        }
      }
    } catch (err) {
      log.error({ err }, 'zombie reaper error');
    }
  }, ZOMBIE_CHECK_INTERVAL_MS);

  function getStatus(jobId: string): JobStatus | undefined {
    const row = getJob(jobId);
    if (!row) return undefined;
    return rowToJobStatus(row);
  }

  function getAllStatuses(): JobStatus[] {
    return listJobs().map(rowToJobStatus);
  }

  /**
   * Wait for a job to reach a terminal status (completed/failed).
   * First checks SQLite (handles restarts), then listens for NATS events.
   */
  function waitForCompletion(
    jobId: string,
    timeoutMs = 120_000,
  ): Promise<{ status: string; result?: string; error?: string }> {
    // Check SQLite first — job may already be done (e.g. brain restarted)
    const existing = getJob(jobId);
    if (existing && (existing.status === 'completed' || existing.status === 'failed')) {
      const s = rowToJobStatus(existing);
      return Promise.resolve({ status: s.status, result: s.result, error: s.error });
    }

    return new Promise((resolve) => {
      const eventName = `job:${jobId}`;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        emitter.removeListener(eventName, onEvent);

        // Mark as failed in DB so it doesn't stay stuck
        updateJobStatus({
          jobId,
          workerId: 'timeout',
          status: 'failed',
          error: `job ${jobId} did not complete within ${timeoutMs / 1000}s`,
        });

        resolve({ status: 'timeout', error: `job ${jobId} did not complete within ${timeoutMs / 1000}s` });
      }, timeoutMs);

      function onEvent(status: JobStatus) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        emitter.removeListener(eventName, onEvent);
        resolve({ status: status.status, result: status.result, error: status.error });
      }

      emitter.on(eventName, onEvent);

      // Double-check DB after subscribing (race window between initial check and listener registration)
      const recheck = getJob(jobId);
      if (recheck && (recheck.status === 'completed' || recheck.status === 'failed') && !settled) {
        settled = true;
        clearTimeout(timer);
        emitter.removeListener(eventName, onEvent);
        const s = rowToJobStatus(recheck);
        resolve({ status: s.status, result: s.result, error: s.error });
      }
    });
  }

  function close() {
    sub.unsubscribe();
    clearInterval(reaperInterval);
    emitter.removeAllListeners();
  }

  return { getStatus, getAllStatuses, waitForCompletion, close };
}

export type StatusTracker = ReturnType<typeof createStatusTracker>;
