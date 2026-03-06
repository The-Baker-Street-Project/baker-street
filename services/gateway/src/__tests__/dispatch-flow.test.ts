import { describe, it, expect } from 'vitest';
import { createIrregularDispatch, isIrregularDispatch } from '@bakerst/shared';

describe('IrregularDispatch flow', () => {
  it('createIrregularDispatch generates id and timestamp', () => {
    const d = createIrregularDispatch({
      platform: 'telegram',
      channelId: '123',
      senderId: 'user-1',
      senderName: 'Test User',
      text: 'Hello',
    });

    expect(d.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(d.timestamp).getTime()).not.toBeNaN();
    expect(d.platform).toBe('telegram');
    expect(d.channelId).toBe('123');
    expect(d.text).toBe('Hello');
    expect(isIrregularDispatch(d)).toBe(true);
  });

  it('isIrregularDispatch rejects invalid objects', () => {
    expect(isIrregularDispatch(null)).toBe(false);
    expect(isIrregularDispatch({})).toBe(false);
    expect(isIrregularDispatch({ id: '1', platform: 'x' })).toBe(false);
  });

  it('channelData passes through untouched', () => {
    const d = createIrregularDispatch({
      platform: 'discord',
      channelId: 'ch-1',
      senderId: 'u-1',
      senderName: 'Test',
      text: 'Hi',
      channelData: { guildId: 'g-1', isDM: false },
    });

    expect(d.channelData).toEqual({ guildId: 'g-1', isDM: false });
  });

  it('allows overriding timestamp', () => {
    const ts = '2025-01-01T00:00:00.000Z';
    const d = createIrregularDispatch({
      platform: 'test',
      channelId: '1',
      senderId: '1',
      senderName: 'Test',
      text: 'Hi',
      timestamp: ts,
    });

    expect(d.timestamp).toBe(ts);
  });
});
