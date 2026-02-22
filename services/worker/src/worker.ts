import type { NatsConnection } from 'nats';
import { type JobDispatch, type JobStatus, Subjects, codec, logger, withSpan, extractTraceContext } from '@bakerst/shared';
import type { ModelRouter } from '@bakerst/shared';
import { executeJob } from './actions.js';

const log = logger.child({ module: 'worker' });

export function createWorker(nc: NatsConnection, workerId: string, modelRouter: ModelRouter) {
  function publishStatus(status: JobStatus) {
    nc.publish(Subjects.jobStatus(status.jobId), codec.encode(status));
  }

  async function handleJob(job: JobDispatch) {
    // Restore distributed trace context from the brain's span
    const parentContext = job.traceContext ? extractTraceContext(job.traceContext) : undefined;

    return withSpan('worker.handleJob', {
      'job.id': job.jobId,
      'job.type': job.type,
    }, async (span) => {
      log.info({ jobId: job.jobId, type: job.type }, 'received job');

      const traceId = span.spanContext().traceId;

      publishStatus({
        jobId: job.jobId,
        workerId,
        status: 'received',
        traceId,
      });

      const start = Date.now();

      publishStatus({
        jobId: job.jobId,
        workerId,
        status: 'running',
        traceId,
      });

      try {
        const result = await executeJob(job, modelRouter);
        const durationMs = Date.now() - start;

        log.info({ jobId: job.jobId, durationMs }, 'job completed');

        publishStatus({
          jobId: job.jobId,
          workerId,
          status: 'completed',
          result,
          durationMs,
          traceId,
        });
      } catch (err) {
        const durationMs = Date.now() - start;
        const error = err instanceof Error ? err.message : String(err);

        log.error({ jobId: job.jobId, error, durationMs }, 'job failed');

        publishStatus({
          jobId: job.jobId,
          workerId,
          status: 'failed',
          error,
          durationMs,
          traceId,
        });
      }
    }, parentContext);
  }

  return { handleJob };
}
