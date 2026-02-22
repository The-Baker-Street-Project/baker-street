/**
 * Self-Management Tools — allows the agent to manage its own skills,
 * inspect capabilities, and search the MCP registry.
 */

import { logger, SkillTier, type SkillMetadata } from '@bakerst/shared';
import {
  listSkills,
  getSkill,
  upsertSkill,
  deleteSkill as deleteSkillDb,
  listSchedules,
} from './db.js';
import { reloadInstructionSkills } from './skill-loader.js';
import { clearSystemPromptCache } from './agent.js';

const log = logger.child({ module: 'self-management' });

/** Runtime system info passed into the tool handler */
export interface SystemInfo {
  version: string;
  uptime: number;
  skillCount: number;
  toolCount: number;
  scheduleCount: number;
}

/** Allowed tiers for agent-created skills (no sidecar) */
const AGENT_ALLOWED_TIERS = new Set<string>([
  SkillTier.Tier0,
  SkillTier.Tier1,
  SkillTier.Tier3,
]);

type ManageSkillInput = {
  action: 'create' | 'update' | 'enable' | 'disable' | 'delete';
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  tier?: string;
  transport?: string;
  config?: Record<string, unknown>;
  stdioCommand?: string;
  stdioArgs?: string[];
  httpUrl?: string;
  instructionPath?: string;
  instructionContent?: string;
};

type ListSkillsInput = {
  owner?: 'system' | 'agent' | 'all';
};

type SearchRegistryInput = {
  query: string;
};

type GetSystemInfoInput = Record<string, never>;

type ToolInput = ManageSkillInput | ListSkillsInput | SearchRegistryInput | GetSystemInfoInput;

export async function executeSelfManagementTool(
  toolName: string,
  input: ToolInput,
  systemInfo?: SystemInfo,
): Promise<{ result: string }> {
  switch (toolName) {
    case 'manage_skill':
      return handleManageSkill(input as ManageSkillInput);
    case 'list_skills':
      return handleListSkills(input as ListSkillsInput);
    case 'search_registry':
      return handleSearchRegistry(input as SearchRegistryInput);
    case 'get_system_info':
      return handleGetSystemInfo(systemInfo);
    default:
      return { result: `Unknown self-management tool: ${toolName}` };
  }
}

function handleManageSkill(input: ManageSkillInput): { result: string } {
  const { action } = input;

  switch (action) {
    case 'create': {
      if (!input.name || !input.description || !input.tier) {
        return { result: 'Error: name, description, and tier are required for create' };
      }

      const tier = input.tier as SkillTier;
      if (!AGENT_ALLOWED_TIERS.has(tier)) {
        return { result: `Error: agents cannot create ${tier} skills. Allowed tiers: instruction, stdio, service` };
      }

      const id = input.id || input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      // Check for conflict with existing system skill
      const existing = getSkill(id);
      if (existing && (existing.owner ?? 'system') === 'system') {
        return { result: `Error: skill '${id}' already exists and is system-owned. Cannot overwrite.` };
      }

      const skill: SkillMetadata = {
        id,
        name: input.name,
        description: input.description,
        version: input.version ?? '1.0.0',
        tier,
        transport: input.transport as SkillMetadata['transport'],
        enabled: true,
        config: input.config ?? {},
        stdioCommand: input.stdioCommand,
        stdioArgs: input.stdioArgs,
        httpUrl: input.httpUrl,
        instructionPath: input.instructionPath,
        instructionContent: input.instructionContent,
        owner: 'agent',
      };

      upsertSkill(skill);
      log.info({ skillId: id, tier }, 'agent created skill');

      if (tier === SkillTier.Tier0) {
        reloadInstructionSkills();
        clearSystemPromptCache();
      }

      return { result: `Skill '${id}' created successfully (owner: agent, tier: ${tier})` };
    }

    case 'update': {
      if (!input.id) {
        return { result: 'Error: id is required for update' };
      }

      const existing = getSkill(input.id);
      if (!existing) {
        return { result: `Error: skill '${input.id}' not found` };
      }
      if ((existing.owner ?? 'system') !== 'agent') {
        return { result: `Error: skill '${input.id}' is system-owned. Only agent-owned skills can be modified.` };
      }

      if (input.tier && !AGENT_ALLOWED_TIERS.has(input.tier)) {
        return { result: `Error: agents cannot use tier '${input.tier}'. Allowed tiers: instruction, stdio, service` };
      }

      const updated: SkillMetadata = {
        ...existing,
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.version !== undefined && { version: input.version }),
        ...(input.tier !== undefined && { tier: input.tier as SkillTier }),
        ...(input.transport !== undefined && { transport: input.transport as SkillMetadata['transport'] }),
        ...(input.config !== undefined && { config: input.config }),
        ...(input.stdioCommand !== undefined && { stdioCommand: input.stdioCommand }),
        ...(input.stdioArgs !== undefined && { stdioArgs: input.stdioArgs }),
        ...(input.httpUrl !== undefined && { httpUrl: input.httpUrl }),
        ...(input.instructionPath !== undefined && { instructionPath: input.instructionPath }),
        ...(input.instructionContent !== undefined && { instructionContent: input.instructionContent }),
      };

      upsertSkill(updated);
      log.info({ skillId: input.id }, 'agent updated skill');

      if (updated.tier === SkillTier.Tier0 || existing.tier === SkillTier.Tier0) {
        reloadInstructionSkills();
        clearSystemPromptCache();
      }

      return { result: `Skill '${input.id}' updated successfully` };
    }

    case 'enable':
    case 'disable': {
      if (!input.id) {
        return { result: `Error: id is required for ${action}` };
      }

      const existing = getSkill(input.id);
      if (!existing) {
        return { result: `Error: skill '${input.id}' not found` };
      }
      if ((existing.owner ?? 'system') !== 'agent') {
        return { result: `Error: skill '${input.id}' is system-owned. Only agent-owned skills can be modified.` };
      }

      const nowEnabled = action === 'enable';
      upsertSkill({ ...existing, enabled: nowEnabled });
      log.info({ skillId: input.id, enabled: nowEnabled }, `agent ${action}d skill`);

      if (existing.tier === SkillTier.Tier0) {
        reloadInstructionSkills();
        clearSystemPromptCache();
      }

      return { result: `Skill '${input.id}' ${action}d successfully` };
    }

    case 'delete': {
      if (!input.id) {
        return { result: 'Error: id is required for delete' };
      }

      const existing = getSkill(input.id);
      if (!existing) {
        return { result: `Error: skill '${input.id}' not found` };
      }
      if ((existing.owner ?? 'system') !== 'agent') {
        return { result: `Error: skill '${input.id}' is system-owned. Only agent-owned skills can be deleted.` };
      }

      deleteSkillDb(input.id);
      log.info({ skillId: input.id }, 'agent deleted skill');

      if (existing.tier === SkillTier.Tier0) {
        reloadInstructionSkills();
        clearSystemPromptCache();
      }

      return { result: `Skill '${input.id}' deleted successfully` };
    }

    default:
      return { result: `Error: unknown action '${action}'. Must be: create, update, enable, disable, delete` };
  }
}

function handleListSkills(input: ListSkillsInput): { result: string } {
  const skills = listSkills();
  const ownerFilter = input.owner ?? 'all';

  const filtered = ownerFilter === 'all'
    ? skills
    : skills.filter((s) => (s.owner ?? 'system') === ownerFilter);

  if (filtered.length === 0) {
    return { result: ownerFilter === 'all' ? 'No skills registered.' : `No ${ownerFilter}-owned skills found.` };
  }

  const tierLabel: Record<string, string> = {
    [SkillTier.Tier0]: 'Instruction',
    [SkillTier.Tier1]: 'Stdio',
    [SkillTier.Tier2]: 'Sidecar',
    [SkillTier.Tier3]: 'Service',
  };

  const lines = filtered.map((s) => {
    const owner = s.owner ?? 'system';
    const tier = tierLabel[s.tier] ?? s.tier;
    const status = s.enabled ? 'enabled' : 'disabled';
    return `- ${s.id}: ${s.name} [${owner}] (${tier}, ${status})`;
  });

  return { result: lines.join('\n') };
}

async function handleSearchRegistry(input: SearchRegistryInput): Promise<{ result: string }> {
  const { query } = input;

  if (!query || query.trim().length < 2) {
    return { result: 'Error: search query must be at least 2 characters' };
  }

  try {
    const registryUrl = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
    registryUrl.searchParams.set('search', query.trim());
    registryUrl.searchParams.set('version', 'latest');
    registryUrl.searchParams.set('limit', '10');

    const response = await fetch(registryUrl.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return { result: `Registry returned HTTP ${response.status}` };
    }

    const data = (await response.json()) as { servers?: Array<{ name?: string; description?: string; url?: string }> };

    if (!data.servers || data.servers.length === 0) {
      return { result: `No MCP servers found for query: ${query}` };
    }

    const lines = data.servers.map((s) =>
      `- ${s.name ?? 'unknown'}: ${s.description ?? 'no description'} (${s.url ?? 'no url'})`,
    );

    return { result: `Found ${data.servers.length} MCP servers:\n${lines.join('\n')}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'MCP registry search failed');
    return { result: `Registry search failed: ${msg}` };
  }
}

function handleGetSystemInfo(systemInfo?: SystemInfo): { result: string } {
  if (!systemInfo) {
    return { result: 'System info not available' };
  }

  const uptimeSeconds = Math.floor(systemInfo.uptime / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  const info = [
    `Version: ${systemInfo.version}`,
    `Uptime: ${hours}h ${minutes}m`,
    `Skills: ${systemInfo.skillCount}`,
    `MCP Tools: ${systemInfo.toolCount}`,
    `Scheduled Tasks: ${systemInfo.scheduleCount}`,
  ];

  return { result: info.join('\n') };
}
