import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { logger, withSpan, getTraceHeaders, features } from '@bakerst/shared';
import type { ChatContentBlock, ToolDefinition, SystemBlock, ChatMessage, ModelRouter } from '@bakerst/shared';
import type { Dispatcher } from './dispatcher.js';
import type { StatusTracker } from './status-tracker.js';
import type { MemoryService, MemorySearchResult } from './memory.js';
import type { PluginRegistry } from './plugin-registry.js';
import type { UnifiedToolRegistry } from './plugin-bridge.js';
import type { SkillRegistry } from './skill-registry.js';
import {
  createConversation,
  getConversation,
  addMessage,
  initMemoryState,
  getUndeliveredChangelog,
  markChangelogDelivered,
  listSkills,
  listSchedules,
} from './db.js';
import { buildContext } from './context-builder.js';
import { runObserver } from './observer.js';
import { loadInstructionSkills } from './skill-loader.js';
import { executeSelfManagementTool, type SystemInfo } from './self-management.js';
import type { TaskPodManager, TaskPodRequest } from './task-pod-manager.js';
import type { CompanionManager } from './companion-manager.js';

const log = logger.child({ module: 'agent' });

/** Patterns matching common API keys and tokens that should not leak to the model */
const SENSITIVE_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,   // Anthropic API keys
  /sk-[a-zA-Z0-9]{32,}/g,          // OpenAI API keys
  /pa-[a-zA-Z0-9_-]{20,}/g,        // Voyage API keys
  /\b[a-f0-9]{64}\b/g,              // 64-char hex tokens (e.g. AUTH_TOKEN)
];

/** Strip sensitive tokens/keys from tool output before sending to the model */
function sanitizeToolOutput(text: string): string {
  let sanitized = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

let cachedStaticPrompt: string | undefined;

/** Clear the cached system prompt, forcing a rebuild on next chat call */
export function clearSystemPromptCache(): void {
  cachedStaticPrompt = undefined;
  log.info('system prompt cache cleared');
}

/** Callback to clear the resolved tools cache; set by createAgent */
let clearToolsCacheFn: (() => void) | undefined;

/** Clear the cached tool list, forcing re-resolution on next chat call */
export function clearToolsCache(): void {
  clearToolsCacheFn?.();
}

/** Load the static portion of the system prompt (SOUL.md, BRAIN.md, instruction skills). Cached. */
async function loadStaticPrompt(): Promise<string> {
  if (cachedStaticPrompt !== undefined) return cachedStaticPrompt;

  const osDir = process.env.OS_DIR ?? '/etc/bakerst';
  const parts: string[] = [];

  for (const file of ['SOUL.md', 'BRAIN.md']) {
    try {
      const content = await readFile(`${osDir}/${file}`, 'utf-8');
      parts.push(content.replaceAll('{{AGENT_NAME}}', process.env.AGENT_NAME ?? 'Baker'));
    } catch {
      log.warn({ file }, 'could not load operating system file');
    }
  }

  // Append Tier 0 instruction skills after core personality files
  try {
    const instructions = await loadInstructionSkills();
    if (instructions) {
      parts.push(`## Active Skills (Instructions)\n\n${instructions}`);
    }
  } catch (err) {
    log.warn({ err }, 'failed to load instruction skills, continuing without');
  }

  cachedStaticPrompt = parts.join('\n\n---\n\n');
  return cachedStaticPrompt;
}

/** Build the full system prompt including dynamic sections (capabilities, changelog). */
async function loadSystemPrompt(skillRegistry?: SkillRegistry, brainVersion?: string): Promise<string> {
  const staticPrompt = await loadStaticPrompt();
  const dynamicParts: string[] = [];

  // Append capabilities summary (always fresh)
  if (skillRegistry) {
    try {
      const capabilities = skillRegistry.getCapabilitiesSummary();
      dynamicParts.push(`## Current Capabilities\n\n${capabilities}`);
    } catch (err) {
      log.warn({ err }, 'failed to build capabilities summary');
    }
  }

  // Append brain version
  if (brainVersion) {
    dynamicParts.push(`## System Version\n\nBrain v${brainVersion}`);
  }

  // Append undelivered changelog entry
  try {
    const changelog = getUndeliveredChangelog();
    if (changelog) {
      dynamicParts.push(`## What's New (v${changelog.version})\n\n${changelog.summary}`);
      markChangelogDelivered(changelog.version);
    }
  } catch (err) {
    log.warn({ err }, 'failed to check changelog');
  }

  if (dynamicParts.length === 0) return staticPrompt;

  return staticPrompt + '\n\n---\n\n' + dynamicParts.join('\n\n---\n\n');
}

const tools: ToolDefinition[] = [
  {
    name: 'dispatch_job',
    description:
      'Dispatch a job to a worker and wait for the result. Use type "command" to run shell commands, "agent" to send a task to Claude on the worker, or "http" to make HTTP requests.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['agent', 'command', 'http'],
          description: 'The type of job to dispatch',
        },
        job: {
          type: 'string',
          description: 'For agent jobs: the task description to send to Claude',
        },
        command: {
          type: 'string',
          description: 'For command jobs: the shell command to execute',
        },
        url: {
          type: 'string',
          description: 'For http jobs: the URL to request',
        },
        method: {
          type: 'string',
          description: 'For http jobs: the HTTP method (default: GET)',
        },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_job_status',
    description: 'Check the status of a specific job by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        job_id: {
          type: 'string',
          description: 'The job ID to look up',
        },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'list_jobs',
    description: 'List recent jobs and their statuses.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of jobs to return (default: 20)',
        },
      },
    },
  },
  {
    name: 'memory_store',
    description:
      'Store a fact or piece of information in long-term memory. Use this when the user shares important personal info, preferences, or says "remember this". Memories persist across all conversations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'The fact or information to remember (a clear, self-contained statement)',
        },
        category: {
          type: 'string',
          enum: ['gear', 'preferences', 'homelab', 'personal', 'work', 'general'],
          description: 'Category for the memory (default: general)',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_search',
    description:
      'Search long-term memory for relevant facts. Use this for targeted lookups beyond the automatically retrieved memories. Returns memories ranked by relevance.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'What to search for in memory',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 5)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_delete',
    description:
      'Delete a memory by its ID. Use this when a fact is outdated, incorrect, or the user asks to forget something. Get the ID from memory_search or auto-retrieved memories.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The memory ID to delete',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'manage_skill',
    description:
      'Create, update, enable, disable, or delete agent-owned skills. You can only modify skills you own (owner=agent). System-owned skills are read-only. Cannot create sidecar (Tier 2) skills.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'enable', 'disable', 'delete'],
          description: 'The action to perform',
        },
        id: {
          type: 'string',
          description: 'Skill ID (required for update/enable/disable/delete, auto-generated from name for create)',
        },
        name: { type: 'string', description: 'Human-readable skill name' },
        description: { type: 'string', description: 'What this skill provides' },
        tier: {
          type: 'string',
          enum: ['instruction', 'stdio', 'service'],
          description: 'Skill tier: instruction (Tier 0), stdio (Tier 1), or service (Tier 3)',
        },
        version: { type: 'string', description: 'Semantic version (default: 1.0.0)' },
        transport: { type: 'string', description: 'Transport protocol for Tier 1-3' },
        config: { type: 'object', description: 'Arbitrary skill configuration' },
        stdioCommand: { type: 'string', description: 'For stdio tier: command to execute' },
        stdioArgs: { type: 'array', items: { type: 'string' }, description: 'For stdio tier: command arguments' },
        httpUrl: { type: 'string', description: 'For service tier: MCP server URL' },
        instructionPath: { type: 'string', description: 'For instruction tier: path to markdown file' },
        instructionContent: { type: 'string', description: 'For instruction tier: inline markdown content' },
      },
      required: ['action'],
    },
  },
  {
    name: 'list_skills',
    description:
      'List all registered skills with their owner, tier, and enabled status. Optionally filter by owner.',
    input_schema: {
      type: 'object' as const,
      properties: {
        owner: {
          type: 'string',
          enum: ['system', 'agent', 'all'],
          description: 'Filter by owner (default: all)',
        },
      },
    },
  },
  {
    name: 'search_registry',
    description:
      'Search the MCP registry for available MCP servers that could be installed as new skills.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query for the MCP registry',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_system_info',
    description:
      'Get system information: version, uptime, skill count, tool count, and schedule count.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'dispatch_task_pod',
    description: 'Dispatch a task to an isolated Kubernetes pod. Use for sensitive operations, file processing, or tasks requiring specific toolboxes (documents, media, data).',
    input_schema: {
      type: 'object' as const,
      properties: {
        recipe: { type: 'string', description: 'Optional task recipe skill name' },
        toolbox: { type: 'string', description: 'Toolbox image name: base, documents, media, or data' },
        mode: { type: 'string', enum: ['agent', 'script'], description: 'Execution mode' },
        goal: { type: 'string', description: 'Goal prompt (agent mode) or script content (script mode)' },
        mounts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              hostPath: { type: 'string' },
              permissions: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'delete'] } },
            },
            required: ['hostPath', 'permissions'],
          },
          description: 'Host paths to mount in the pod',
        },
        secrets: { type: 'array', items: { type: 'string' }, description: 'K8s secret names to inject' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 1800)' },
      },
      required: ['toolbox', 'mode', 'goal'],
    },
  },
  {
    name: 'dispatch_companion',
    description: 'Dispatch a task to a connected Companion agent on a remote host. Use for tasks requiring access to resources on other machines in the homelab.',
    input_schema: {
      type: 'object' as const,
      properties: {
        companionId: { type: 'string', description: 'ID of the Companion to send to (e.g., "mycroft")' },
        mode: { type: 'string', enum: ['agent', 'script'], description: 'Execution mode' },
        goal: { type: 'string', description: 'Goal prompt (agent mode) or script content (script mode)' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Subset of the Companion capabilities to enable' },
        timeout: { type: 'number', description: 'Timeout in seconds' },
      },
      required: ['companionId', 'mode', 'goal'],
    },
  },
];

/** Self-management tool names */
const SELF_MGMT_TOOLS = new Set(['manage_skill', 'list_skills', 'search_registry', 'get_system_info']);

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  dispatcher: Dispatcher,
  statusTracker: StatusTracker,
  memoryService: MemoryService,
  pluginRegistry: PluginRegistry,
  unifiedRegistry?: UnifiedToolRegistry,
  systemInfo?: SystemInfo,
  taskPodManager?: TaskPodManager,
  companionManager?: CompanionManager,
): Promise<{ result: string; jobId?: string }> {
  // Handle self-management tools
  if (SELF_MGMT_TOOLS.has(toolName)) {
    return executeSelfManagementTool(toolName, toolInput, systemInfo);
  }

  // Delegate to unified registry (skills + plugins) if it owns this tool
  if (unifiedRegistry?.hasTool(toolName)) {
    return unifiedRegistry.execute(toolName, toolInput);
  }

  // Fall back to legacy plugin registry for backward compat
  if (pluginRegistry.hasPlugin(toolName)) {
    return pluginRegistry.execute(toolName, toolInput);
  }

  switch (toolName) {
    case 'dispatch_job': {
      const { type, job, command, url, method } = toolInput as {
        type: 'agent' | 'command' | 'http';
        job?: string;
        command?: string;
        url?: string;
        method?: string;
      };

      const dispatched = await dispatcher.dispatch({
        type,
        job,
        command,
        url,
        method,
        source: 'agent',
      });

      log.info({ jobId: dispatched.jobId, type }, 'agent dispatched job, waiting for result');

      const completion = await statusTracker.waitForCompletion(dispatched.jobId);

      if (completion.status === 'completed') {
        return { result: completion.result ?? '(no output)', jobId: dispatched.jobId };
      } else if (completion.status === 'failed') {
        return { result: `Job failed: ${completion.error ?? 'unknown error'}`, jobId: dispatched.jobId };
      } else {
        return { result: `Job timed out waiting for completion`, jobId: dispatched.jobId };
      }
    }

    case 'get_job_status': {
      const { job_id } = toolInput as { job_id: string };
      const status = statusTracker.getStatus(job_id);
      if (!status) {
        return { result: `Job ${job_id} not found` };
      }
      return { result: JSON.stringify(status, null, 2) };
    }

    case 'list_jobs': {
      const { limit = 20 } = toolInput as { limit?: number };
      const jobs = statusTracker.getAllStatuses().slice(0, limit);
      if (jobs.length === 0) {
        return { result: 'No jobs found' };
      }
      return { result: JSON.stringify(jobs, null, 2) };
    }

    case 'memory_store': {
      try {
        const { content, category } = toolInput as { content: string; category?: string };
        const memory = await memoryService.store(content, category);
        return { result: `Stored memory (id: ${memory.id}, category: ${memory.category})` };
      } catch (err) {
        log.error({ err }, 'memory_store failed');
        return { result: `Failed to store memory: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'memory_search': {
      try {
        const { query, limit } = toolInput as { query: string; limit?: number };
        const results = await memoryService.search(query, limit);
        if (results.length === 0) {
          return { result: 'No relevant memories found.' };
        }
        return { result: JSON.stringify(results, null, 2) };
      } catch (err) {
        log.error({ err }, 'memory_search failed');
        return { result: `Failed to search memory: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'memory_delete': {
      try {
        const { id } = toolInput as { id: string };
        await memoryService.remove(id);
        return { result: `Deleted memory ${id}` };
      } catch (err) {
        log.error({ err }, 'memory_delete failed');
        return { result: `Failed to delete memory: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'dispatch_companion': {
      if (!companionManager) {
        return { result: 'Error: Companions not enabled' };
      }
      try {
        const { companionId, ...rest } = toolInput as { companionId: string; mode: 'agent' | 'script'; goal: string; tools?: string[]; timeout?: number };
        const taskId = await companionManager.dispatchTask(companionId, rest);
        return { result: `Task dispatched to companion "${companionId}". Task ID: ${taskId}` };
      } catch (err) {
        return { result: `Error: ${String(err)}` };
      }
    }

    default:
      break;
  }

  if (toolName === 'dispatch_task_pod') {
    if (!taskPodManager) {
      return { result: 'Error: Task pods not enabled' };
    }
    try {
      const taskId = await taskPodManager.dispatch(toolInput as unknown as TaskPodRequest);
      return { result: `Task pod dispatched. Task ID: ${taskId}. Monitor via GET /tasks/${taskId}` };
    } catch (err) {
      return { result: `Error dispatching task pod: ${String(err)}` };
    }
  }

  return { result: `Unknown tool: ${toolName}` };
}

export interface ChatOptions {
  conversationId?: string;
  channel?: string;
}

export interface ChatResult {
  response: string;
  conversationId: string;
  jobIds: string[];
  toolCallCount: number;
}

export type StreamEvent =
  | { type: 'thinking'; tool: string; input: Record<string, unknown> }
  | { type: 'delta'; text: string }
  | { type: 'tool_result'; tool: string; summary: string }
  | { type: 'done'; conversationId: string; jobIds: string[]; toolCallCount: number }
  | { type: 'error'; message: string };

export interface Agent {
  chat(message: string, opts?: ChatOptions): Promise<ChatResult>;
  chatStream(message: string, opts?: ChatOptions): AsyncGenerator<StreamEvent>;
}

export function createAgent(
  dispatcher: Dispatcher,
  statusTracker: StatusTracker,
  memoryService: MemoryService,
  pluginRegistry: PluginRegistry,
  modelRouter: ModelRouter,
  unifiedRegistry?: UnifiedToolRegistry,
  skillRegistry?: SkillRegistry,
  startTime?: number,
  brainVersion?: string,
  taskPodManager?: TaskPodManager,
  companionManager?: CompanionManager,
): Agent {
  const useOAuth = modelRouter.useOAuth;

  /** Build fresh SystemInfo for each tool call */
  function buildSystemInfo(): SystemInfo {
    return {
      version: brainVersion ?? '0.1.0',
      uptime: Date.now() - (startTime ?? Date.now()),
      skillCount: listSkills().length,
      toolCount: resolvedAllTools?.length ?? tools.length,
      scheduleCount: listSchedules().length,
    };
  }

  // allTools is resolved lazily since MCP skill tools are async
  let resolvedAllTools: ToolDefinition[] | undefined;

  // Register the cache-clearing callback so external callers can invalidate
  clearToolsCacheFn = () => {
    resolvedAllTools = undefined;
    log.info('tools cache cleared');
  };

  async function resolveAllTools(): Promise<ToolDefinition[]> {
    if (resolvedAllTools) return resolvedAllTools;

    const combined: ToolDefinition[] = [...tools];

    if (unifiedRegistry) {
      // Use unified registry (skills + legacy plugins)
      const unifiedTools = await unifiedRegistry.allToolDefinitions();
      combined.push(...(unifiedTools as ToolDefinition[]));
    } else {
      // Legacy path: plugin-only tools
      combined.push(...(pluginRegistry.allTools() as ToolDefinition[]));
    }

    resolvedAllTools = combined;
    return resolvedAllTools;
  }

  // Eagerly resolve for backward compat with plugin-only path
  const legacyAllTools: ToolDefinition[] = [
    ...tools,
    ...pluginRegistry.allTools() as ToolDefinition[],
  ];

  function resolveConversation(conversationId?: string): string {
    if (conversationId) {
      const existing = getConversation(conversationId);
      if (existing) return conversationId;
    }
    const id = conversationId ?? randomUUID();
    createConversation(id);
    initMemoryState(id);
    return id;
  }

  /** Fire-and-forget: run observer/reflector if thresholds are crossed */
  function triggerMemoryWorkers(conversationId: string, shouldObserve: boolean, shouldReflect: boolean): void {
    if (!shouldObserve && !shouldReflect) return;

    (async () => {
      if (shouldObserve && features.isEnabled('observer')) {
        await runObserver(conversationId, modelRouter);
      }
      if (shouldReflect) {
        log.info({ conversationId }, 'reflector threshold crossed — will trigger in Phase 3');
      }
    })().catch((err) =>
      log.error({ err, conversationId }, 'memory worker failed'),
    );
  }

  async function chat(message: string, opts?: ChatOptions): Promise<ChatResult> {
    const conversationId = resolveConversation(opts?.conversationId);

    const [systemPrompt, relevantMemories, allTools] = await Promise.all([
      loadSystemPrompt(skillRegistry, brainVersion),
      memoryService.search(message, 5).catch((err) => {
        log.warn({ err }, 'memory retrieval failed, continuing without');
        return [] as MemorySearchResult[];
      }),
      resolveAllTools().catch((err) => {
        log.warn({ err }, 'failed to resolve skill tools, using legacy tools');
        return legacyAllTools;
      }),
    ]);

    const ctx = buildContext(conversationId, systemPrompt, relevantMemories, {
      useOAuth,
      channel: opts?.channel,
    });
    const systemBlocks = ctx.systemBlocks as SystemBlock[];
    const messages: ChatMessage[] = ctx.messages as ChatMessage[];
    messages.push({ role: 'user', content: message });

    const jobIds: string[] = [];
    let toolCallCount = 0;
    const maxIterations = 10;

    for (let i = 0; i < maxIterations; i++) {
      const response = await withSpan('brain.llm.call', {
        'llm.role': 'agent',
        'llm.iteration': i,
      }, async () => {
        return modelRouter.chat({
          role: 'agent',
          system: systemBlocks,
          tools: allTools,
          messages,
        });
      });

      if (response.stopReason === 'end_turn') {
        const text = response.content
          .filter((block): block is ChatContentBlock & { type: 'text' } => block.type === 'text')
          .map((block) => block.text)
          .join('\n');

        addMessage(conversationId, 'user', message);
        addMessage(conversationId, 'assistant', text);
        triggerMemoryWorkers(conversationId, ctx.shouldObserve, ctx.shouldReflect);

        return { response: text, conversationId, jobIds, toolCallCount };
      }

      if (response.stopReason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });

        const toolResults: ChatContentBlock[] = [];

        for (const block of response.content) {
          if (block.type === 'tool_use') {
            toolCallCount++;
            log.info({ tool: block.name, input: block.input }, 'executing tool call');

            const { result, jobId } = await withSpan(`tool.${block.name}`, {
              'tool.name': block.name,
            }, async () => {
              return executeTool(
                block.name,
                block.input as Record<string, unknown>,
                dispatcher,
                statusTracker,
                memoryService,
                pluginRegistry,
                unifiedRegistry,
                buildSystemInfo(),
                taskPodManager,
                companionManager,
              );
            });

            if (jobId) jobIds.push(jobId);

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: sanitizeToolOutput(result),
            });
          }
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      log.warn({ stopReason: response.stopReason }, 'unexpected stop reason');
      const text = response.content
        .filter((block): block is ChatContentBlock & { type: 'text' } => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      const finalText = text || '(no response)';
      addMessage(conversationId, 'user', message);
      addMessage(conversationId, 'assistant', finalText);
      triggerMemoryWorkers(conversationId, ctx.shouldObserve, ctx.shouldReflect);

      return { response: finalText, conversationId, jobIds, toolCallCount };
    }

    const fallback = 'Reached maximum tool-use iterations. Here is what I accomplished so far.';
    addMessage(conversationId, 'user', message);
    addMessage(conversationId, 'assistant', fallback);
    triggerMemoryWorkers(conversationId, ctx.shouldObserve, ctx.shouldReflect);

    return { response: fallback, conversationId, jobIds, toolCallCount };
  }

  async function *chatStream(
    message: string,
    opts?: ChatOptions,
  ): AsyncGenerator<StreamEvent> {
    const conversationId = resolveConversation(opts?.conversationId);

    const [systemPrompt, relevantMemories, allTools] = await Promise.all([
      loadSystemPrompt(skillRegistry, brainVersion),
      memoryService.search(message, 5).catch((err) => {
        log.warn({ err }, 'memory retrieval failed, continuing without');
        return [] as MemorySearchResult[];
      }),
      resolveAllTools().catch((err) => {
        log.warn({ err }, 'failed to resolve skill tools, using legacy tools');
        return legacyAllTools;
      }),
    ]);

    const ctx = buildContext(conversationId, systemPrompt, relevantMemories, {
      useOAuth,
      channel: opts?.channel,
    });
    const systemBlocks = ctx.systemBlocks as SystemBlock[];
    const messages: ChatMessage[] = ctx.messages as ChatMessage[];
    messages.push({ role: 'user', content: message });

    const jobIds: string[] = [];
    let toolCallCount = 0;
    const maxIterations = 10;
    let fullResponseText = '';

    try {
      for (let i = 0; i < maxIterations; i++) {
        const streamGen = modelRouter.chatStream({
          role: 'agent',
          system: systemBlocks,
          tools: allTools,
          messages,
        });

        let response: import('@bakerst/shared').ChatResponse | undefined;

        for await (const event of streamGen) {
          if (event.type === 'text_delta') {
            fullResponseText += event.text;
            yield { type: 'delta', text: event.text };
          } else if (event.type === 'message_done') {
            response = event.response;
          }
        }

        if (!response) {
          throw new Error('stream ended without a message_done event');
        }

        if (response.stopReason === 'end_turn') {
          addMessage(conversationId, 'user', message);
          addMessage(conversationId, 'assistant', fullResponseText);
          triggerMemoryWorkers(conversationId, ctx.shouldObserve, ctx.shouldReflect);
          yield { type: 'done', conversationId, jobIds, toolCallCount };
          return;
        }

        if (response.stopReason === 'tool_use') {
          messages.push({ role: 'assistant', content: response.content });

          const toolResults: ChatContentBlock[] = [];

          for (const block of response.content) {
            if (block.type === 'tool_use') {
              toolCallCount++;
              yield { type: 'thinking', tool: block.name, input: block.input as Record<string, unknown> };

              const { result, jobId } = await withSpan(`tool.${block.name}`, {
                'tool.name': block.name,
              }, async () => {
                return executeTool(
                  block.name,
                  block.input as Record<string, unknown>,
                  dispatcher,
                  statusTracker,
                  memoryService,
                  pluginRegistry,
                  unifiedRegistry,
                  buildSystemInfo(),
                  taskPodManager,
                  companionManager,
                );
              });

              if (jobId) jobIds.push(jobId);
              const sanitized = sanitizeToolOutput(result);
              const summary = sanitized.length > 200 ? sanitized.slice(0, 200) + '...' : sanitized;
              yield { type: 'tool_result', tool: block.name, summary };

              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: sanitized,
              });
            }
          }

          messages.push({ role: 'user', content: toolResults });
          continue;
        }

        // Unexpected stop reason
        log.warn({ stopReason: response.stopReason }, 'unexpected stop reason');
        if (!fullResponseText) fullResponseText = '(no response)';
        addMessage(conversationId, 'user', message);
        addMessage(conversationId, 'assistant', fullResponseText);
        triggerMemoryWorkers(conversationId, ctx.shouldObserve, ctx.shouldReflect);
        yield { type: 'done', conversationId, jobIds, toolCallCount };
        return;
      }

      // Max iterations reached
      if (!fullResponseText) fullResponseText = 'Reached maximum tool-use iterations.';
      addMessage(conversationId, 'user', message);
      addMessage(conversationId, 'assistant', fullResponseText);
      triggerMemoryWorkers(conversationId, ctx.shouldObserve, ctx.shouldReflect);
      yield { type: 'done', conversationId, jobIds, toolCallCount };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'chatStream error');
      yield { type: 'error', message: errorMsg };
    }
  }

  return { chat, chatStream };
}
