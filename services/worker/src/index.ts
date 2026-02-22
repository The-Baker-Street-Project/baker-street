import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  connectNats,
  drainAndClose,
  Subjects,
  JetStream,
  codec,
  logger,
  features,
  getJetStreamClient,
  type JobDispatch,
  type Heartbeat,
} from '@bakerst/shared';
import { loadModelConfig, ModelRouter } from '@bakerst/shared';
import { createWorker } from './worker.js';

const log = logger.child({ module: 'worker-main' });
const startTime = Date.now();
const workerId = `worker-${randomUUID().slice(0, 8)}`;

async function main() {
  log.info({ workerId, mode: features.mode }, 'starting worker service');

  // Initialize model router
  const modelConfig = await loadModelConfig();
  const modelRouter = await ModelRouter.create(modelConfig);

  const nc = await connectNats(workerId);
  const worker = createWorker(nc, workerId, modelRouter);

  // Set up JetStream pull consumer
  const js = getJetStreamClient(nc);
  const stream = await js.streams.get(JetStream.STREAM_JOBS);
  const consumer = await stream.getConsumer(JetStream.CONSUMER_WORKERS);

  log.info(
    { stream: JetStream.STREAM_JOBS, consumer: JetStream.CONSUMER_WORKERS },
    'consuming jobs via JetStream pull consumer',
  );

  const messages = await consumer.consume();

  // Health probe server
  const healthServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      const ok = !nc.isClosed();
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ok ? 'healthy' : 'unhealthy' }));
    } else {
      res.writeHead(404).end();
    }
  });
  healthServer.listen(3001, () => {
    log.info({ port: 3001 }, 'worker health probe listening');
  });

  // Heartbeat
  const heartbeatInterval = setInterval(() => {
    const hb: Heartbeat = {
      id: workerId,
      uptime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
    nc.publish(Subjects.workerHeartbeat(workerId), codec.encode(hb));
  }, 30_000);

  // Process jobs from JetStream pull consumer
  (async () => {
    for await (const msg of messages) {
      try {
        const job = codec.decode(msg.data) as JobDispatch;
        if (msg.info?.redeliveryCount > 1) {
          log.warn({ jobId: job.jobId, redeliveryCount: msg.info.redeliveryCount }, 'processing redelivered job');
        }
        worker
          .handleJob(job)
          .then(() => {
            msg.ack();
          })
          .catch((err) => {
            log.error({ err, jobId: job.jobId }, 'job handler failed, nak with 5s delay');
            msg.nak(5000);
          });
      } catch (err) {
        log.error({ err }, 'failed to decode job dispatch, terminating message');
        msg.term();
      }
    }
  })();

  // Graceful shutdown
  const shutdown = async () => {
    log.info('shutting down');
    clearInterval(heartbeatInterval);
    healthServer.close();
    await messages.close();
    await drainAndClose(nc);
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
