import { readFile } from 'node:fs/promises';
import {
  logger,
  type BakerstPlugin,
  type PluginContext,
  type PluginToolDefinition,
  type ToolResult,
  type TriggerEvent,
} from '@bakerst/shared';
import type { Dispatcher } from './dispatcher.js';
import type { StatusTracker } from './status-tracker.js';
import type { MemoryService } from './memory.js';

const log = logger.child({ module: 'plugin-registry' });

interface PluginConfig {
  package: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface PluginRegistry {
  allTools(): PluginToolDefinition[];
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;
  hasPlugin(toolName: string): boolean;
  handleTrigger(pluginName: string, event: TriggerEvent): Promise<string | null>;
  shutdown(): Promise<void>;
}

interface PluginRegistryDeps {
  dispatcher: Dispatcher;
  statusTracker: StatusTracker;
  memoryService: MemoryService;
}

export async function loadPlugins(deps: PluginRegistryDeps): Promise<PluginRegistry> {
  const plugins: BakerstPlugin[] = [];
  const toolToPlugin = new Map<string, BakerstPlugin>();
  const nameToPlugin = new Map<string, BakerstPlugin>();

  const configPath = process.env.PLUGINS_PATH ?? '/etc/bakerst/PLUGINS.json';
  let configs: PluginConfig[] = [];

  try {
    const raw = await readFile(configPath, 'utf-8');
    configs = JSON.parse(raw);
  } catch (err) {
    log.warn({ err, configPath }, 'could not load PLUGINS.json, starting with no plugins');
    return createRegistry(plugins, toolToPlugin, nameToPlugin);
  }

  if (!Array.isArray(configs) || configs.length === 0) {
    log.info('no plugins configured');
    return createRegistry(plugins, toolToPlugin, nameToPlugin);
  }

  for (const cfg of configs) {
    if (!cfg.enabled) {
      log.info({ package: cfg.package }, 'plugin disabled, skipping');
      continue;
    }

    try {
      log.info({ package: cfg.package }, 'loading plugin');
      const mod = await import(cfg.package);
      const plugin: BakerstPlugin = mod.default ?? mod;

      const context: PluginContext = {
        dispatcher: deps.dispatcher,
        statusTracker: deps.statusTracker,
        memoryService: deps.memoryService,
        logger: log.child({ plugin: plugin.name }),
        config: cfg.config ?? {},
      };

      await plugin.init(context);

      // Register tool → plugin routing
      for (const tool of plugin.tools) {
        if (toolToPlugin.has(tool.name)) {
          log.warn(
            { tool: tool.name, plugin: plugin.name },
            'tool name conflict, skipping duplicate',
          );
          continue;
        }
        toolToPlugin.set(tool.name, plugin);
      }

      nameToPlugin.set(plugin.name, plugin);
      plugins.push(plugin);
      log.info(
        { plugin: plugin.name, version: plugin.version, tools: plugin.tools.map((t) => t.name) },
        'plugin loaded',
      );
    } catch (err) {
      log.error({ err, package: cfg.package }, 'failed to load plugin');
    }
  }

  log.info({ pluginCount: plugins.length, toolCount: toolToPlugin.size }, 'plugin loading complete');
  return createRegistry(plugins, toolToPlugin, nameToPlugin);
}

function createRegistry(
  plugins: BakerstPlugin[],
  toolToPlugin: Map<string, BakerstPlugin>,
  nameToPlugin: Map<string, BakerstPlugin>,
): PluginRegistry {
  return {
    allTools(): PluginToolDefinition[] {
      const tools: PluginToolDefinition[] = [];
      for (const plugin of plugins) {
        tools.push(...plugin.tools);
      }
      return tools;
    },

    hasPlugin(toolName: string): boolean {
      return toolToPlugin.has(toolName);
    },

    async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
      const plugin = toolToPlugin.get(toolName);
      if (!plugin) {
        return { result: `No plugin registered for tool: ${toolName}` };
      }
      return plugin.execute(toolName, input);
    },

    async handleTrigger(pluginName: string, event: TriggerEvent): Promise<string | null> {
      const plugin = nameToPlugin.get(pluginName);
      if (!plugin?.onTrigger) {
        return null;
      }
      return plugin.onTrigger(event);
    },

    async shutdown(): Promise<void> {
      for (const plugin of plugins) {
        try {
          await plugin.shutdown();
          log.info({ plugin: plugin.name }, 'plugin shut down');
        } catch (err) {
          log.error({ err, plugin: plugin.name }, 'plugin shutdown error');
        }
      }
    },
  };
}
