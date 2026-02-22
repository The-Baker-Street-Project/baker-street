import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillTier, type SkillMetadata } from '@bakerst/shared';

// ---------------------------------------------------------------------------
// Hoisted mock functions (must be hoisted for vi.mock factories)
// ---------------------------------------------------------------------------

const {
  mockGetEnabledSkills,
  mockUpsertSkill,
  mockListSkills,
  mockGetDb,
  mockConnectStdio,
  mockConnectHttp,
  mockListTools,
  mockCallTool,
  mockIsConnected,
  mockClose,
  mockCloseAll,
  mockReadFile,
} = vi.hoisted(() => ({
  mockGetEnabledSkills: vi.fn().mockReturnValue([]),
  mockUpsertSkill: vi.fn(),
  mockListSkills: vi.fn().mockReturnValue([]),
  mockGetDb: vi.fn(),
  mockConnectStdio: vi.fn().mockResolvedValue(undefined),
  mockConnectHttp: vi.fn().mockResolvedValue(undefined),
  mockListTools: vi.fn().mockResolvedValue([]),
  mockCallTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] }),
  mockIsConnected: vi.fn().mockReturnValue(false),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockCloseAll: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock db.js
// ---------------------------------------------------------------------------

vi.mock('../db.js', () => ({
  getEnabledSkills: (...args: unknown[]) => mockGetEnabledSkills(...args),
  upsertSkill: (...args: unknown[]) => mockUpsertSkill(...args),
  listSkills: (...args: unknown[]) => mockListSkills(...args),
  getDb: (...args: unknown[]) => mockGetDb(...args),
}));

// ---------------------------------------------------------------------------
// Mock mcp-client.js
// ---------------------------------------------------------------------------

vi.mock('../mcp-client.js', () => ({
  McpClientManager: vi.fn().mockImplementation(() => ({
    connectStdio: mockConnectStdio,
    connectHttp: mockConnectHttp,
    listTools: mockListTools,
    callTool: mockCallTool,
    isConnected: mockIsConnected,
    close: mockClose,
    closeAll: mockCloseAll,
  })),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises (for migrateFromPluginsJson)
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { SkillRegistry } from '../skill-registry.js';
import { McpClientManager } from '../mcp-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(overrides?: Partial<SkillMetadata>): SkillMetadata {
  return {
    id: 'skill-1',
    name: 'Skill One',
    version: '1.0.0',
    description: 'Test skill',
    tier: SkillTier.Tier1,
    transport: 'stdio',
    enabled: true,
    config: {},
    stdioCommand: 'node',
    stdioArgs: ['server.js'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    const mcpClient = new McpClientManager();
    registry = new SkillRegistry(mcpClient);
  });

  describe('loadFromDatabase()', () => {
    it('loads enabled skills', async () => {
      const skill = makeSkill();
      mockGetEnabledSkills.mockReturnValue([skill]);
      mockListTools.mockResolvedValue([{ name: 'tool-a', description: 'A', inputSchema: { type: 'object' } }]);

      await registry.loadFromDatabase();
      expect(mockGetEnabledSkills).toHaveBeenCalled();
      expect(mockConnectStdio).toHaveBeenCalledWith('skill-1', 'node', ['server.js'], undefined);
    });

    it('skips Tier 0 skills (no MCP connection)', async () => {
      const skill = makeSkill({ tier: SkillTier.Tier0, id: 'tier0' });
      mockGetEnabledSkills.mockReturnValue([skill]);

      await registry.loadFromDatabase();
      expect(mockConnectStdio).not.toHaveBeenCalled();
      expect(mockConnectHttp).not.toHaveBeenCalled();
    });

    it('connects Tier 1 skills via stdio', async () => {
      const skill = makeSkill({ tier: SkillTier.Tier1 });
      mockGetEnabledSkills.mockReturnValue([skill]);
      mockListTools.mockResolvedValue([]);

      await registry.loadFromDatabase();
      expect(mockConnectStdio).toHaveBeenCalledWith('skill-1', 'node', ['server.js'], undefined);
    });

    it('connects Tier 2/3 skills via HTTP', async () => {
      const tier2 = makeSkill({
        id: 'sidecar-skill',
        tier: SkillTier.Tier2,
        httpUrl: 'http://localhost:3001',
        transport: 'streamable-http',
      });
      mockGetEnabledSkills.mockReturnValue([tier2]);
      mockListTools.mockResolvedValue([]);

      await registry.loadFromDatabase();
      expect(mockConnectHttp).toHaveBeenCalledWith('sidecar-skill', 'http://localhost:3001', 'streamable-http');
    });

    it('continues on connection failure', async () => {
      const skill1 = makeSkill({ id: 'fail-skill' });
      const skill2 = makeSkill({ id: 'ok-skill', stdioCommand: 'python3', stdioArgs: ['server.py'] });
      mockGetEnabledSkills.mockReturnValue([skill1, skill2]);
      mockConnectStdio
        .mockRejectedValueOnce(new Error('connection failed'))
        .mockResolvedValueOnce(undefined);
      mockListTools.mockResolvedValue([]);

      await registry.loadFromDatabase();
      // Should have attempted both connections
      expect(mockConnectStdio).toHaveBeenCalledTimes(2);
    });
  });

  describe('getAllTools()', () => {
    it('returns tools from connected skills', async () => {
      const skill = makeSkill();
      mockGetEnabledSkills.mockReturnValue([skill]);
      mockListTools.mockResolvedValue([
        { name: 'tool-a', description: 'Tool A', inputSchema: { type: 'object' } },
      ]);
      mockIsConnected.mockReturnValue(true);

      await registry.loadFromDatabase();
      const tools = await registry.getAllTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('tool-a');
      expect(tools[0].skillId).toBe('skill-1');
    });

    it('skips disconnected skills', async () => {
      const skill = makeSkill();
      mockGetEnabledSkills.mockReturnValue([skill]);
      mockListTools.mockResolvedValue([
        { name: 'tool-a', description: 'Tool A', inputSchema: { type: 'object' } },
      ]);
      mockIsConnected.mockReturnValue(false);

      await registry.loadFromDatabase();
      const tools = await registry.getAllTools();
      expect(tools).toHaveLength(0);
    });
  });

  describe('hasTool()', () => {
    it('returns true for registered tool', async () => {
      const skill = makeSkill();
      mockGetEnabledSkills.mockReturnValue([skill]);
      mockListTools.mockResolvedValue([
        { name: 'tool-x', description: 'X', inputSchema: { type: 'object' } },
      ]);

      await registry.loadFromDatabase();
      expect(registry.hasTool('tool-x')).toBe(true);
    });

    it('returns false for unknown tool', () => {
      expect(registry.hasTool('nonexistent')).toBe(false);
    });
  });

  describe('execute()', () => {
    it('routes to correct MCP client', async () => {
      const skill = makeSkill();
      mockGetEnabledSkills.mockReturnValue([skill]);
      mockListTools.mockResolvedValue([
        { name: 'tool-a', description: 'A', inputSchema: { type: 'object' } },
      ]);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'executed!' }],
      });

      await registry.loadFromDatabase();
      const result = await registry.execute('tool-a', { input: 'test' });
      expect(result.result).toBe('executed!');
      expect(mockCallTool).toHaveBeenCalledWith('skill-1', 'tool-a', { input: 'test' });
    });

    it('returns error for unregistered tool', async () => {
      const result = await registry.execute('unknown-tool', {});
      expect(result.result).toContain('No skill registered for tool');
    });
  });

  describe('migrateFromPluginsJson()', () => {
    it('migrates entries to skills DB', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([
        { package: '@bakerst/plugin-example', enabled: true, config: { foo: 'bar' } },
        { package: '@bakerst/plugin-browser', enabled: false, config: {} },
      ]));
      mockListSkills.mockReturnValue([]);

      const count = await registry.migrateFromPluginsJson('/etc/bakerst/PLUGINS.json');
      expect(count).toBe(2);
      expect(mockUpsertSkill).toHaveBeenCalledTimes(2);

      // Check first call
      const firstCall = mockUpsertSkill.mock.calls[0][0] as SkillMetadata;
      expect(firstCall.id).toBe('plugin-example');
      expect(firstCall.tier).toBe(SkillTier.Tier0);
      expect(firstCall.enabled).toBe(true);
    });
  });

  describe('getCapabilitiesSummary()', () => {
    it('returns "No skills registered." when no skills exist', () => {
      mockListSkills.mockReturnValue([]);
      const summary = registry.getCapabilitiesSummary();
      expect(summary).toBe('No skills registered.');
    });

    it('groups skills by owner with tier labels and tool counts', async () => {
      const systemSkill = makeSkill({
        id: 'sys-skill',
        name: 'System Skill',
        tier: SkillTier.Tier1,
        owner: 'system',
      });
      const agentSkill = makeSkill({
        id: 'agent-skill',
        name: 'Agent Skill',
        tier: SkillTier.Tier0,
        owner: 'agent',
        enabled: false,
      });
      mockListSkills.mockReturnValue([systemSkill, agentSkill]);

      // Load the system skill with some tools
      mockGetEnabledSkills.mockReturnValue([systemSkill]);
      mockListTools.mockResolvedValue([
        { name: 'tool-a', description: 'A', inputSchema: { type: 'object' } },
        { name: 'tool-b', description: 'B', inputSchema: { type: 'object' } },
      ]);
      await registry.loadFromDatabase();

      const summary = registry.getCapabilitiesSummary();
      expect(summary).toContain('System Skills:');
      expect(summary).toContain('System Skill (Stdio, enabled, 2 tools)');
      expect(summary).toContain('Agent-Installed Skills:');
      expect(summary).toContain('Agent Skill (Instruction, disabled)');
      expect(summary).toContain('Total: 2 skills, 2 MCP tools');
    });

    it('defaults to system owner when owner is undefined', () => {
      const skill = makeSkill({ id: 'no-owner', name: 'No Owner' });
      // owner is undefined (not explicitly set)
      skill.owner = undefined;
      mockListSkills.mockReturnValue([skill]);

      const summary = registry.getCapabilitiesSummary();
      expect(summary).toContain('System Skills:');
      expect(summary).toContain('No Owner');
    });
  });

  describe('shutdown()', () => {
    it('closes all MCP clients and clears maps', async () => {
      const skill = makeSkill();
      mockGetEnabledSkills.mockReturnValue([skill]);
      mockListTools.mockResolvedValue([
        { name: 'tool-a', description: 'A', inputSchema: { type: 'object' } },
      ]);

      await registry.loadFromDatabase();
      expect(registry.hasTool('tool-a')).toBe(true);

      await registry.shutdown();
      expect(mockCloseAll).toHaveBeenCalled();
      expect(registry.hasTool('tool-a')).toBe(false);
    });
  });
});
