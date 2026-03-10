import { logger } from '@bakerst/shared';

const log = logger.child({ module: 'voice-brain-client' });

export interface StreamEvent {
  type: 'delta' | 'thinking' | 'tool_result' | 'done' | 'error';
  text?: string;
  conversationId?: string;
  tool?: string;
  summary?: string;
  message?: string;
}

/**
 * Stream a chat message through Brain's /chat/stream SSE endpoint.
 *
 * Yields StreamEvent objects as they arrive. The caller collects delta
 * text and relays events to the browser.
 */
export async function* chatStream(
  brainUrl: string,
  authToken: string,
  message: string,
  conversationId?: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const url = `${brainUrl}/chat/stream`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const body: Record<string, unknown> = { message };
  if (conversationId) body.conversationId = conversationId;

  log.info({ url, conversationId, messageLength: message.length }, 'calling brain (stream)');

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`brain returned ${res.status}: ${text}`);
  }

  if (!res.body) {
    throw new Error('brain response has no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const jsonStr = trimmed.slice(6); // Remove 'data: ' prefix
        try {
          const event = JSON.parse(jsonStr) as StreamEvent;
          yield event;
        } catch {
          log.warn({ line: trimmed }, 'failed to parse SSE event');
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim().startsWith('data: ')) {
      const jsonStr = buffer.trim().slice(6);
      try {
        const event = JSON.parse(jsonStr) as StreamEvent;
        yield event;
      } catch {
        log.warn({ line: buffer.trim() }, 'failed to parse final SSE event');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
