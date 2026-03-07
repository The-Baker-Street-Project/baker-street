import { createServer } from 'node:http';
import { logger, ModelRouter, loadModelConfig } from '@bakerst/shared';
import { SysAdminStateMachine } from './state-machine.js';
import { createAgent } from './agent.js';
import { createApi, sendToTerminal } from './api.js';
import { loadPrompt } from './skill-loader.js';
import { buildToolsForState } from './tool-registry.js';
import { loadState, saveState } from './persistence.js';
import { createAllTools } from './tools/index.js';
import type { SysAdminState } from '@bakerst/shared';

const log = logger.child({ module: 'sysadmin' });
const PORT = parseInt(process.env.PORT ?? '3090', 10);

async function main(): Promise<void> {
  log.info('Baker Street SysAdmin starting...');

  // Load persisted state (or default to 'verify')
  let persistedState;
  try {
    persistedState = await loadState();
  } catch {
    log.info('running outside cluster, using default verify state');
    persistedState = { state: 'verify' as SysAdminState, healthHistory: [] };
  }

  const initialState = persistedState.state;
  const stateMachine = new SysAdminStateMachine(initialState);

  // Initialize ModelRouter
  const modelConfig = await loadModelConfig();
  const modelRouter = await ModelRouter.create(modelConfig);

  // Load initial prompt
  const systemPrompt = await loadPrompt(initialState);

  // Build all available tools
  const allTools = createAllTools();

  // Filter tools for current state
  const stateTools = buildToolsForState(initialState, allTools);

  // Create agent
  const agent = createAgent(modelRouter, systemPrompt, stateTools);

  // Create API
  const { app, attachWebSocket } = createApi(agent, stateMachine);

  // Listen for state transitions to reconfigure the agent
  stateMachine.on('transition', async (newState: SysAdminState) => {
    log.info({ newState }, 'reconfiguring agent for new state');

    const newPrompt = await loadPrompt(newState);
    const newTools = buildToolsForState(newState, allTools);
    agent.reconfigure(newPrompt, newTools);
    agent.clearHistory();

    // Persist state
    persistedState.state = newState;
    try {
      await saveState(persistedState);
    } catch (err) {
      log.warn({ err }, 'failed to persist state after transition');
    }

    sendToTerminal({ type: 'status', state: newState });

    // In runtime mode, send an initial greeting and start health timer
    if (newState === 'runtime') {
      sendToTerminal({
        type: 'text',
        content: 'Deployment complete. Entering runtime monitoring mode.',
      });
      startHealthTimer(agent, stateMachine, persistedState);
    }

    // Stop health timer when leaving runtime
    if (newState !== 'runtime') {
      stopHealthTimer();
    }
  });

  // If resuming into runtime mode, start the health timer
  if (initialState === 'runtime') {
    startHealthTimer(agent, stateMachine, persistedState);
  }

  // If starting in verify mode, auto-trigger a health verification
  if (initialState === 'verify') {
    log.info('auto-triggering health verification');
    // Run async so it doesn't block server startup
    setImmediate(async () => {
      try {
        await agent.chat(
          'Run a post-deploy health verification: check all pod health, verify running image digests against the manifest, then transition to runtime.',
        );
      } catch (err) {
        log.error({ err }, 'auto-verify failed');
      }
    });
  }

  // Start HTTP server
  const server = createServer(app);
  attachWebSocket(server);

  server.listen(PORT, () => {
    log.info({ port: PORT, state: initialState }, 'SysAdmin listening');
  });

  // Graceful shutdown
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log.info({ signal }, 'shutting down');
      server.close();
      process.exit(0);
    });
  }
}

// ---------------------------------------------------------------------------
// Timers — health checks (5 min) + integrity verification (1 hour)
// ---------------------------------------------------------------------------

const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;     // 5 minutes
const INTEGRITY_CHECK_INTERVAL = 60 * 60 * 1000;  // 1 hour
let healthTimer: ReturnType<typeof setInterval> | undefined;
let integrityTimer: ReturnType<typeof setInterval> | undefined;

function startHealthTimer(
  agent: ReturnType<typeof createAgent>,
  stateMachine: SysAdminStateMachine,
  persistedState: import('@bakerst/shared').SysAdminPersistedState,
): void {
  stopHealthTimer();
  log.info('starting health check timer (5-min interval) + integrity timer (1-hour interval)');

  // --- Health check: every 5 minutes ---
  healthTimer = setInterval(async () => {
    if (stateMachine.state !== 'runtime') return;

    try {
      const result = await agent.chat(
        'Run a health check on all Baker Street services and verify running image digests against the manifest. Report any issues briefly.',
      );

      // Persist health check result
      persistedState.lastHealthCheck = {
        timestamp: new Date().toISOString(),
        healthy: !result.response.toLowerCase().includes('unhealthy')
          && !result.response.toLowerCase().includes('mismatch'),
        components: [],
      };
      persistedState.healthHistory.push(persistedState.lastHealthCheck);

      await saveState(persistedState).catch((err) =>
        log.warn({ err }, 'failed to persist health check'),
      );

      const hasIssues = result.response.toLowerCase().includes('unhealthy')
        || result.response.toLowerCase().includes('mismatch');
      if (hasIssues) {
        sendToTerminal({ type: 'text', content: `[Health Check] Issues detected:\n${result.response}` });
      }
    } catch (err) {
      log.error({ err }, 'health check failed');
    }
  }, HEALTH_CHECK_INTERVAL);

  // --- Full cosign verification: every hour ---
  integrityTimer = setInterval(async () => {
    if (stateMachine.state !== 'runtime') return;

    try {
      const result = await agent.chat(
        'Run a full cosign signature verification on all Baker Street images. ' +
        'For each image in the release manifest that has a digest, call verify_image_integrity. ' +
        'Report any verification failures immediately.',
      );

      if (result.response.toLowerCase().includes('failed')) {
        sendToTerminal({
          type: 'text',
          content: `[Integrity Alert] Signature verification issue:\n${result.response}`,
        });
      }
    } catch (err) {
      log.error({ err }, 'integrity verification failed');
    }
  }, INTEGRITY_CHECK_INTERVAL);
}

function stopHealthTimer(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = undefined;
  }
  if (integrityTimer) {
    clearInterval(integrityTimer);
    integrityTimer = undefined;
  }
  if (healthTimer === undefined && integrityTimer === undefined) {
    log.info('all runtime timers stopped');
  }
}

main().catch((err) => {
  log.error({ err }, 'fatal startup error');
  process.exit(1);
});
