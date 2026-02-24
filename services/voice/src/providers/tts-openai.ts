import { logger } from '@bakerst/shared';
import type { TtsAdapter, TtsConfig } from './types.js';
import { TTS_DEFAULTS } from './types.js';

const log = logger.child({ module: 'tts-openai' });

/**
 * OpenAI TTS adapter.
 *
 * Posts to /v1/audio/speech and returns MP3 audio.
 */
export class OpenAITtsAdapter implements TtsAdapter {
  readonly provider = 'openai' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;

  constructor(config: TtsConfig) {
    const defaults = TTS_DEFAULTS.openai;
    this.baseUrl = config.baseUrl ?? defaults.baseUrl!;
    this.apiKey = config.apiKey ?? '';
    this.model = config.model ?? defaults.model!;
    this.voice = config.voice ?? defaults.voice!;

    if (!this.apiKey) {
      throw new Error('OpenAI TTS requires an API key');
    }
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<{ audio: Buffer; format: 'wav' | 'mp3' }> {
    const url = `${this.baseUrl}/v1/audio/speech`;

    log.info({ url, textLength: text.length, model: this.model, voice: this.voice }, 'sending text to OpenAI TTS');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: 'mp3',
      }),
      signal: signal ?? AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI TTS returned ${res.status}: ${body}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    log.info({ audioBytes: buffer.length }, 'OpenAI TTS audio received');
    return { audio: buffer, format: 'mp3' };
  }
}
