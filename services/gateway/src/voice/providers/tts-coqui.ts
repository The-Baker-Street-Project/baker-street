import { logger } from '@bakerst/shared';
import type { TtsAdapter, TtsConfig } from './types.js';
import { TTS_DEFAULTS } from './types.js';

const log = logger.child({ module: 'tts-coqui' });

/**
 * Coqui/XTTS TTS adapter.
 *
 * Sends a JSON request to /api/tts and returns raw WAV audio bytes.
 */
export class CoquiTtsAdapter implements TtsAdapter {
  readonly provider = 'coqui' as const;
  private readonly baseUrl: string;
  private readonly language: string;

  constructor(config: TtsConfig) {
    const defaults = TTS_DEFAULTS.coqui;
    this.baseUrl = config.baseUrl ?? defaults.baseUrl!;
    this.language = config.language ?? defaults.language!;
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<{ audio: Buffer; format: 'wav' | 'mp3' }> {
    const url = `${this.baseUrl}/api/tts`;

    log.info({ url, textLength: text.length }, 'sending text to Coqui TTS');

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language: this.language }),
      signal: signal ?? AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Coqui TTS returned ${res.status}: ${body}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    log.info({ audioBytes: buffer.length }, 'Coqui TTS audio received');
    return { audio: buffer, format: 'wav' };
  }
}
