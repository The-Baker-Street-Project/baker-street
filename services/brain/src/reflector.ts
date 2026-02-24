import { logger } from '@bakerst/shared';
import type { ModelRouter } from '@bakerst/shared';
import {
  getMemoryState,
  getActiveObservationLog,
  upsertObservationLog,
  updateMemoryState,
  addReflection,
} from './db.js';
import { estimateTokens } from './token-count.js';
import { MEMORY_CONFIG } from './memory-config.js';

const log = logger.child({ module: 'reflector' });

const REFLECTOR_SYSTEM_PROMPT = `You are a memory compactor. You receive an observation log from an ongoing conversation between a user and an AI assistant.

Your job is to produce a **condensed** version of the observation log that preserves all important information while reducing the token count by approximately 40%.

Rules:
- Merge redundant or overlapping observations into single entries
- Drop observations that have been superseded by later ones (e.g. "decided to use X" followed by "switched from X to Y" — keep only the latter)
- Preserve all active decisions, preferences, constraints, and unresolved issues
- Preserve the [tag] format: [Decision], [Preference], [Fact], [Issue], [NextStep], [Outcome]
- Maintain chronological order
- Do NOT invent or infer information not present in the original log
- Do NOT add commentary or meta-observations about the compaction process

Output only the condensed observation log, nothing else.`;

/**
 * Compact the observation log when it exceeds the reflector threshold.
 * Uses the reflector role (default: Sonnet) for judgment about what to keep vs. merge.
 * Designed to run fire-and-forget after the response is sent.
 */
export async function runReflector(conversationId: string, modelRouter: ModelRouter): Promise<void> {
  const memState = getMemoryState(conversationId);
  if (!memState) {
    log.warn({ conversationId }, 'no memory state found, skipping reflector');
    return;
  }

  // Enforce minimum interval between reflector runs
  if (memState.last_reflector_run) {
    const lastRun = new Date(memState.last_reflector_run).getTime();
    const minInterval = MEMORY_CONFIG.reflectMinIntervalMinutes * 60 * 1000;
    if (Date.now() - lastRun < minInterval) {
      log.info(
        { conversationId, lastRun: memState.last_reflector_run },
        'reflector skipped — minimum interval not reached',
      );
      return;
    }
  }

  const obsLog = getActiveObservationLog(conversationId);
  if (!obsLog || !obsLog.text) {
    log.info({ conversationId }, 'no observation log to compact, skipping reflector');
    return;
  }

  log.info(
    { conversationId, logVersion: obsLog.version, logTokens: obsLog.token_count },
    'running reflector',
  );

  const response = await modelRouter.chat({
    role: 'reflector',
    system: [{ type: 'text', text: REFLECTOR_SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: obsLog.text }],
    maxTokens: 4096,
  });

  const compactedText = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  if (!compactedText.trim()) {
    log.warn({ conversationId }, 'reflector produced empty output, keeping original log');
    return;
  }

  const newTokenCount = estimateTokens(compactedText);
  const reduction = obsLog.token_count > 0
    ? Math.round((1 - newTokenCount / obsLog.token_count) * 100)
    : 0;

  // Store the reflection for audit trail
  addReflection(conversationId, obsLog.version, compactedText, newTokenCount);

  // Write new observation log version with compacted text
  const newVersion = obsLog.version + 1;
  upsertObservationLog(conversationId, newVersion, compactedText, newTokenCount);

  // Update memory state
  const updated = updateMemoryState(conversationId, {
    observation_token_count: newTokenCount,
    last_reflector_run: new Date().toISOString(),
  }, memState.lock_version);

  if (!updated) {
    log.warn({ conversationId }, 'reflector memory state update failed (concurrent write), will retry next turn');
    return;
  }

  log.info(
    {
      conversationId,
      oldVersion: obsLog.version,
      newVersion,
      oldTokens: obsLog.token_count,
      newTokens: newTokenCount,
      reductionPct: reduction,
    },
    'reflector completed',
  );
}
