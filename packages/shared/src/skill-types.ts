/**
 * Skill system types for the MCP infrastructure.
 *
 * Skills are the evolution of the plugin system, supporting multiple tiers:
 * - Tier 0 (instruction): Markdown files injected into the system prompt
 * - Tier 1 (stdio): MCP servers connected via stdio transport
 * - Tier 2 (sidecar): MCP servers running as K8s sidecar containers
 * - Tier 3 (service): MCP servers running as standalone K8s services
 */

/** Skill execution tier — determines how the skill is connected and run */
export enum SkillTier {
  /** Instruction-only skill: markdown injected into the system prompt */
  Tier0 = 'instruction',
  /** Local MCP server connected via stdio (child process) */
  Tier1 = 'stdio',
  /** Sidecar MCP server (K8s sidecar container, accessed via HTTP) */
  Tier2 = 'sidecar',
  /** Standalone MCP service (K8s service, accessed via HTTP) */
  Tier3 = 'service',
}

/** Transport protocol for communicating with MCP servers */
export type SkillTransport = 'stdio' | 'http' | 'streamable-http';

/** Metadata describing a registered skill */
export interface SkillMetadata {
  /** Unique skill identifier (e.g. "gmail", "browser", "coding-standards") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version */
  version: string;
  /** Description of what this skill provides */
  description: string;
  /** Execution tier */
  tier: SkillTier;
  /** Transport protocol (required for Tier 1-3, ignored for Tier 0) */
  transport?: SkillTransport;
  /** Whether this skill is currently enabled */
  enabled: boolean;
  /** Arbitrary configuration passed to the skill */
  config: Record<string, unknown>;
  /** For Tier 1 (stdio): the executable to spawn (e.g. "node") */
  stdioCommand?: string;
  /** For Tier 1 (stdio): arguments to pass to the executable (e.g. ["/path/to/server.js"]) */
  stdioArgs?: string[];
  /** For Tier 2/3 (http): the URL of the MCP server */
  httpUrl?: string;
  /** For Tier 0 (instruction): path to the markdown file */
  instructionPath?: string;
  /** For Tier 0 (instruction): inline markdown content (takes priority over instructionPath) */
  instructionContent?: string;
  /** Who owns this skill: 'system' (human-managed), 'agent' (self-installed), or 'extension' (pod-based) */
  owner?: 'system' | 'agent' | 'extension';
  /** Skill tags for categorization and filtering (e.g., 'task-recipe') */
  tags?: string[];
}

/** Tool definition that includes a reference back to its owning skill */
export interface SkillToolDefinition {
  /** Tool name as exposed to the agent */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema for tool input */
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /** ID of the skill that owns this tool */
  skillId: string;
}

/** Toolbox image variant for Task Pods */
export interface Toolbox {
  name: string;
  description: string;
  image: string;
  packages: string[];
  status: 'built' | 'not_built' | 'building' | 'error';
  usedByRecipes: number;
  lastBuilt?: string;
}
