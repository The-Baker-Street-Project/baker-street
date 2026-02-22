import type { StreamEvent } from './types';
import { TOKEN_KEY } from './constants';

export async function* chatStream(
  message: string,
  conversationId?: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, conversationId }),
    signal,
  });

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('bakerst:unauthorized', { detail: { status: 401 } }));
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Stream error ${res.status}: ${body}`);
  }

  if (!res.body) {
    throw new Error('Response body is null — streaming not supported');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            yield JSON.parse(data) as StreamEvent;
          } catch {
            // skip malformed events
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
