import { logger } from '@bakerst/shared';

const log = logger.child({ module: 'brain-client' });

const authToken = process.env.AUTH_TOKEN;
if (!authToken) {
  log.warn('AUTH_TOKEN not configured - requests to brain will be unauthenticated');
}

function brainHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  return headers;
}

export interface BrainChatResponse {
  response: string;
  conversationId: string;
  jobIds: string[];
  toolCallCount: number;
}

export interface StreamEvent {
  type: 'delta' | 'thinking' | 'tool_result' | 'done' | 'error';
  text?: string;
  conversationId?: string;
  tool?: string;
  summary?: string;
  message?: string;
}

export interface BrainClient {
  chat(message: string, conversationId?: string, channel?: string): Promise<BrainChatResponse>;
  chatStream(message: string, conversationId?: string, channel?: string, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
}

export function createBrainClient(brainUrl: string): BrainClient {
  async function chat(
    message: string,
    conversationId?: string,
    channel?: string,
  ): Promise<BrainChatResponse> {
    const url = `${brainUrl}/chat`;
    const body: Record<string, unknown> = { message };
    if (conversationId) body.conversationId = conversationId;
    if (channel) body.channel = channel;

    log.info({ url, conversationId, channel, messageLength: message.length }, 'calling brain');

    const res = await fetch(url, {
      method: 'POST',
      headers: brainHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`brain returned ${res.status}: ${text}`);
    }

    const data = (await res.json()) as BrainChatResponse;
    log.info(
      { conversationId: data.conversationId, toolCallCount: data.toolCallCount, responseLength: data.response.length },
      'brain response received',
    );
    return data;
  }

  async function* chatStream(
    message: string,
    conversationId?: string,
    channel?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const url = `${brainUrl}/chat/stream`;
    const body: Record<string, unknown> = { message };
    if (conversationId) body.conversationId = conversationId;
    if (channel) body.channel = channel;

    log.info({ url, conversationId, channel, messageLength: message.length }, 'calling brain (stream)');

    const res = await fetch(url, {
      method: 'POST',
      headers: brainHeaders(),
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

  return { chat, chatStream };
}
