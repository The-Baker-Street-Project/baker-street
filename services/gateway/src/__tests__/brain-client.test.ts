import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @bakerst/shared — logger
// ---------------------------------------------------------------------------

vi.mock('@bakerst/shared', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Import module under test after mocks
// ---------------------------------------------------------------------------

import { createBrainClient } from '../brain-client.js';
import type { BrainChatResponse, StreamEvent } from '../brain-client.js';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helper: create a mock ReadableStream from SSE text chunks
// ---------------------------------------------------------------------------

function makeSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: collect all events from an AsyncGenerator
// ---------------------------------------------------------------------------

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests: chat()
// ---------------------------------------------------------------------------

describe('BrainClient.chat', () => {
  it('returns text and conversationId on success', async () => {
    const mockResponse: BrainChatResponse = {
      response: 'Hello there',
      conversationId: 'conv-123',
      jobIds: [],
      toolCallCount: 0,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const client = createBrainClient('http://brain:3000');
    const result = await client.chat('Hi');

    expect(result.response).toBe('Hello there');
    expect(result.conversationId).toBe('conv-123');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://brain:3000/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'Hi' }),
      }),
    );
  });

  it('includes conversationId and channel in request body when provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        response: 'ok',
        conversationId: 'c1',
        jobIds: [],
        toolCallCount: 0,
      }),
    });

    const client = createBrainClient('http://brain:3000');
    await client.chat('test', 'conv-99', 'telegram');

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.message).toBe('test');
    expect(body.conversationId).toBe('conv-99');
    expect(body.channel).toBe('telegram');
  });

  it('throws on non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal error'),
    });

    const client = createBrainClient('http://brain:3000');
    await expect(client.chat('Hi')).rejects.toThrow('brain returned 500: internal error');
  });
});

// ---------------------------------------------------------------------------
// Tests: chatStream() — SSE parsing
// ---------------------------------------------------------------------------

describe('BrainClient.chatStream', () => {
  it('parses SSE delta events', async () => {
    const stream = makeSSEStream([
      'data: {"type":"delta","text":"Hello"}\n\n',
      'data: {"type":"delta","text":" world"}\n\n',
      'data: {"type":"done","conversationId":"c1"}\n\n',
    ]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
    });

    const client = createBrainClient('http://brain:3000');
    const events = await collectEvents(client.chatStream('test'));

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: 'delta', text: 'Hello' });
    expect(events[1]).toEqual({ type: 'delta', text: ' world' });
    expect(events[2]).toEqual({ type: 'done', conversationId: 'c1' });
  });

  it('skips non-data lines (comments, empty lines)', async () => {
    const stream = makeSSEStream([
      ': this is a comment\n',
      '\n',
      'data: {"type":"delta","text":"only"}\n\n',
    ]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
    });

    const client = createBrainClient('http://brain:3000');
    const events = await collectEvents(client.chatStream('test'));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'delta', text: 'only' });
  });

  it('handles partial chunks across reads', async () => {
    // Split an event across two chunks
    const stream = makeSSEStream([
      'data: {"type":"del',
      'ta","text":"split"}\n\n',
    ]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
    });

    const client = createBrainClient('http://brain:3000');
    const events = await collectEvents(client.chatStream('test'));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'delta', text: 'split' });
  });

  it('handles remaining buffer data after stream ends', async () => {
    // Data without trailing newline — should still be processed
    const stream = makeSSEStream([
      'data: {"type":"delta","text":"buffered"}',
    ]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
    });

    const client = createBrainClient('http://brain:3000');
    const events = await collectEvents(client.chatStream('test'));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'delta', text: 'buffered' });
  });

  it('throws on non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('unauthorized'),
    });

    const client = createBrainClient('http://brain:3000');
    const gen = client.chatStream('test');

    await expect(gen.next()).rejects.toThrow('brain returned 401: unauthorized');
  });

  it('throws when response has no body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null,
    });

    const client = createBrainClient('http://brain:3000');
    const gen = client.chatStream('test');

    await expect(gen.next()).rejects.toThrow('brain response has no body');
  });

  it('gracefully handles malformed SSE JSON', async () => {
    const stream = makeSSEStream([
      'data: {"type":"delta","text":"good"}\n\n',
      'data: not-valid-json\n\n',
      'data: {"type":"done"}\n\n',
    ]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
    });

    const client = createBrainClient('http://brain:3000');
    const events = await collectEvents(client.chatStream('test'));

    // Malformed line is skipped; good events are yielded
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'delta', text: 'good' });
    expect(events[1]).toEqual({ type: 'done' });
  });

  it('parses tool_result and thinking events', async () => {
    const stream = makeSSEStream([
      'data: {"type":"thinking","text":"let me think..."}\n\n',
      'data: {"type":"tool_result","tool":"search","summary":"found 3 results"}\n\n',
    ]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
    });

    const client = createBrainClient('http://brain:3000');
    const events = await collectEvents(client.chatStream('test'));

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'thinking', text: 'let me think...' });
    expect(events[1]).toEqual({ type: 'tool_result', tool: 'search', summary: 'found 3 results' });
  });

  it('sends correct headers and URL for streaming endpoint', async () => {
    const stream = makeSSEStream([
      'data: {"type":"done"}\n\n',
    ]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
    });

    const client = createBrainClient('http://brain:3000');
    await collectEvents(client.chatStream('msg', 'conv-1', 'discord'));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://brain:3000/chat/stream',
      expect.objectContaining({
        method: 'POST',
      }),
    );

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.message).toBe('msg');
    expect(body.conversationId).toBe('conv-1');
    expect(body.channel).toBe('discord');
  });
});
