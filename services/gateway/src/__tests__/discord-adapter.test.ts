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
// Mock discord.js before importing adapter
// ---------------------------------------------------------------------------

const mockClientOn = vi.fn();
const mockClientLogin = vi.fn().mockResolvedValue('token');
const mockClientDestroy = vi.fn();
const mockChannelsFetch = vi.fn();

vi.mock('discord.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    on: mockClientOn,
    login: mockClientLogin,
    destroy: mockClientDestroy,
    user: { tag: 'TestBot#1234' },
    channels: { fetch: mockChannelsFetch },
  })),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  },
  Partials: { Channel: 0, Message: 1 },
}));

import { createDiscordAdapter } from '../adapters/discord.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Discord IrregularAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has platform "discord" and correct tradecraft', () => {
    const adapter = createDiscordAdapter('token', []);
    expect(adapter.platform).toBe('discord');
    expect(adapter.tradecraft.maxMessageLength).toBe(2000);
    expect(adapter.tradecraft.threads).toBe(true);
    expect(adapter.tradecraft.richEmbeds).toBe(true);
    expect(adapter.tradecraft.chatTypes).toContain('direct');
    expect(adapter.tradecraft.chatTypes).toContain('thread');
  });

  it('start() registers messageCreate handler and logs in', async () => {
    const adapter = createDiscordAdapter('token', []);
    const onDispatch = vi.fn();
    await adapter.start(onDispatch);
    expect(mockClientOn).toHaveBeenCalledWith('messageCreate', expect.any(Function));
    expect(mockClientLogin).toHaveBeenCalledWith('token');
  });

  it('sendResponse fetches channel and sends message chunks', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const adapter = createDiscordAdapter('token', []);
    await adapter.sendResponse('ch-1', 'Hello from Discord');

    expect(mockChannelsFetch).toHaveBeenCalledWith('ch-1');
    expect(mockSend).toHaveBeenCalledWith('Hello from Discord');
  });

  it('sendResponse handles null channel gracefully', async () => {
    mockChannelsFetch.mockResolvedValue(null);

    const adapter = createDiscordAdapter('token', []);
    // Should not throw
    await adapter.sendResponse('bad-channel', 'Hello');
    expect(mockChannelsFetch).toHaveBeenCalledWith('bad-channel');
  });

  it('stop() destroys client', async () => {
    const adapter = createDiscordAdapter('token', []);
    await adapter.stop();
    expect(mockClientDestroy).toHaveBeenCalled();
  });
});
