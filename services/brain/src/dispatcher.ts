import { randomUUID } from 'node:crypto';
import type { JetStreamClient } from '@bakerst/shared';
import { type JobDispatch, Subjects, codec, logger, getTraceHeaders } from '@bakerst/shared';
import { insertJob } from './db.js';

const log = logger.child({ module: 'dispatcher' });

export function createDispatcher(js: JetStreamClient) {
  async function dispatch(
    params: Omit<JobDispatch, 'jobId' | 'createdAt'>,
  ): Promise<JobDispatch> {
    const job: JobDispatch = {
      jobId: randomUUID(),
      createdAt: new Date().toISOString(),
      ...params,
      traceContext: getTraceHeaders(),
    };

    // Persist to SQLite
    insertJob({
      jobId: job.jobId,
      type: job.type,
      source: job.source,
      input: job.job ?? job.command ?? job.url,
      createdAt: job.createdAt,
    });

    const ack = await js.publish(Subjects.JOBS_DISPATCH, codec.encode(job), {
      msgID: job.jobId,
    });
    log.info({ jobId: job.jobId, type: job.type, source: job.source, seq: ack.seq }, 'dispatched job via JetStream');
    return job;
  }

  return { dispatch };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
