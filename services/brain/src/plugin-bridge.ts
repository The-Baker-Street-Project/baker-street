/**
 * Plugin Bridge — wraps the existing PluginRegistry to expose a skill-compatible interface.
 *
 * This allows the agent to route tool calls through a unified interface,
 * checking the SkillRegistry first and falling back to the legacy PluginRegistry.
 */

import { logger, type PluginToolDefinition, type ToolResult } from '@bakerst/shared';
import type { PluginRegistry } from './plugin-registry.js';
import type { SkillRegistry } from './skill-registry.js';

const log = logger.child({ module: 'plugin-bridge' });

export interface UnifiedToolRegistry {
  /** Get all tool definitions (from both skills and legacy plugins) */
  allToolDefinitions(): Promise<PluginToolDefinition[]>;
  /** Check if any registry owns this tool */
  hasTool(toolName: string): boolean;
  /** Execute a tool, routing to the correct registry */
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;
  /** Shut down both registries */
  shutdown(): Promise<void>;
}

/**
 * Create a unified tool registry that bridges skills and legacy plugins.
 *
 * Tool resolution order:
 * 1. SkillRegistry (MCP-based skills)
 * 2. PluginRegistry (legacy BakerstPlugin-based plugins)
 */
export function createUnifiedToolRegistry(
  skillRegistry: SkillRegistry | undefined,
  pluginRegistry: PluginRegistry,
): UnifiedToolRegistry {
  return {
    async allToolDefinitions(): Promise<PluginToolDefinition[]> {
      const skillTools = skillRegistry ? await skillRegistry.getAllTools() : [];
      const pluginTools = pluginRegistry.allTools();

      // Combine, with skill tools taking precedence for name conflicts
      const seen = new Set<string>();
      const combined: PluginToolDefinition[] = [];

      for (const tool of skillTools) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          combined.push({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
          });
        }
      }

      for (const tool of pluginTools) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          combined.push(tool);
        } else {
          log.info(
            { tool: tool.name },
            'plugin tool shadowed by skill tool with same name',
          );
        }
      }

      return combined;
    },

    hasTool(toolName: string): boolean {
      return (skillRegistry?.hasTool(toolName) ?? false) || pluginRegistry.hasPlugin(toolName);
    },

    async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
      // Skills take priority
      if (skillRegistry?.hasTool(toolName)) {
        return skillRegistry.execute(toolName, input);
      }

      // Fall back to legacy plugin
      if (pluginRegistry.hasPlugin(toolName)) {
        return pluginRegistry.execute(toolName, input);
      }

      return { result: `No skill or plugin registered for tool: ${toolName}` };
    },

    async shutdown(): Promise<void> {
      await Promise.allSettled([
        skillRegistry?.shutdown(),
        pluginRegistry.shutdown(),
      ].filter(Boolean) as Promise<void>[]);
      log.info('unified tool registry shut down');
    },
  };
}
