import { logger, type CompanionTask } from '@bakerst/shared';
import { loadConfig } from './config.js';
import { CompanionNatsClient } from './nats.js';
import { executeTask } from './executor.js';

const log = logger.child({ module: 'companion' });

async function main() {
  const configPath = process.argv[2] ?? process.env.COMPANION_CONFIG;
  const config = loadConfig(configPath);
  log.info({ id: config.id, capabilities: config.capabilities }, 'starting Companion agent');

  const nats = new CompanionNatsClient(config);
  await nats.connect();
  log.info('connected to NATS');

  await nats.announce();
  log.info('announced to brain');

  nats.startHeartbeat();
  log.info('heartbeat started');

  nats.subscribeToTasks(async (task: CompanionTask) => {
    log.info({ taskId: task.taskId, mode: task.mode }, 'received task');

    const result = await executeTask(config.id, task, (progress) => {
      nats.publishProgress(progress);
    });

    nats.publishResult(result);
    log.info({ taskId: task.taskId, status: result.status }, 'task complete');
  });

  log.info({ id: config.id }, 'Companion agent ready');

  // Graceful shutdown
  const shutdown = async () => {
    log.info('shutting down');
    await nats.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.fatal({ err }, 'Companion failed to start');
  process.exit(1);
});
