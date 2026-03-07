import { describe, it, expect } from 'vitest';
import { STT_DEFAULTS, TTS_DEFAULTS } from '../providers/types.js';

describe('provider defaults', () => {
  it('has whisper STT defaults with localhost URL', () => {
    expect(STT_DEFAULTS.whisper).toBeDefined();
    expect(STT_DEFAULTS.whisper.baseUrl).toContain('8083');
    expect(STT_DEFAULTS.whisper.model).toBe('base');
  });

  it('has openai STT defaults', () => {
    expect(STT_DEFAULTS.openai).toBeDefined();
    expect(STT_DEFAULTS.openai.baseUrl).toContain('openai.com');
  });

  it('has coqui TTS defaults with localhost URL', () => {
    expect(TTS_DEFAULTS.coqui).toBeDefined();
    expect(TTS_DEFAULTS.coqui.baseUrl).toContain('8084');
  });

  it('has openai TTS defaults', () => {
    expect(TTS_DEFAULTS.openai).toBeDefined();
    expect(TTS_DEFAULTS.openai.model).toBe('tts-1');
  });

  it('has elevenlabs TTS defaults', () => {
    expect(TTS_DEFAULTS.elevenlabs).toBeDefined();
    expect(TTS_DEFAULTS.elevenlabs.baseUrl).toContain('elevenlabs');
  });
});
