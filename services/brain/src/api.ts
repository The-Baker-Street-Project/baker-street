import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import type { NatsConnection } from 'nats';
import { logger, SkillTier, features, type TriggerEvent, type SkillMetadata } from '@bakerst/shared';
import type { ModelRouter } from '@bakerst/shared';
import type { Dispatcher } from './dispatcher.js';
import type { StatusTracker } from './status-tracker.js';
import type { Agent } from './agent.js';
import type { MemoryService } from './memory.js';
import type { PluginRegistry } from './plugin-registry.js';
import type { SkillRegistry } from './skill-registry.js';
import type { McpClientManager } from './mcp-client.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { BrainStateMachine } from './brain-state.js';
import type { CompanionManager } from './companion-manager.js';
import type { ExtensionManager } from './extension-manager.js';
import { listConversations, getConversation, getMessages, listSkills, getSkill, upsertSkill, deleteSkill as deleteSkillDb, getDb, getModelConfigValue, setModelConfigValue, type ScheduleRow } from './db.js';
import { getSecrets, updateSecrets, restartDeployment } from './k8s-client.js';
import { reloadInstructionSkills } from './skill-loader.js';
import { clearSystemPromptCache, clearToolsCache } from './agent.js';
import multer from 'multer';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TaskPodManager, TaskPodRequest } from './task-pod-manager.js';

const log = logger.child({ module: 'api' });

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Health checks bypass auth
  if (req.path === '/ping') {
    next();
    return;
  }

  const configuredToken = process.env.AUTH_TOKEN;
  if (!configuredToken) {
    log.warn('AUTH_TOKEN not configured - running without authentication');
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const providedToken = authHeader.slice(7);

  if (!safeCompare(providedToken, configuredToken)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  next();
}

export function createApi(
  dispatcher: Dispatcher,
  statusTracker: StatusTracker,
  agent: Agent,
  memoryService: MemoryService,
  pluginRegistry: PluginRegistry,
  skillRegistry?: SkillRegistry,
  mcpClient?: McpClientManager,
  modelRouter?: ModelRouter,
  nc?: NatsConnection,
  scheduleManager?: ScheduleManager,
  stateMachine?: BrainStateMachine,
  startTime?: number,
  taskPodManager?: TaskPodManager,
  companionManager?: CompanionManager,
  extensionManager?: ExtensionManager,
) {
  const effectiveStartTime = startTime ?? Date.now();
  const app = express();
  app.use(express.json());

  // CORS — restrict origins in production, permissive in dev
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : null; // null = dev mode, allow all

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!allowedOrigins || (origin && allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Trace ID header middleware
  app.use((_req, res, next) => {
    const span = trace.getActiveSpan();
    if (span) {
      res.setHeader('X-Trace-Id', span.spanContext().traceId);
    }
    next();
  });

  // Auth middleware — after CORS (so preflight OPTIONS pass), before routes
  app.use(authMiddleware);

  app.get('/ping', (_req, res) => {
    if (stateMachine && !stateMachine.isReady()) {
      res.status(503).json({
        status: 'not_ready',
        service: 'brain',
        state: stateMachine.state,
        mode: features.mode,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    res.json({
      status: 'ok',
      service: 'brain',
      mode: features.mode,
      features: features.allFlags(),
      name: process.env.AGENT_NAME ?? 'Baker',
      timestamp: new Date().toISOString(),
    });
  });

  // Brain state endpoint — always accessible regardless of draining
  app.get('/brain/state', (_req, res) => {
    res.json({
      state: stateMachine?.state ?? 'active',
      version: process.env.BRAIN_VERSION ?? 'dev',
      uptime: Date.now() - effectiveStartTime,
    });
  });

  // Draining middleware — reject non-ping/non-state requests when draining
  app.use((req, res, next) => {
    if (stateMachine && !stateMachine.isAcceptingRequests()) {
      if (req.path === '/ping' || req.path === '/brain/state') {
        next();
        return;
      }
      res.status(503).json({
        error: 'service draining',
        state: stateMachine.state,
      });
      return;
    }
    next();
  });

  app.post('/webhook', async (req, res) => {
    try {
      const { type, job: jobDesc, command, url, method, headers, vars } = req.body;

      if (!type || !['agent', 'command', 'http'].includes(type)) {
        res.status(400).json({ error: 'type must be one of: agent, command, http' });
        return;
      }

      const dispatched = await dispatcher.dispatch({
        type,
        job: jobDesc,
        command,
        url,
        method,
        headers,
        vars,
        source: 'webhook',
      });

      res.status(202).json({ jobId: dispatched.jobId, status: 'dispatched' });
    } catch (err) {
      log.error({ err }, 'webhook error');
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.post('/chat', async (req, res) => {
    try {
      const { message, conversationId, channel } = req.body;

      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'message is required and must be a string' });
        return;
      }

      log.info({ message: message.slice(0, 200), conversationId, channel }, 'chat request');
      const result = await agent.chat(message, { conversationId, channel });
      res.json(result);
    } catch (err) {
      log.error({ err }, 'chat error');
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.post('/chat/stream', async (req, res) => {
    try {
      const { message, conversationId, channel } = req.body;

      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'message is required and must be a string' });
        return;
      }

      log.info({ message: message.slice(0, 200), conversationId, channel }, 'chat stream request');

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      for await (const event of agent.chatStream(message, { conversationId, channel })) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      res.end();
    } catch (err) {
      log.error({ err }, 'chat stream error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal server error' });
      } else {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'internal server error' })}\n\n`);
        res.end();
      }
    }
  });

  app.get('/conversations', (_req, res) => {
    const conversations = listConversations();
    res.json(conversations);
  });

  app.get('/conversations/:id/messages', (req, res) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' });
      return;
    }
    const messages = getMessages(req.params.id);
    res.json({ conversation, messages });
  });

  app.get('/jobs', (_req, res) => {
    const jobs = statusTracker.getAllStatuses();
    res.json(jobs);
  });

  app.get('/jobs/:id/status', (req, res) => {
    const status = statusTracker.getStatus(req.params.id);
    if (!status) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    res.json(status);
  });

  app.get('/memories', async (req, res) => {
    try {
      const q = req.query.q as string | undefined;
      const category = req.query.category as string | undefined;
      const limit = parseInt((req.query.limit as string) ?? '10', 10);

      if (q) {
        const results = await memoryService.search(q, limit);
        res.json(results);
      } else {
        const results = await memoryService.list(category, limit);
        res.json(results);
      }
    } catch (err) {
      log.error({ err }, 'memories error');
      res.status(500).json({ error: 'internal server error' });
    }
  });

  // --- Plugin webhook triggers ---

  app.post('/hooks/:plugin', async (req, res) => {
    try {
      const pluginName = req.params.plugin;
      const { event, data } = req.body as { event?: string; data?: Record<string, unknown> };

      if (!event) {
        res.status(400).json({ error: 'event field is required' });
        return;
      }

      const triggerEvent: TriggerEvent = {
        source: pluginName,
        event,
        data: data ?? {},
        timestamp: new Date().toISOString(),
      };

      log.info({ plugin: pluginName, event }, 'plugin trigger received');
      const result = await pluginRegistry.handleTrigger(pluginName, triggerEvent);

      res.json({ ok: true, result: result ?? 'no handler' });
    } catch (err) {
      log.error({ err }, 'plugin hook error');
      res.status(500).json({ error: 'internal server error' });
    }
  });

  // --- Secrets management ---

  app.get('/secrets', async (_req, res) => {
    try {
      const data = await getSecrets();
      const entries = Object.entries(data).map(([key, value]) => ({
        key,
        value,
        maskedValue: value.length > 4 ? value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2) : '****',
      }));
      entries.sort((a, b) => a.key.localeCompare(b.key));
      res.json(entries);
    } catch (err) {
      log.error({ err }, 'get secrets error');
      res.status(500).json({ error: 'failed to read secrets' });
    }
  });

  app.put('/secrets', async (req, res) => {
    try {
      const { secrets } = req.body as { secrets: Record<string, string> };
      if (!secrets || typeof secrets !== 'object') {
        res.status(400).json({ error: 'secrets object is required' });
        return;
      }
      await updateSecrets(secrets);
      res.json({ ok: true, count: Object.keys(secrets).length });
    } catch (err) {
      log.error({ err }, 'update secrets error');
      res.status(500).json({ error: 'failed to update secrets' });
    }
  });

  app.post('/secrets/restart', async (_req, res) => {
    try {
      const deployments = ['brain', 'gateway', 'worker'];
      for (const name of deployments) {
        await restartDeployment(name);
      }
      res.json({ ok: true, restarted: deployments });
    } catch (err) {
      log.error({ err }, 'restart error');
      res.status(500).json({ error: 'failed to restart services' });
    }
  });

  // --- Skills API ---

  app.get('/skills', async (_req, res) => {
    try {
      const skills = listSkills();
      const result = await Promise.all(
        skills.map(async (skill) => {
          const connected = mcpClient?.isConnected(skill.id) ?? false;
          let toolCount = 0;
          if (connected && mcpClient) {
            try {
              const tools = await mcpClient.listTools(skill.id);
              toolCount = tools.length;
            } catch {
              // tool listing failed, default to 0
            }
          }
          return { ...skill, connected, toolCount };
        }),
      );
      res.json(result);
    } catch (err) {
      log.error({ err }, 'list skills error');
      res.status(500).json({ error: 'failed to list skills' });
    }
  });

  app.post('/skills', async (req, res) => {
    try {
      const { id, name, description, version, tier, transport, enabled, config, stdioCommand, stdioArgs, httpUrl, instructionPath, instructionContent } = req.body;

      if (!name || !description || !tier) {
        res.status(400).json({ error: 'name, description, and tier are required' });
        return;
      }

      const validTiers = Object.values(SkillTier) as string[];
      if (!validTiers.includes(tier)) {
        res.status(400).json({ error: `tier must be one of: ${validTiers.join(', ')}` });
        return;
      }

      const skillId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const skill: SkillMetadata = {
        id: skillId,
        name,
        description,
        version: version ?? '1.0.0',
        tier: tier as SkillTier,
        transport: transport ?? undefined,
        enabled: enabled ?? true,
        config: config ?? {},
        stdioCommand: stdioCommand ?? undefined,
        stdioArgs: stdioArgs ?? undefined,
        httpUrl: httpUrl ?? undefined,
        instructionPath: instructionPath ?? undefined,
        instructionContent: instructionContent ?? undefined,
      };

      upsertSkill(skill);

      if (skill.tier === SkillTier.Tier0) {
        reloadInstructionSkills();
        clearSystemPromptCache();
      } else if (skill.enabled && skillRegistry) {
        try {
          await skillRegistry.connectAndRegister(skill);
        } catch (err) {
          log.warn({ err, skillId }, 'failed to connect skill after creation');
        }
      }

      // Invalidate agent's tool cache so new tools are picked up
      clearToolsCache();

      res.status(201).json(skill);
    } catch (err) {
      log.error({ err }, 'create skill error');
      res.status(500).json({ error: 'failed to create skill' });
    }
  });

  app.get('/skills/:id', async (req, res) => {
    try {
      const skill = getSkill(req.params.id);
      if (!skill) {
        res.status(404).json({ error: 'skill not found' });
        return;
      }

      const connected = mcpClient?.isConnected(skill.id) ?? false;
      let tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
      if (connected && mcpClient) {
        try {
          tools = await mcpClient.listTools(skill.id);
        } catch {
          // tool listing failed
        }
      }

      res.json({ ...skill, connected, tools, toolCount: tools.length });
    } catch (err) {
      log.error({ err }, 'get skill error');
      res.status(500).json({ error: 'failed to get skill' });
    }
  });

  app.put('/skills/:id', async (req, res) => {
    try {
      const existing = getSkill(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'skill not found' });
        return;
      }

      const { name, description, version, tier, transport, enabled, config, stdioCommand, stdioArgs, httpUrl, instructionPath, instructionContent } = req.body;
      const updated: SkillMetadata = {
        ...existing,
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(version !== undefined && { version }),
        ...(tier !== undefined && { tier }),
        ...(transport !== undefined && { transport }),
        ...(enabled !== undefined && { enabled }),
        ...(config !== undefined && { config }),
        ...(stdioCommand !== undefined && { stdioCommand }),
        ...(stdioArgs !== undefined && { stdioArgs }),
        ...(httpUrl !== undefined && { httpUrl }),
        ...(instructionPath !== undefined && { instructionPath }),
        ...(instructionContent !== undefined && { instructionContent }),
      };

      upsertSkill(updated);

      // Invalidate instruction caches when Tier 0 skills change
      if (updated.tier === SkillTier.Tier0 || existing.tier === SkillTier.Tier0) {
        reloadInstructionSkills();
        clearSystemPromptCache();
      }

      // Handle enable/disable transitions
      if (skillRegistry && mcpClient) {
        const wasEnabled = existing.enabled;
        const isNowEnabled = updated.enabled;

        if (!wasEnabled && isNowEnabled && updated.tier !== SkillTier.Tier0) {
          try {
            await skillRegistry.connectAndRegister(updated);
          } catch (err) {
            log.warn({ err, skillId: updated.id }, 'failed to connect skill after enabling');
          }
        } else if (wasEnabled && !isNowEnabled) {
          try {
            await skillRegistry.disconnectSkill(updated.id);
          } catch (err) {
            log.warn({ err, skillId: updated.id }, 'failed to disconnect skill after disabling');
          }
        }
      }

      // Invalidate agent's tool cache so changes are picked up
      clearToolsCache();

      res.json(updated);
    } catch (err) {
      log.error({ err }, 'update skill error');
      res.status(500).json({ error: 'failed to update skill' });
    }
  });

  app.delete('/skills/:id', async (req, res) => {
    try {
      const skillId = req.params.id;
      const existing = getSkill(skillId);

      // Disconnect if connected
      if (mcpClient?.isConnected(skillId) && skillRegistry) {
        try {
          await skillRegistry.disconnectSkill(skillId);
        } catch (err) {
          log.warn({ err, skillId }, 'failed to disconnect skill before deletion');
        }
      }

      const deleted = deleteSkillDb(skillId);
      if (!deleted) {
        res.status(404).json({ error: 'skill not found' });
        return;
      }

      // Invalidate instruction caches when Tier 0 skills are deleted
      if (existing?.tier === SkillTier.Tier0) {
        reloadInstructionSkills();
        clearSystemPromptCache();
      }

      // Invalidate agent's tool cache so removed tools disappear
      clearToolsCache();

      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'delete skill error');
      res.status(500).json({ error: 'failed to delete skill' });
    }
  });

  app.post('/skills/:id/test', async (req, res) => {
    try {
      const skill = getSkill(req.params.id);
      if (!skill) {
        res.status(404).json({ error: 'skill not found' });
        return;
      }

      if (!mcpClient || !skillRegistry) {
        res.status(503).json({ error: 'MCP infrastructure not available' });
        return;
      }

      if (skill.tier === SkillTier.Tier0) {
        res.json({ tools: [], message: 'Tier 0 (instruction) skills do not have MCP tools' });
        return;
      }

      // Test connection
      try {
        await skillRegistry.connectAndRegister(skill);
        const tools = await mcpClient.listTools(skill.id);
        // Disconnect test connection if skill is not enabled
        if (!skill.enabled) {
          await skillRegistry.disconnectSkill(skill.id);
        }
        res.json({ tools });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: `Connection test failed: ${errMsg}` });
      }
    } catch (err) {
      log.error({ err }, 'test skill error');
      res.status(500).json({ error: 'failed to test skill' });
    }
  });

  app.post('/skills/:id/promote', (req, res) => {
    try {
      const skill = getSkill(req.params.id);
      if (!skill) {
        res.status(404).json({ error: 'skill not found' });
        return;
      }

      if ((skill.owner ?? 'system') !== 'agent') {
        res.status(400).json({ error: 'only agent-owned skills can be promoted to system-owned' });
        return;
      }

      upsertSkill({ ...skill, owner: 'system' });
      log.info({ skillId: skill.id }, 'skill promoted from agent to system ownership');

      res.json({ ...skill, owner: 'system' });
    } catch (err) {
      log.error({ err }, 'promote skill error');
      res.status(500).json({ error: 'failed to promote skill' });
    }
  });

  // --- Skill Upload ---

  const upload = multer({ dest: tmpdir(), limits: { fileSize: 5 * 1024 * 1024 } });

  app.post('/skills/upload', upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== '.zip') {
      const { unlink } = await import('node:fs/promises');
      try { await unlink(req.file.path); } catch { /* ignore */ }
      res.status(400).json({ error: 'Only .zip files accepted' });
      return;
    }

    try {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(req.file.path);
      const entries = zip.getEntries();

      // Find SKILL.md
      const skillEntry = entries.find((e) => e.entryName.endsWith('SKILL.md') || e.entryName.endsWith('skill.md'));
      if (!skillEntry) {
        res.status(400).json({ error: 'No SKILL.md found in zip' });
        return;
      }

      const content = skillEntry.getData().toString('utf-8');

      // Parse frontmatter (--- delimited YAML at top)
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      let name = 'untitled';
      let description = '';
      let tags: string[] = [];
      let instructionContent = content;

      if (fmMatch) {
        const fm = fmMatch[1];
        instructionContent = fmMatch[2].trim();
        // Simple YAML parsing for name, description, tags
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        const tagsMatch = fm.match(/^tags:\s*\[(.+)\]$/m);
        if (nameMatch) name = nameMatch[1].trim();
        if (descMatch) description = descMatch[1].trim();
        if (tagsMatch) tags = tagsMatch[1].split(',').map((t) => t.trim());
      }

      const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      upsertSkill({
        id,
        name,
        version: '1.0.0',
        description,
        tier: SkillTier.Tier0,
        enabled: true,
        config: {},
        instructionContent,
        tags,
      });

      if (skillRegistry) {
        reloadInstructionSkills();
        clearSystemPromptCache();
      }

      res.json({ id, name, description, tags });
    } catch (err) {
      log.error({ err }, 'skill upload failed');
      res.status(500).json({ error: String(err) });
    } finally {
      // Clean up uploaded file
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(req.file!.path);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  // --- Toolboxes ---

  app.get('/toolboxes', async (_req: Request, res: Response) => {
    try {
      // Read manifest from GitHub repo (or local cache)
      // For MVP: read from env var TOOLBOX_MANIFEST_URL or return empty
      const manifestUrl = process.env.TOOLBOX_MANIFEST_URL;
      if (!manifestUrl) {
        res.json([]);
        return;
      }
      const response = await fetch(manifestUrl);
      if (!response.ok) {
        res.status(502).json({ error: 'Failed to fetch toolbox manifest' });
        return;
      }
      const manifest = await response.json() as { toolboxes: Array<{ name: string; description: string; image: string; packages: string[] }> };
      res.json(manifest.toolboxes.map((t) => ({
        ...t,
        status: 'not_built', // TODO: check docker images
        usedByRecipes: 0,
      })));
    } catch (err) {
      log.error({ err }, 'toolbox list failed');
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/toolboxes/:name/build', async (req: Request, res: Response) => {
    // Placeholder for toolbox build trigger
    res.json({ status: 'queued', toolbox: req.params.name });
  });

  app.get('/toolboxes/:name/status', (req: Request, res: Response) => {
    // Placeholder for toolbox build status
    res.json({ status: 'not_built', toolbox: req.params.name });
  });

  // --- MCP Registry Proxy ---

  app.get('/mcps/registry', async (req: Request, res: Response) => {
    try {
      const search = req.query.search as string;
      const trimmed = search?.trim() ?? '';
      if (trimmed.length < 2 || trimmed.length > 200) {
        res.status(400).json({ error: 'search query must be 2-200 characters' });
        return;
      }

      const registryUrl = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
      registryUrl.searchParams.set('search', trimmed);
      registryUrl.searchParams.set('version', 'latest');
      registryUrl.searchParams.set('limit', '20');

      const response = await fetch(registryUrl.toString(), {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        res.status(502).json({ error: `Registry returned ${response.status}` });
        return;
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > 1_000_000) {
        res.status(502).json({ error: 'Registry response too large' });
        return;
      }

      const data = await response.json();
      res.json(data);
    } catch (err) {
      log.error({ err }, 'MCP registry proxy error');
      if (err instanceof Error && err.name === 'TimeoutError') {
        res.status(504).json({ error: 'Registry request timed out' });
        return;
      }
      res.status(500).json({ error: 'failed to query MCP registry' });
    }
  });

  // --- Models API ---

  app.get('/models', (_req, res) => {
    try {
      if (!modelRouter) {
        res.json([]);
        return;
      }

      const config = modelRouter.routerConfig;
      const models = config.models.map((m) => {
        const roles: string[] = [];
        for (const [role, modelId] of Object.entries(config.roles)) {
          if (modelId === m.id) roles.push(role);
        }
        return { ...m, roles };
      });

      res.json(models);
    } catch (err) {
      log.error({ err }, 'list models error');
      res.status(500).json({ error: 'failed to list models' });
    }
  });

  app.get('/models/config', (_req, res) => {
    try {
      if (!modelRouter) {
        res.json({});
        return;
      }

      const config = modelRouter.routerConfig;

      // Deep clone and mask credentials
      const maskedProviders: Record<string, unknown> = {};
      for (const [key, provider] of Object.entries(config.providers)) {
        const masked = { ...provider } as Record<string, unknown>;
        if ('apiKey' in masked && masked.apiKey) masked.apiKey = '***';
        if ('oauthToken' in masked && masked.oauthToken) masked.oauthToken = '***';
        maskedProviders[key] = masked;
      }

      res.json({
        providers: maskedProviders,
        models: config.models,
        roles: config.roles,
        fallbackChain: config.fallbackChain,
      });
    } catch (err) {
      log.error({ err }, 'get model config error');
      res.status(500).json({ error: 'failed to get model config' });
    }
  });

  app.put('/models/config', (req, res) => {
    try {
      if (!modelRouter) {
        res.status(503).json({ error: 'model router not available' });
        return;
      }

      const { roles, fallbackChain } = req.body;

      if (roles && typeof roles !== 'object') {
        res.status(400).json({ error: 'roles must be an object mapping role names to model IDs' });
        return;
      }
      if (fallbackChain && !Array.isArray(fallbackChain)) {
        res.status(400).json({ error: 'fallbackChain must be an array of model IDs' });
        return;
      }

      modelRouter.updateConfig({ roles, fallbackChain });

      // Persist to DB
      if (roles) {
        setModelConfigValue('roles', JSON.stringify(roles));
      }
      if (fallbackChain) {
        setModelConfigValue('fallbackChain', JSON.stringify(fallbackChain));
      }

      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'update model config error');
      res.status(500).json({ error: 'failed to update model config' });
    }
  });

  // --- System API ---

  app.get('/system/health', async (_req, res) => {
    try {
      const health: Record<string, { status: string; detail?: string }> = {
        brain: { status: 'healthy' },
        nats: { status: 'unknown', detail: 'no connection provided' },
        qdrant: { status: 'unknown', detail: 'not checked' },
        db: { status: 'unhealthy' },
      };

      // Check NATS
      if (nc) {
        health.nats = nc.isClosed()
          ? { status: 'unhealthy', detail: 'connection closed' }
          : { status: 'healthy' };
      }

      // Check Qdrant
      const qdrantUrl = process.env.QDRANT_URL ?? 'http://qdrant:6333';
      try {
        const qdrantRes = await fetch(`${qdrantUrl}/healthz`, {
          signal: AbortSignal.timeout(3000),
        });
        health.qdrant = qdrantRes.ok
          ? { status: 'healthy' }
          : { status: 'unhealthy', detail: `HTTP ${qdrantRes.status}` };
      } catch (err) {
        health.qdrant = {
          status: 'unhealthy',
          detail: err instanceof Error ? err.message : 'connection failed',
        };
      }

      // Check DB
      try {
        getDb();
        health.db = { status: 'healthy' };
      } catch {
        health.db = { status: 'unhealthy', detail: 'database not accessible' };
      }

      res.json(health);
    } catch (err) {
      log.error({ err }, 'system health error');
      res.status(500).json({ error: 'failed to check health' });
    }
  });

  app.get('/system/skills/status', async (_req, res) => {
    try {
      const skills = listSkills();
      const statuses = skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        tier: skill.tier,
        enabled: skill.enabled,
        connected: mcpClient?.isConnected(skill.id) ?? false,
      }));
      res.json(statuses);
    } catch (err) {
      log.error({ err }, 'skills status error');
      res.status(500).json({ error: 'failed to get skills status' });
    }
  });

  // --- Schedules API ---

  function formatSchedule(row: ScheduleRow) {
    return {
      ...row,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      enabled: Boolean(row.enabled),
    };
  }

  app.get('/schedules', (_req: Request, res: Response) => {
    try {
      if (!scheduleManager) {
        res.status(503).json({ error: 'schedule manager not available' });
        return;
      }
      const schedules = scheduleManager.list();
      res.json(schedules.map(formatSchedule));
    } catch (err) {
      log.error({ err }, 'list schedules error');
      res.status(500).json({ error: 'failed to list schedules' });
    }
  });

  app.post('/schedules', (req: Request, res: Response) => {
    try {
      if (!scheduleManager) {
        res.status(503).json({ error: 'schedule manager not available' });
        return;
      }

      const { name, schedule, type, config, enabled } = req.body;
      if (!name || !schedule || !type) {
        res.status(400).json({ error: 'name, schedule, and type are required' });
        return;
      }

      if (typeof name === 'string' && name.length > 200) {
        res.status(400).json({ error: 'name must be 200 characters or fewer' });
        return;
      }

      const VALID_TYPES = ['agent', 'command', 'http'];
      if (!VALID_TYPES.includes(type)) {
        res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
        return;
      }

      const row = scheduleManager.create({ name, schedule, type, config: config ?? {}, enabled });
      res.status(201).json(formatSchedule(row));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed to create schedule';
      log.error({ err }, 'create schedule error');
      res.status(400).json({ error: msg });
    }
  });

  app.get('/schedules/:id', (req: Request, res: Response) => {
    try {
      if (!scheduleManager) {
        res.status(503).json({ error: 'schedule manager not available' });
        return;
      }
      const id = req.params.id as string;
      const row = scheduleManager.get(id);
      if (!row) {
        res.status(404).json({ error: 'schedule not found' });
        return;
      }
      res.json(formatSchedule(row));
    } catch (err) {
      log.error({ err }, 'get schedule error');
      res.status(500).json({ error: 'failed to get schedule' });
    }
  });

  app.put('/schedules/:id', (req: Request, res: Response) => {
    try {
      if (!scheduleManager) {
        res.status(503).json({ error: 'schedule manager not available' });
        return;
      }

      const id = req.params.id as string;
      const { name, schedule, type, config, enabled } = req.body;
      const updated = scheduleManager.update(id, { name, schedule, type, config, enabled });
      if (!updated) {
        res.status(404).json({ error: 'schedule not found' });
        return;
      }
      res.json(formatSchedule(updated));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed to update schedule';
      log.error({ err }, 'update schedule error');
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/schedules/:id', (req: Request, res: Response) => {
    try {
      if (!scheduleManager) {
        res.status(503).json({ error: 'schedule manager not available' });
        return;
      }
      const id = req.params.id as string;
      const deleted = scheduleManager.delete(id);
      if (!deleted) {
        res.status(404).json({ error: 'schedule not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'delete schedule error');
      res.status(500).json({ error: 'failed to delete schedule' });
    }
  });

  app.post('/schedules/:id/run', async (req: Request, res: Response) => {
    try {
      if (!scheduleManager) {
        res.status(503).json({ error: 'schedule manager not available' });
        return;
      }
      const id = req.params.id as string;
      const jobId = await scheduleManager.trigger(id);
      res.json({ ok: true, jobId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed to trigger schedule';
      log.error({ err }, 'trigger schedule error');
      res.status(400).json({ error: msg });
    }
  });

  // --- Task Pods ---

  app.post('/tasks', async (req: Request, res: Response) => {
    if (!taskPodManager) {
      res.status(503).json({ error: 'Task pods not enabled' });
      return;
    }
    try {
      const body = req.body as TaskPodRequest;
      if (!body.toolbox || !body.mode || !body.goal) {
        res.status(400).json({ error: 'toolbox, mode, and goal are required' });
        return;
      }
      if (body.mode !== 'agent' && body.mode !== 'script') {
        res.status(400).json({ error: `mode must be 'agent' or 'script', got: ${body.mode}` });
        return;
      }
      const taskId = await taskPodManager.dispatch(body);
      res.json({ taskId });
    } catch (err) {
      log.error({ err }, 'task dispatch failed');
      res.status(500).json({ error: String(err) });
    }
  });

  // --- Companions ---

  app.get('/companions', (_req: Request, res: Response) => {
    if (!companionManager) {
      res.status(503).json({ error: 'Companions not enabled' });
      return;
    }
    const companions = companionManager.getCompanions();
    res.json(companions);
  });

  app.get('/companions/:id', (req: Request, res: Response) => {
    if (!companionManager) {
      res.status(503).json({ error: 'Companions not enabled' });
      return;
    }
    const id = req.params.id as string;
    const companion = companionManager.getCompanion(id);
    if (!companion) {
      res.status(404).json({ error: 'Companion not found' });
      return;
    }
    res.json(companion);
  });

  app.post('/companions/:id/task', async (req: Request, res: Response) => {
    if (!companionManager) {
      res.status(503).json({ error: 'Companions not enabled' });
      return;
    }
    try {
      const id = req.params.id as string;
      const { mode, goal, tools, timeout } = req.body as { mode: 'agent' | 'script'; goal: string; tools?: string[]; timeout?: number };
      if (!mode || !goal) {
        res.status(400).json({ error: 'mode and goal are required' });
        return;
      }
      if (mode !== 'agent' && mode !== 'script') {
        res.status(400).json({ error: "mode must be 'agent' or 'script'" });
        return;
      }
      const taskId = await companionManager.dispatchTask(id, { mode, goal, tools, timeout });
      res.json({ taskId });
    } catch (err) {
      log.error({ err }, 'companion task dispatch failed');
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/tasks', (_req: Request, res: Response) => {
    if (!taskPodManager) {
      res.status(503).json({ error: 'Task pods not enabled' });
      return;
    }
    const tasks = taskPodManager.listTasks();
    res.json(tasks);
  });

  app.get('/tasks/:id', (req: Request, res: Response) => {
    if (!taskPodManager) {
      res.status(503).json({ error: 'Task pods not enabled' });
      return;
    }
    const task = taskPodManager.getTask(req.params.id as string);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(task);
  });

  app.delete('/tasks/:id', async (req: Request, res: Response) => {
    if (!taskPodManager) {
      res.status(503).json({ error: 'Task pods not enabled' });
      return;
    }
    try {
      const cancelled = await taskPodManager.cancel(req.params.id as string);
      res.json({ ok: cancelled });
    } catch (err) {
      log.error({ err }, 'task cancel failed');
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/companions/:id/tasks', (req: Request, res: Response) => {
    if (!companionManager) {
      res.status(503).json({ error: 'Companions not enabled' });
      return;
    }
    const id = req.params.id as string;
    const tasks = companionManager.getCompanionTasks(id);
    res.json(tasks);
  });

  // --- Extensions ---

  app.get('/extensions', (_req: Request, res: Response) => {
    if (!extensionManager) {
      res.status(503).json({ error: 'Extensions not enabled' });
      return;
    }
    const extensions = extensionManager.getExtensions();
    res.json(extensions);
  });


  return app;
}
