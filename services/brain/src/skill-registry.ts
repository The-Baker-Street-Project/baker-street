/**
 * Skill Registry — central registry for all MCP skills.
 *
 * Manages the mapping of tool names to skills, delegates tool calls to the
 * appropriate MCP client, and provides a unified interface for the agent.
 */

import { readFile } from 'node:fs/promises';
import {
  logger,
  SkillTier,
  type SkillMetadata,
  type SkillToolDefinition,
} from '@bakerst/shared';
import { McpClientManager } from './mcp-client.js';
import { getEnabledSkills, upsertSkill, listSkills } from './db.js';

const log = logger.child({ module: 'skill-registry' });

/** Anthropic tool names must match ^[a-zA-Z0-9_-]{1,128}$ — sanitize MCP names */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

export class SkillRegistry {
  /** Maps sanitized tool name -> skill ID for routing */
  private toolToSkillId = new Map<string, string>();
  /** Maps sanitized tool name -> original MCP tool name for callTool */
  private sanitizedToOriginal = new Map<string, string>();
  /** All loaded skill metadata keyed by ID */
  private skills = new Map<string, SkillMetadata>();
  /** Cached tool definitions from MCP servers */
  private toolCache = new Map<string, SkillToolDefinition[]>();

  constructor(private mcpClient: McpClientManager) {}

  /**
   * Load enabled skills from the database and connect to MCP servers.
   * This is called at startup.
   */
  async loadFromDatabase(): Promise<void> {
    const enabledSkills = getEnabledSkills();

    for (const skill of enabledSkills) {
      this.skills.set(skill.id, skill);

      // Only connect to Tier 1-3 skills (Tier 0 is loaded separately as instructions)
      if (skill.tier === SkillTier.Tier0) continue;

      try {
        await this.connectSkill(skill);
      } catch (err) {
        log.error({ err, skillId: skill.id }, 'failed to connect skill at startup, skipping');
      }
    }

    log.info(
      { skillCount: this.skills.size, toolCount: this.toolToSkillId.size },
      'skill registry loaded from database',
    );
  }

  /**
   * Connect to an MCP server for a skill and discover its tools.
   */
  private async connectSkill(skill: SkillMetadata): Promise<void> {
    if (skill.tier === SkillTier.Tier1) {
      // Stdio transport
      if (!skill.stdioCommand) {
        log.warn({ skillId: skill.id }, 'Tier 1 skill missing stdioCommand, skipping');
        return;
      }

      const command = skill.stdioCommand;
      const args = skill.stdioArgs ?? [];
      const env = skill.config.env as Record<string, string> | undefined;

      await this.mcpClient.connectStdio(skill.id, command, args, env);
    } else if (skill.tier === SkillTier.Tier2 || skill.tier === SkillTier.Tier3) {
      // HTTP transport
      if (!skill.httpUrl) {
        log.warn({ skillId: skill.id }, `${skill.tier} skill missing httpUrl, skipping`);
        return;
      }

      const headers = skill.config.headers as Record<string, string> | undefined;
      await this.mcpClient.connectHttp(
        skill.id,
        skill.httpUrl,
        skill.transport ?? 'streamable-http',
        headers,
      );
    }

    // Discover tools from the MCP server
    await this.discoverTools(skill.id);
  }

  /**
   * Discover tools from a connected MCP server and register them.
   */
  private async discoverTools(skillId: string): Promise<void> {
    try {
      // Clear any existing tool mappings for this skill before (re-)registering
      for (const [toolName, sid] of this.toolToSkillId) {
        if (sid === skillId) {
          this.toolToSkillId.delete(toolName);
          this.sanitizedToOriginal.delete(toolName);
        }
      }

      const mcpTools = await this.mcpClient.listTools(skillId);

      const cached: SkillToolDefinition[] = [];
      for (const tool of mcpTools) {
        const safeName = sanitizeToolName(tool.name);

        if (this.toolToSkillId.has(safeName)) {
          const existingSkillId = this.toolToSkillId.get(safeName)!;
          log.warn(
            { tool: tool.name, safeName, skillId, existingSkillId },
            'tool name conflict across skills, skipping duplicate',
          );
          continue;
        }

        this.toolToSkillId.set(safeName, skillId);
        if (safeName !== tool.name) {
          this.sanitizedToOriginal.set(safeName, tool.name);
        }
        cached.push({
          name: safeName,
          description: tool.description,
          input_schema: tool.inputSchema,
          skillId,
        });
      }

      this.toolCache.set(skillId, cached);

      log.info(
        { skillId, toolCount: mcpTools.length, tools: mcpTools.map((t) => t.name) },
        'discovered tools from MCP server',
      );
    } catch (err) {
      log.error({ err, skillId }, 'failed to discover tools from MCP server');
    }
  }

  /**
   * Get all MCP tools as Anthropic-compatible tool definitions.
   * Returns tool definitions from all connected MCP servers.
   */
  async getAllTools(): Promise<SkillToolDefinition[]> {
    const tools: SkillToolDefinition[] = [];

    for (const [skillId, skill] of this.skills) {
      if (skill.tier === SkillTier.Tier0) continue; // Tier 0 doesn't have tools
      if (!this.mcpClient.isConnected(skillId)) continue;

      const cached = this.toolCache.get(skillId);
      if (cached) {
        tools.push(...cached);
      } else {
        // Fallback: query MCP server and populate cache
        try {
          await this.discoverTools(skillId);
          const freshCached = this.toolCache.get(skillId);
          if (freshCached) tools.push(...freshCached);
        } catch (err) {
          log.warn({ err, skillId }, 'failed to list tools from skill');
        }
      }
    }

    return tools;
  }

  /**
   * Check if a tool is owned by a skill in this registry.
   */
  hasTool(toolName: string): boolean {
    return this.toolToSkillId.has(toolName);
  }

  /**
   * Execute a tool via the appropriate MCP client.
   */
  async execute(toolName: string, input: Record<string, unknown>): Promise<{ result: string }> {
    const skillId = this.toolToSkillId.get(toolName);
    if (!skillId) {
      return { result: `No skill registered for tool: ${toolName}` };
    }

    // Map sanitized name back to original MCP tool name
    const mcpToolName = this.sanitizedToOriginal.get(toolName) ?? toolName;

    try {
      const mcpResult = await this.mcpClient.callTool(skillId, mcpToolName, input);

      // Extract text content from MCP result
      const texts = mcpResult.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);

      const resultText = texts.join('\n') || '(no output)';

      if (mcpResult.isError) {
        return { result: `Tool error: ${resultText}` };
      }

      return { result: resultText };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, toolName, skillId }, 'skill tool execution failed');
      return { result: `Skill tool execution failed: ${errMsg}` };
    }
  }

  /**
   * Migrate existing PLUGINS.json entries to the skills database.
   * This is a one-time migration helper for backward compatibility.
   */
  async migrateFromPluginsJson(configPath: string): Promise<number> {
    let configs: Array<{ package: string; enabled: boolean; config: Record<string, unknown> }>;

    try {
      const raw = await readFile(configPath, 'utf-8');
      configs = JSON.parse(raw);
    } catch {
      log.info({ configPath }, 'no PLUGINS.json found for migration');
      return 0;
    }

    if (!Array.isArray(configs)) return 0;

    // Check if skills already exist — skip migration if so
    const existingSkills = listSkills();
    if (existingSkills.length > 0) {
      log.info({ existingCount: existingSkills.length }, 'skills already exist, skipping PLUGINS.json migration');
      return 0;
    }

    let migrated = 0;
    for (const cfg of configs) {
      // Derive skill ID from package name (e.g. "@bakerst/plugin-example" -> "plugin-example")
      const id = cfg.package.replace(/^@[^/]+\//, '');
      const skill: SkillMetadata = {
        id,
        name: id,
        version: '0.1.0',
        description: `Migrated from PLUGINS.json: ${cfg.package}`,
        tier: SkillTier.Tier0,
        enabled: cfg.enabled,
        config: { ...cfg.config, legacyPlugin: true, package: cfg.package },
      };

      upsertSkill(skill);
      migrated++;
      log.info({ skillId: id, package: cfg.package }, 'migrated plugin to skill');
    }

    log.info({ migrated }, 'PLUGINS.json migration complete');
    return migrated;
  }

  /**
   * Connect a skill and register its tools. Used by the Skills API
   * for enabling skills and testing connections.
   */
  async connectAndRegister(skill: SkillMetadata): Promise<void> {
    this.skills.set(skill.id, skill);
    await this.connectSkill(skill);
  }

  /**
   * Disconnect a skill and unregister its tools.
   */
  async disconnectSkill(skillId: string): Promise<void> {
    // Remove tool mappings for this skill
    for (const [toolName, sid] of this.toolToSkillId) {
      if (sid === skillId) {
        this.toolToSkillId.delete(toolName);
        this.sanitizedToOriginal.delete(toolName);
      }
    }
    // Clear cached tool definitions
    this.toolCache.delete(skillId);
    // Close MCP connection
    await this.mcpClient.close(skillId);
    this.skills.delete(skillId);
    log.info({ skillId }, 'skill disconnected and unregistered');
  }

  /**
   * Build a human-readable summary of all loaded skills, grouped by owner.
   * Includes tier labels and tool counts for each skill.
   */
  getCapabilitiesSummary(): string {
    const allSkills = listSkills();
    if (allSkills.length === 0) {
      return 'No skills registered.';
    }

    const tierLabel: Record<string, string> = {
      [SkillTier.Tier0]: 'Instruction',
      [SkillTier.Tier1]: 'Stdio',
      [SkillTier.Tier2]: 'Sidecar',
      [SkillTier.Tier3]: 'Service',
    };

    const systemSkills = allSkills.filter((s) => (s.owner ?? 'system') === 'system');
    const agentSkills = allSkills.filter((s) => s.owner === 'agent');
    const extensionSkills = allSkills.filter((s) => s.owner === 'extension');

    const lines: string[] = [];

    const formatSkill = (skill: SkillMetadata): string => {
      const status = skill.enabled ? 'enabled' : 'disabled';
      const tier = tierLabel[skill.tier] ?? skill.tier;
      const toolCount = this.toolCache.get(skill.id)?.length ?? 0;
      const toolInfo = skill.tier === SkillTier.Tier0 ? '' : `, ${toolCount} tools`;
      return `  - ${skill.name} (${tier}, ${status}${toolInfo})`;
    };

    if (systemSkills.length > 0) {
      lines.push('System Skills:');
      for (const s of systemSkills) lines.push(formatSkill(s));
    }

    if (agentSkills.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Agent-Installed Skills:');
      for (const s of agentSkills) lines.push(formatSkill(s));
    }

    if (extensionSkills.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Extension Skills:');
      for (const s of extensionSkills) lines.push(formatSkill(s));
    }

    lines.push('');
    lines.push(`Total: ${allSkills.length} skills, ${this.toolToSkillId.size} MCP tools`);

    return lines.join('\n');
  }

  /**
   * Gracefully shut down all MCP client connections.
   */
  async shutdown(): Promise<void> {
    await this.mcpClient.closeAll();
    this.toolToSkillId.clear();
    this.sanitizedToOriginal.clear();
    this.toolCache.clear();
    this.skills.clear();
    log.info('skill registry shut down');
  }
}
