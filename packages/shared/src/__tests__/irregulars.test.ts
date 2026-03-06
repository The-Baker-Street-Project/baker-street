import { describe, it, expect } from 'vitest';
import { createIrregularDispatch, isIrregularDispatch, type IrregularDispatch, type Tradecraft } from '../irregulars.js';

describe('IrregularDispatch', () => {
  it('createIrregularDispatch produces a valid dispatch with defaults', () => {
    const d = createIrregularDispatch({
      platform: 'telegram',
      channelId: 'chat-123',
      senderId: 'user-456',
      senderName: 'Gary',
      text: 'Hello Baker',
    });

    expect(d.id).toBeDefined();
    expect(d.platform).toBe('telegram');
    expect(d.channelId).toBe('chat-123');
    expect(d.senderId).toBe('user-456');
    expect(d.senderName).toBe('Gary');
    expect(d.text).toBe('Hello Baker');
    expect(d.timestamp).toBeDefined();
    expect(d.channelData).toBeUndefined();
  });

  it('createIrregularDispatch preserves optional channelData', () => {
    const d = createIrregularDispatch({
      platform: 'discord',
      channelId: 'guild-abc#general',
      senderId: 'user-789',
      senderName: 'Gary',
      text: 'Hello',
      channelData: { guildId: 'guild-abc', channelName: 'general' },
    });

    expect(d.channelData).toEqual({ guildId: 'guild-abc', channelName: 'general' });
  });

  it('isIrregularDispatch validates required fields', () => {
    expect(isIrregularDispatch({ id: '1', platform: 'x', channelId: 'c', senderId: 's', senderName: 'n', text: 't', timestamp: '2026-01-01' })).toBe(true);
    expect(isIrregularDispatch({ platform: 'x' })).toBe(false);
    expect(isIrregularDispatch(null)).toBe(false);
    expect(isIrregularDispatch('string')).toBe(false);
  });
});

describe('Tradecraft', () => {
  it('has expected shape', () => {
    const tc: Tradecraft = {
      chatTypes: ['direct', 'group'],
      threads: false,
      reactions: true,
      richEmbeds: false,
      media: true,
      maxMessageLength: 4096,
    };
    expect(tc.chatTypes).toContain('direct');
    expect(tc.maxMessageLength).toBe(4096);
  });
});
