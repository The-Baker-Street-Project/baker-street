/**
 * SysAdmin-specific types (local to this service).
 * Shared types (ReleaseManifest, SysAdminState, etc.) are in @bakerst/shared.
 */

import type { ToolDefinition, ChatMessage } from '@bakerst/shared';

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export interface ToolResult {
  result: string;
  /** If true, the agent loop should immediately transition state */
  stateTransition?: 'runtime' | 'update' | 'shutdown';
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ---------------------------------------------------------------------------
// WebSocket terminal protocol
// ---------------------------------------------------------------------------

/** Messages sent FROM the sysadmin TO the terminal client */
export type ServerMessage =
  | { type: 'text'; content: string }
  | { type: 'ask'; id: string; question: string; inputType: 'text' | 'secret' | 'choice'; choices?: string[] }
  | { type: 'status'; state: string; version?: string }
  | { type: 'thinking'; tool: string }
  | { type: 'error'; message: string };

/** Messages sent FROM the terminal client TO the sysadmin */
export type ClientMessage =
  | { type: 'answer'; id: string; value: string }
  | { type: 'chat'; message: string };

// ---------------------------------------------------------------------------
// Agent context
// ---------------------------------------------------------------------------

export interface AgentContext {
  /** Current conversation messages (in-memory only) */
  messages: ChatMessage[];
  /** Available tools for the current state */
  tools: RegisteredTool[];
  /** System prompt for the current state */
  systemPrompt: string;
}
