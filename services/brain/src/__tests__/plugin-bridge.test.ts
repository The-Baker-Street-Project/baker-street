import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUnifiedToolRegistry } from '../plugin-bridge.js';
import type { SkillRegistry } from '../skill-registry.js';
import type { PluginRegistry } from '../plugin-registry.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockSkillRegistry(overrides?: Partial<SkillRegistry>): SkillRegistry {
  return {
    getAllTools: vi.fn().mockResolvedValue([]),
    hasTool: vi.fn().mockReturnValue(false),
    execute: vi.fn().mockResolvedValue({ result: 'skill result' }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    loadFromDatabase: vi.fn().mockResolvedValue(undefined),
    migrateFromPluginsJson: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as SkillRegistry;
}

function makeMockPluginRegistry(overrides?: Partial<PluginRegistry>): PluginRegistry {
  return {
    allTools: vi.fn().mockReturnValue([]),
    hasPlugin: vi.fn().mockReturnValue(false),
    execute: vi.fn().mockResolvedValue({ result: 'plugin result' }),
    handleTrigger: vi.fn().mockResolvedValue(null),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PluginRegistry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Plugin Bridge (createUnifiedToolRegistry)', () => {
  let mockSkillRegistry: SkillRegistry;
  let mockPluginRegistry: PluginRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSkillRegistry = makeMockSkillRegistry();
    mockPluginRegistry = makeMockPluginRegistry();
  });

  describe('allToolDefinitions()', () => {
    it('combines skill and plugin tools', async () => {
      mockSkillRegistry = makeMockSkillRegistry({
        getAllTools: vi.fn().mockResolvedValue([
          { name: 'skill-tool', description: 'From skill', input_schema: { type: 'object' }, skillId: 's1' },
        ]),
      });
      mockPluginRegistry = makeMockPluginRegistry({
        allTools: vi.fn().mockReturnValue([
          { name: 'plugin-tool', description: 'From plugin', input_schema: { type: 'object' } },
        ]),
      });

      const bridge = createUnifiedToolRegistry(mockSkillRegistry, mockPluginRegistry);
      const tools = await bridge.allToolDefinitions();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(['skill-tool', 'plugin-tool']);
    });

    it('skill tools take precedence over same-named plugin tools', async () => {
      mockSkillRegistry = makeMockSkillRegistry({
        getAllTools: vi.fn().mockResolvedValue([
          { name: 'shared-tool', description: 'From skill', input_schema: { type: 'object' }, skillId: 's1' },
        ]),
      });
      mockPluginRegistry = makeMockPluginRegistry({
        allTools: vi.fn().mockReturnValue([
          { name: 'shared-tool', description: 'From plugin', input_schema: { type: 'object' } },
        ]),
      });

      const bridge = createUnifiedToolRegistry(mockSkillRegistry, mockPluginRegistry);
      const tools = await bridge.allToolDefinitions();
      expect(tools).toHaveLength(1);
      expect(tools[0].description).toBe('From skill');
    });

    it('returns empty when both registries empty', async () => {
      const bridge = createUnifiedToolRegistry(mockSkillRegistry, mockPluginRegistry);
      const tools = await bridge.allToolDefinitions();
      expect(tools).toEqual([]);
    });
  });

  describe('hasTool()', () => {
    it('returns true when skill registry has tool', () => {
      mockSkillRegistry = makeMockSkillRegistry({
        hasTool: vi.fn().mockReturnValue(true),
      });
      const bridge = createUnifiedToolRegistry(mockSkillRegistry, mockPluginRegistry);
      expect(bridge.hasTool('some-tool')).toBe(true);
    });

    it('returns true when plugin registry has tool', () => {
      mockPluginRegistry = makeMockPluginRegistry({
        hasPlugin: vi.fn().mockReturnValue(true),
      });
      const bridge = createUnifiedToolRegistry(mockSkillRegistry, mockPluginRegistry);
      expect(bridge.hasTool('some-tool')).toBe(true);
    });

    it('returns false when neither has tool', () => {
      const bridge = createUnifiedToolRegistry(mockSkillRegistry, mockPluginRegistry);
      expect(bridge.hasTool('nonexistent')).toBe(false);
    });
  });

  describe('execute()', () => {
    it('routes to skill registry first', async () => {
      mockSkillRegistry = makeMockSkillRegistry({
        hasTool: vi.fn().mockReturnValue(true),
        execute: vi.fn().mockResolvedValue({ result: 'from skill' }),
      });
      mockPluginRegistry = makeMockPluginRegistry({
        hasPlugin: vi.fn().mockReturnValue(true),
        execute: vi.fn().mockResolvedValue({ result: 'from plugin' }),
      });

      const bridge = createUnifiedToolRegistry(mockSkillRegistry, mockPluginRegistry);
      const result = await bridge.execute('tool-name', { input: 'test' });
      expect(result.result).toBe('from skill');
      expect(mockSkillRegistry.execute).toHaveBeenCalled();
      expect(mockPluginRegistry.execute).not.toHaveBeenCalled();
    });

    it('falls back to plugin registry', async () => {
      mockSkillRegistry = makeMockSkillRegistry({
        hasTool: vi.fn().mockReturnValue(false),
      });
      mockPluginRegistry = makeMockPluginRegistry({
        hasPlugin: vi.fn().mockReturnValue(true),
        execute: vi.fn().mockResolvedValue({ result: 'from plugin' }),
      });

      const bridge = createUnifiedToolRegistry(mockSkillRegistry, mockPluginRegistry);
      const result = await bridge.execute('legacy-tool', { input: 'test' });
      expect(result.result).toBe('from plugin');
    });
  });

  describe('shutdown()', () => {
    it('calls shutdown on both registries', async () => {
      const bridge = createUnifiedToolRegistry(mockSkillRegistry, mockPluginRegistry);
      await bridge.shutdown();
      expect(mockSkillRegistry.shutdown).toHaveBeenCalled();
      expect(mockPluginRegistry.shutdown).toHaveBeenCalled();
    });
  });
});
