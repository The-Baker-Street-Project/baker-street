import type Anthropic from '@anthropic-ai/sdk';
import {
  getMessages,
  getActiveObservationLog,
  getMemoryState,
} from './db.js';
import { MEMORY_CONFIG } from './memory-config.js';
import type { MemorySearchResult } from './memory.js';

/** TextBlockParam with optional cache_control for prompt caching */
type CacheableTextBlock = Anthropic.Messages.TextBlockParam & {
  cache_control?: { type: 'ephemeral' };
};

export interface BuiltContext {
  /** System blocks for the prompt (stable prefix + per-turn tail) */
  systemBlocks: CacheableTextBlock[];
  /** Recent messages for the conversation tail */
  messages: Anthropic.Messages.MessageParam[];
  /** Whether the observer should run after this turn */
  shouldObserve: boolean;
  /** Whether the reflector should run after this turn */
  shouldReflect: boolean;
}

export function buildContext(
  conversationId: string,
  systemPrompt: string,
  relevantMemories: MemorySearchResult[],
  opts: { useOAuth: boolean; channel?: string },
): BuiltContext {
  // --- Stable prefix (cacheable) ---
  const systemBlocks: CacheableTextBlock[] = [];

  // Block 1: Claude Code identity (if OAuth) — stable across all conversations
  if (opts.useOAuth) {
    systemBlocks.push({
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    });
  }

  // Block 2: SOUL.md + BRAIN.md system prompt — stable across all conversations
  if (systemPrompt) {
    systemBlocks.push({ type: 'text', text: systemPrompt });
  }

  // Block 3: Observation log — stable within conversation, changes only after observer/reflector
  const obsLog = getActiveObservationLog(conversationId);
  if (obsLog && obsLog.text) {
    systemBlocks.push({
      type: 'text',
      text: `## Conversation Context (Observations)\nThe following observations were automatically extracted from this conversation. They capture key decisions, preferences, facts, and outcomes.\n\n${obsLog.text}`,
      cache_control: { type: 'ephemeral' },
    });
  }

  // If there's no observation log, put the cache breakpoint on the last stable block
  if (!obsLog?.text && systemBlocks.length > 0) {
    systemBlocks[systemBlocks.length - 1].cache_control = { type: 'ephemeral' };
  }

  // --- Per-turn blocks (not cached — change every request) ---

  // Block 4: Long-term memories (Qdrant) — changes per turn
  if (relevantMemories.length > 0) {
    const lines = relevantMemories.map(
      (m) => `- [${m.category}] ${m.content} (id: ${m.id})`,
    );
    systemBlocks.push({
      type: 'text',
      text: `## Long-Term Memories\nThe following facts were retrieved from your long-term memory. Use them to inform your response. If a memory is outdated, use memory_delete to remove it and memory_store to save the corrected version.\n\n${lines.join('\n')}`,
    });
  }

  // Block 5: Channel hint — changes per request
  if (opts.channel && opts.channel !== 'web') {
    systemBlocks.push({
      type: 'text',
      text: `The user is messaging from ${opts.channel}. Keep responses concise and well-formatted for chat apps. Avoid large code blocks or complex tables.`,
    });
  }

  // --- Tail: recent messages only ---
  const memState = getMemoryState(conversationId);
  const allMessages = getMessages(conversationId);

  let tailStart = 0;

  if (memState?.observed_cursor_message_id) {
    // Find cursor position — take everything after the observed cursor
    const cursorIdx = allMessages.findIndex(
      (m) => m.id === memState.observed_cursor_message_id,
    );
    if (cursorIdx >= 0) {
      tailStart = cursorIdx + 1;
    }
  }

  // Take messages from cursor onward, but always keep at least keepLastMessages
  let tailMessages = allMessages.slice(tailStart);
  if (tailMessages.length < MEMORY_CONFIG.keepLastMessages && allMessages.length > 0) {
    const startIdx = Math.max(0, allMessages.length - MEMORY_CONFIG.keepLastMessages);
    tailMessages = allMessages.slice(startIdx);
  }

  const messages: Anthropic.Messages.MessageParam[] = tailMessages.map((r) => ({
    role: r.role as 'user' | 'assistant',
    content: r.content,
  }));

  // --- Threshold checks ---
  const shouldObserve =
    (memState?.unobserved_token_count ?? 0) >= MEMORY_CONFIG.observeThresholdTokens;
  const shouldReflect =
    (memState?.observation_token_count ?? 0) >= MEMORY_CONFIG.reflectThresholdTokens;

  return { systemBlocks, messages, shouldObserve, shouldReflect };
}
