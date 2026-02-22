import { logger } from '@bakerst/shared';
import type { ModelRouter } from '@bakerst/shared';
import {
  getMessages,
  getMemoryState,
  addObservation,
  getActiveObservationLog,
  upsertObservationLog,
  updateMemoryState,
} from './db.js';
import { estimateTokens } from './token-count.js';

const log = logger.child({ module: 'observer' });

const OBSERVER_SYSTEM_PROMPT = `You are an observation extractor. Given a slice of conversation between a user and an AI assistant, extract the key observations.

Output a structured list of observations. Each observation should be:
- Time-anchored (include approximate date if available)
- Tagged with a category: Decision, Preference, Fact, Issue, NextStep, Outcome
- Self-contained (understandable without the original conversation)
- Concise (1-2 sentences max)

Format:
[tag] Observation text.

Only extract information worth remembering. Skip pleasantries, small talk, and routine exchanges. Focus on:
- Decisions made and their rationale
- User preferences expressed
- Important facts or constraints discovered
- Issues encountered and resolutions
- Action items or next steps agreed upon
- Tool/command outcomes that affect future work`;

/**
 * Compress unobserved messages into structured observations.
 * Uses the observer role (default: Haiku) for cost efficiency (~20x cheaper than Sonnet).
 * Designed to run fire-and-forget after the response is sent.
 */
export async function runObserver(conversationId: string, modelRouter: ModelRouter): Promise<void> {
  const memState = getMemoryState(conversationId);
  if (!memState) {
    log.warn({ conversationId }, 'no memory state found, skipping observer');
    return;
  }

  // Get unobserved messages
  const allMessages = getMessages(conversationId);
  let startIdx = 0;

  if (memState.observed_cursor_message_id) {
    const cursorIdx = allMessages.findIndex(
      (m) => m.id === memState.observed_cursor_message_id,
    );
    if (cursorIdx >= 0) startIdx = cursorIdx + 1;
  }

  const unobserved = allMessages.slice(startIdx);
  if (unobserved.length === 0) {
    log.info({ conversationId }, 'no unobserved messages, skipping observer');
    return;
  }

  log.info(
    { conversationId, messageCount: unobserved.length, unobservedTokens: memState.unobserved_token_count },
    'running observer',
  );

  // Format messages for the observer prompt
  const slice = unobserved
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n\n');

  const response = await modelRouter.chat({
    role: 'observer',
    system: [{ type: 'text', text: OBSERVER_SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: slice }],
    maxTokens: 2048,
  });

  const observationText = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  if (!observationText.trim()) {
    log.info({ conversationId }, 'observer produced no observations');
    return;
  }

  const tokenCount = estimateTokens(observationText);
  const lastMsg = unobserved[unobserved.length - 1];
  const firstMsg = unobserved[0];

  // Append observation chunk to the observations table
  addObservation(
    conversationId,
    observationText,
    tokenCount,
    null, // tags are inline in the formatted text
    firstMsg.id,
    lastMsg.id,
  );

  // Update the materialized observation log (append to existing)
  const existing = getActiveObservationLog(conversationId);
  const newVersion = (existing?.version ?? 0) + 1;
  const separator = existing?.text ? '\n\n---\n\n' : '';
  const newLogText = (existing?.text ?? '') + separator + observationText;
  const newLogTokens = estimateTokens(newLogText);

  upsertObservationLog(conversationId, newVersion, newLogText, newLogTokens);

  // Advance cursor and reset unobserved count
  const updated = updateMemoryState(conversationId, {
    observed_cursor_message_id: lastMsg.id,
    unobserved_token_count: 0,
    observation_token_count: newLogTokens,
    last_observer_run: new Date().toISOString(),
  }, memState.lock_version);

  if (!updated) {
    log.warn({ conversationId }, 'observer memory state update failed (concurrent write), will retry next turn');
    return;
  }

  log.info(
    { conversationId, observationTokens: tokenCount, logVersion: newVersion, totalLogTokens: newLogTokens },
    'observer completed',
  );
}
