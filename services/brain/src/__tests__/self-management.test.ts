import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillTier } from '@bakerst/shared';
import type { SkillMetadata } from '@bakerst/shared';

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------

const {
  mockListSkills,
  mockGetSkill,
  mockUpsertSkill,
  mockDeleteSkill,
  mockListSchedules,
  mockReloadInstructionSkills,
  mockClearSystemPromptCache,
} = vi.hoisted(() => ({
  mockListSkills: vi.fn().mockReturnValue([]),
  mockGetSkill: vi.fn(),
  mockUpsertSkill: vi.fn(),
  mockDeleteSkill: vi.fn().mockReturnValue(true),
  mockListSchedules: vi.fn().mockReturnValue([]),
  mockReloadInstructionSkills: vi.fn(),
  mockClearSystemPromptCache: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../db.js', () => ({
  listSkills: mockListSkills,
  getSkill: mockGetSkill,
  upsertSkill: mockUpsertSkill,
  deleteSkill: mockDeleteSkill,
  listSchedules: mockListSchedules,
}));

vi.mock('../skill-loader.js', () => ({
  reloadInstructionSkills: mockReloadInstructionSkills,
}));

vi.mock('../agent.js', () => ({
  clearSystemPromptCache: mockClearSystemPromptCache,
}));

vi.mock('@bakerst/shared', async () => {
  const actual = await vi.importActual<typeof import('@bakerst/shared')>('@bakerst/shared');
  return {
    ...actual,
    logger: {
      child: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    },
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { executeSelfManagementTool, type SystemInfo } from '../self-management.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(overrides?: Partial<SkillMetadata>): SkillMetadata {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    version: '1.0.0',
    description: 'A test skill',
    tier: SkillTier.Tier1,
    transport: 'stdio',
    enabled: true,
    config: {},
    owner: 'agent',
    ...overrides,
  };
}

const defaultSystemInfo: SystemInfo = {
  version: '0.1.0',
  uptime: 3_661_000, // 1h 1m 1s
  skillCount: 3,
  toolCount: 10,
  scheduleCount: 2,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeSelfManagementTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('manage_skill — create', () => {
    it('creates an agent-owned skill', async () => {
      mockGetSkill.mockReturnValue(undefined);

      const result = await executeSelfManagementTool('manage_skill', {
        action: 'create',
        name: 'My Notes',
        description: 'Personal notes',
        tier: 'instruction',
      });

      expect(result.result).toContain("'my-notes' created successfully");
      expect(result.result).toContain('owner: agent');
      expect(mockUpsertSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'my-notes',
          name: 'My Notes',
          owner: 'agent',
          tier: 'instruction',
        }),
      );
    });

    it('rejects missing required fields', async () => {
      const result = await executeSelfManagementTool('manage_skill', {
        action: 'create',
        name: 'No Tier',
        description: 'Missing tier',
      } as any);

      expect(result.result).toContain('Error');
      expect(mockUpsertSkill).not.toHaveBeenCalled();
    });

    it('rejects Tier 2 (sidecar) creation', async () => {
      const result = await executeSelfManagementTool('manage_skill', {
        action: 'create',
        name: 'Sidecar',
        description: 'Bad tier',
        tier: 'sidecar',
      });

      expect(result.result).toContain('cannot create sidecar');
      expect(mockUpsertSkill).not.toHaveBeenCalled();
    });

    it('prevents overwriting system-owned skills', async () => {
      mockGetSkill.mockReturnValue(makeSkill({ id: 'existing', owner: 'system' }));

      const result = await executeSelfManagementTool('manage_skill', {
        action: 'create',
        id: 'existing',
        name: 'Existing',
        description: 'Try overwrite',
        tier: 'instruction',
      });

      expect(result.result).toContain('system-owned');
      expect(mockUpsertSkill).not.toHaveBeenCalled();
    });

    it('reloads instruction caches on Tier 0 create', async () => {
      mockGetSkill.mockReturnValue(undefined);

      await executeSelfManagementTool('manage_skill', {
        action: 'create',
        name: 'Instruction Skill',
        description: 'Tier 0',
        tier: 'instruction',
      });

      expect(mockReloadInstructionSkills).toHaveBeenCalled();
      expect(mockClearSystemPromptCache).toHaveBeenCalled();
    });

    it('does NOT reload instruction caches on non-Tier 0 create', async () => {
      mockGetSkill.mockReturnValue(undefined);

      await executeSelfManagementTool('manage_skill', {
        action: 'create',
        name: 'Stdio Skill',
        description: 'Tier 1',
        tier: 'stdio',
        stdioCommand: 'node',
        stdioArgs: ['server.js'],
      });

      expect(mockReloadInstructionSkills).not.toHaveBeenCalled();
      expect(mockClearSystemPromptCache).not.toHaveBeenCalled();
    });
  });

  describe('manage_skill — update', () => {
    it('updates an agent-owned skill', async () => {
      mockGetSkill.mockReturnValue(makeSkill({ id: 'my-skill', owner: 'agent' }));

      const result = await executeSelfManagementTool('manage_skill', {
        action: 'update',
        id: 'my-skill',
        description: 'Updated description',
      });

      expect(result.result).toContain("'my-skill' updated successfully");
      expect(mockUpsertSkill).toHaveBeenCalled();
    });

    it('rejects updating system-owned skill', async () => {
      mockGetSkill.mockReturnValue(makeSkill({ id: 'sys-skill', owner: 'system' }));

      const result = await executeSelfManagementTool('manage_skill', {
        action: 'update',
        id: 'sys-skill',
        description: 'Try update',
      });

      expect(result.result).toContain('system-owned');
      expect(mockUpsertSkill).not.toHaveBeenCalled();
    });

    it('rejects updating to sidecar tier', async () => {
      mockGetSkill.mockReturnValue(makeSkill({ id: 'my-skill', owner: 'agent' }));

      const result = await executeSelfManagementTool('manage_skill', {
        action: 'update',
        id: 'my-skill',
        tier: 'sidecar',
      });

      expect(result.result).toContain('cannot use tier');
      expect(mockUpsertSkill).not.toHaveBeenCalled();
    });
  });

  describe('manage_skill — enable/disable', () => {
    it('enables an agent-owned skill', async () => {
      mockGetSkill.mockReturnValue(makeSkill({ id: 'my-skill', owner: 'agent', enabled: false }));

      const result = await executeSelfManagementTool('manage_skill', {
        action: 'enable',
        id: 'my-skill',
      });

      expect(result.result).toContain('enabled successfully');
      expect(mockUpsertSkill).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      );
    });

    it('disables an agent-owned skill', async () => {
      mockGetSkill.mockReturnValue(makeSkill({ id: 'my-skill', owner: 'agent', enabled: true }));

      const result = await executeSelfManagementTool('manage_skill', {
        action: 'disable',
        id: 'my-skill',
      });

      expect(result.result).toContain('disabled successfully');
      expect(mockUpsertSkill).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
    });

    it('rejects enabling system-owned skill', async () => {
      mockGetSkill.mockReturnValue(makeSkill({ id: 'sys-skill', owner: 'system' }));

      const result = await executeSelfManagementTool('manage_skill', {
        action: 'enable',
        id: 'sys-skill',
      });

      expect(result.result).toContain('system-owned');
    });
  });

  describe('manage_skill — delete', () => {
    it('deletes an agent-owned skill', async () => {
      mockGetSkill.mockReturnValue(makeSkill({ id: 'my-skill', owner: 'agent' }));

      const result = await executeSelfManagementTool('manage_skill', {
        action: 'delete',
        id: 'my-skill',
      });

      expect(result.result).toContain('deleted successfully');
      expect(mockDeleteSkill).toHaveBeenCalledWith('my-skill');
    });

    it('rejects deleting system-owned skill', async () => {
      mockGetSkill.mockReturnValue(makeSkill({ id: 'sys-skill', owner: 'system' }));

      const result = await executeSelfManagementTool('manage_skill', {
        action: 'delete',
        id: 'sys-skill',
      });

      expect(result.result).toContain('system-owned');
      expect(mockDeleteSkill).not.toHaveBeenCalled();
    });

    it('returns error for nonexistent skill', async () => {
      mockGetSkill.mockReturnValue(undefined);

      const result = await executeSelfManagementTool('manage_skill', {
        action: 'delete',
        id: 'nonexistent',
      });

      expect(result.result).toContain('not found');
    });
  });

  describe('list_skills', () => {
    it('lists all skills with owner and tier info', async () => {
      mockListSkills.mockReturnValue([
        makeSkill({ id: 'sys-1', name: 'Gmail', owner: 'system', tier: SkillTier.Tier1 }),
        makeSkill({ id: 'agent-1', name: 'Notes', owner: 'agent', tier: SkillTier.Tier0, enabled: false }),
      ]);

      const result = await executeSelfManagementTool('list_skills', {});

      expect(result.result).toContain('sys-1: Gmail [system]');
      expect(result.result).toContain('agent-1: Notes [agent]');
      expect(result.result).toContain('Stdio');
      expect(result.result).toContain('Instruction');
      expect(result.result).toContain('disabled');
    });

    it('filters by owner', async () => {
      mockListSkills.mockReturnValue([
        makeSkill({ id: 'sys-1', name: 'Gmail', owner: 'system' }),
        makeSkill({ id: 'agent-1', name: 'Notes', owner: 'agent' }),
      ]);

      const result = await executeSelfManagementTool('list_skills', { owner: 'agent' });

      expect(result.result).not.toContain('sys-1');
      expect(result.result).toContain('agent-1');
    });

    it('returns message when no skills found', async () => {
      mockListSkills.mockReturnValue([]);

      const result = await executeSelfManagementTool('list_skills', {});

      expect(result.result).toContain('No skills registered');
    });
  });

  describe('search_registry', () => {
    it('rejects short queries', async () => {
      const result = await executeSelfManagementTool('search_registry', { query: 'a' });
      expect(result.result).toContain('at least 2 characters');
    });

    it('handles fetch errors gracefully', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));

      try {
        const result = await executeSelfManagementTool('search_registry', { query: 'test-query' });
        expect(result.result).toContain('Registry search failed');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns formatted results on success', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          servers: [
            { name: 'test-server', description: 'A test MCP server', url: 'https://example.com' },
          ],
        }),
      });

      try {
        const result = await executeSelfManagementTool('search_registry', { query: 'test' });
        expect(result.result).toContain('Found 1 MCP servers');
        expect(result.result).toContain('test-server');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('get_system_info', () => {
    it('returns formatted system info', async () => {
      const result = await executeSelfManagementTool('get_system_info', {}, defaultSystemInfo);

      expect(result.result).toContain('Version: 0.1.0');
      expect(result.result).toContain('Uptime: 1h 1m');
      expect(result.result).toContain('Skills: 3');
      expect(result.result).toContain('MCP Tools: 10');
      expect(result.result).toContain('Scheduled Tasks: 2');
    });

    it('handles missing system info', async () => {
      const result = await executeSelfManagementTool('get_system_info', {});
      expect(result.result).toContain('not available');
    });
  });

  describe('unknown tool', () => {
    it('returns error for unknown tool name', async () => {
      const result = await executeSelfManagementTool('unknown_tool', {});
      expect(result.result).toContain('Unknown self-management tool');
    });
  });
});
