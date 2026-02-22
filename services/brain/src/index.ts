import {
  connectNats,
  drainAndClose,
  Subjects,
  JetStream,
  codec,
  logger,
  getTraceHeaders,
  getJetStreamManager,
  getJetStreamClient,
  ensureStream,
  ensureConsumer,
  features,
  type Heartbeat,
} from '@bakerst/shared';
import { createDispatcher } from './dispatcher.js';
import { createStatusTracker } from './status-tracker.js';
import { createApi } from './api.js';
import { createAgent } from './agent.js';
import { initMemory, createNoOpMemoryService } from './memory.js';
import { ScheduleManager } from './schedule-manager.js';
import { loadPlugins } from './plugin-registry.js';
import { getDb, closeDb, insertApiAudit, getModelConfigValue } from './db.js';
import { loadModelConfig, ModelRouter } from '@bakerst/shared';
import { McpClientManager } from './mcp-client.js';
import { SkillRegistry } from './skill-registry.js';
import { createUnifiedToolRegistry } from './plugin-bridge.js';
import { BrainStateMachine } from './brain-state.js';
import { CompanionManager } from './companion-manager.js';
import { TransferHandler } from './transfer.js';
import { TaskPodManager } from './task-pod-manager.js';
import type { BrainState } from '@bakerst/shared';

const log = logger.child({ module: 'brain' });
const startTime = Date.now();

async function main() {
  log.info('starting brain service');

  // Initialize SQLite
  getDb();

  // Initialize model router
  const modelConfig = await loadModelConfig();
  const modelRouter = await ModelRouter.create(modelConfig);

  // Load persisted model config from DB
  try {
    const persistedRoles = getModelConfigValue('roles');
    const persistedFallbackChain = getModelConfigValue('fallbackChain');
    const updates: { roles?: Record<string, string>; fallbackChain?: string[] } = {};
    if (persistedRoles) updates.roles = JSON.parse(persistedRoles);
    if (persistedFallbackChain) updates.fallbackChain = JSON.parse(persistedFallbackChain);
    if (updates.roles || updates.fallbackChain) {
      modelRouter.updateConfig(updates);
      log.info('loaded persisted model config from database');
    }
  } catch (err) {
    log.warn({ err }, 'failed to load persisted model config, using defaults');
  }

  // Wire audit logging for model API calls
  modelRouter.setOnApiCall((info: { provider: string; model: string; durationMs: number; inputTokens?: number; outputTokens?: number; error?: string }) => {
    const traceHeaders = getTraceHeaders();
    const traceId = traceHeaders['traceparent']?.split('-')[1];
    try {
      insertApiAudit({
        provider: info.provider,
        model: info.model,
        durationMs: info.durationMs,
        inputTokens: info.inputTokens,
        outputTokens: info.outputTokens,
        error: info.error,
        traceId,
      });
    } catch (err) {
      log.warn({ err }, 'failed to write API audit entry');
    }
  });

  // Initialize brain state machine
  const brainRole = (process.env.BRAIN_ROLE ?? 'active') as BrainState;
  const brainVersion = process.env.BRAIN_VERSION ?? 'dev';
  const stateMachine = new BrainStateMachine(brainRole);
  log.info({ role: brainRole, version: brainVersion }, 'brain state machine initialized');

  const nc = await connectNats('brain');

  // Initialize task pod manager
  let taskPodManager: TaskPodManager | undefined;
  if (features.isEnabled('taskPods')) {
    taskPodManager = new TaskPodManager(nc);
  }

  // Initialize transfer handler for zero-downtime upgrades
  let transferHandler: TransferHandler | undefined;
  if (features.isEnabled('transferProtocol')) {
    transferHandler = new TransferHandler(nc, stateMachine, brainVersion);
    await transferHandler.startListening();
    log.info('transfer handler listening');
  } else {
    stateMachine.forceActive();
    log.info('transfer protocol disabled — starting as active');
  }

  // Initialize JetStream: create stream and consumer for job dispatch
  const jsm = await getJetStreamManager(nc);
  await ensureStream(jsm, {
    name: JetStream.STREAM_JOBS,
    subjects: [Subjects.JOBS_DISPATCH],
  });
  await ensureConsumer(jsm, {
    stream: JetStream.STREAM_JOBS,
    name: JetStream.CONSUMER_WORKERS,
    ackWait: 60_000,
    maxDeliver: 3,
  });
  const js = getJetStreamClient(nc);

  const dispatcher = createDispatcher(js);
  const statusTracker = createStatusTracker(nc);
  const memoryService = features.isEnabled('memory')
    ? await initMemory()
    : createNoOpMemoryService();

  // Initialize schedule manager (replaces file-based loadCrons)
  let scheduleManager: ScheduleManager | undefined;
  if (features.isEnabled('scheduler')) {
    scheduleManager = new ScheduleManager(dispatcher);
    await scheduleManager.migrateFromFile(); // One-time: seed from CRONS.json if exists
    await scheduleManager.loadFromDatabase();
  }

  // Initialize MCP client manager and skill registry
  let mcpClientManager: McpClientManager | undefined;
  let skillRegistry: SkillRegistry | undefined;
  if (features.isEnabled('mcp')) {
    mcpClientManager = new McpClientManager();
    skillRegistry = new SkillRegistry(mcpClientManager);

    // One-time migration: convert PLUGINS.json entries to skills database
    const pluginsPath = process.env.PLUGINS_PATH ?? '/etc/bakerst/PLUGINS.json';
    try {
      const migrated = await skillRegistry.migrateFromPluginsJson(pluginsPath);
      if (migrated > 0) {
        log.info({ migrated }, 'migrated plugins to skills database');
      }
    } catch (err) {
      log.warn({ err }, 'PLUGINS.json migration failed, continuing');
    }

    // Load MCP skills from database (connects to Tier 1-3 MCP servers)
    try {
      await skillRegistry.loadFromDatabase();
    } catch (err) {
      log.warn({ err }, 'skill registry loading failed, continuing with legacy plugins only');
    }
  }

  // Load legacy plugins (backward compatibility)
  const pluginRegistry = await loadPlugins({ dispatcher, statusTracker, memoryService });

  // Create unified tool registry bridging skills and legacy plugins
  const unifiedRegistry = createUnifiedToolRegistry(skillRegistry, pluginRegistry);

  // Initialize companion manager
  let companionManager: CompanionManager | undefined;
  if (features.isEnabled('companions')) {
    companionManager = new CompanionManager(nc);
    await companionManager.start();
  }

  const agent = createAgent(dispatcher, statusTracker, memoryService, pluginRegistry, modelRouter, unifiedRegistry, skillRegistry, startTime, '0.1.0', taskPodManager, companionManager);
  const app = createApi(dispatcher, statusTracker, agent, memoryService, pluginRegistry, skillRegistry, mcpClientManager, modelRouter, nc, scheduleManager, stateMachine, startTime, taskPodManager, companionManager);
  const port = parseInt(process.env.PORT ?? '3000', 10);
  const server = app.listen(port, () => {
    log.info({ port }, 'brain API listening');
  });

  // Heartbeat
  const heartbeatInterval = setInterval(() => {
    const hb: Heartbeat = {
      id: 'brain',
      uptime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
    nc.publish(Subjects.HEARTBEAT_BRAIN, codec.encode(hb));
  }, 30_000);

  // Graceful shutdown
  const shutdown = async () => {
    log.info('shutting down');
    clearInterval(heartbeatInterval);
    transferHandler?.stop();
    taskPodManager?.shutdown();
    scheduleManager?.stopAll();
    companionManager?.shutdown();
    await unifiedRegistry.shutdown();
    statusTracker.close();
    server.close();
    closeDb();
    await drainAndClose(nc);
    process.exit(0);
  };

  // Shutdown when state machine transitions to shutdown (transfer protocol)
  if (features.isEnabled('transferProtocol')) {
    stateMachine.on('shutdown', () => {
      log.info('state machine triggered shutdown via transfer protocol');
      shutdown();
    });
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.fatal({ err }, 'brain failed to start');
  process.exit(1);
});
