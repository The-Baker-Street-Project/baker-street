import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @bakerst/shared — keep real exports, stub logger
// ---------------------------------------------------------------------------

vi.mock('@bakerst/shared', async () => {
  const actual = await vi.importActual('@bakerst/shared');
  return {
    ...actual,
    logger: {
      child: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock grammy before importing adapter
// ---------------------------------------------------------------------------

const mockBotOn = vi.fn();
const mockBotStart = vi.fn();
const mockBotStop = vi.fn();
const mockBotApiSendMessage = vi.fn();
const mockBotApiSendChatAction = vi.fn();
const mockBotCatch = vi.fn();

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: mockBotOn,
    start: mockBotStart,
    stop: mockBotStop,
    catch: mockBotCatch,
    api: {
      sendMessage: mockBotApiSendMessage,
      sendChatAction: mockBotApiSendChatAction,
    },
  })),
}));

import { createTelegramAdapter } from '../adapters/telegram.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Telegram IrregularAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has platform "telegram" and correct tradecraft', () => {
    const adapter = createTelegramAdapter('token', []);
    expect(adapter.platform).toBe('telegram');
    expect(adapter.tradecraft.maxMessageLength).toBe(4096);
    expect(adapter.tradecraft.chatTypes).toContain('direct');
    expect(adapter.tradecraft.chatTypes).toContain('group');
    expect(adapter.tradecraft.threads).toBe(false);
  });

  it('start() registers message handler, error handler, and starts bot', async () => {
    const adapter = createTelegramAdapter('token', []);
    const onDispatch = vi.fn();
    await adapter.start(onDispatch);
    expect(mockBotOn).toHaveBeenCalledWith('message:text', expect.any(Function));
    expect(mockBotCatch).toHaveBeenCalledWith(expect.any(Function));
    expect(mockBotStart).toHaveBeenCalled();
  });

  it('sendResponse sends message to channel with Markdown parse mode', async () => {
    const adapter = createTelegramAdapter('token', []);
    mockBotApiSendMessage.mockResolvedValue({});
    await adapter.sendResponse('12345', 'Hello');
    expect(mockBotApiSendMessage).toHaveBeenCalledWith(
      12345,
      'Hello',
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
  });

  it('sendResponse retries without parse_mode on Markdown failure', async () => {
    const adapter = createTelegramAdapter('token', []);
    mockBotApiSendMessage
      .mockRejectedValueOnce(new Error('Markdown parse error'))
      .mockResolvedValueOnce({});
    await adapter.sendResponse('12345', 'Hello *bad*');
    expect(mockBotApiSendMessage).toHaveBeenCalledTimes(2);
    // Second call should not have parse_mode
    const secondCall = mockBotApiSendMessage.mock.calls[1];
    expect(secondCall[2]).not.toHaveProperty('parse_mode');
  });

  it('sendTyping sends typing action', async () => {
    const adapter = createTelegramAdapter('token', []);
    mockBotApiSendChatAction.mockResolvedValue(true);
    await adapter.sendTyping('12345');
    expect(mockBotApiSendChatAction).toHaveBeenCalledWith(12345, 'typing');
  });

  it('stop() calls bot.stop()', async () => {
    const adapter = createTelegramAdapter('token', []);
    mockBotStop.mockResolvedValue(undefined);
    await adapter.stop();
    expect(mockBotStop).toHaveBeenCalled();
  });
});
