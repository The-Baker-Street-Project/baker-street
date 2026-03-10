import { logger } from '@bakerst/shared';
import type { TtsAdapter, TtsConfig } from './types.js';
import { TTS_DEFAULTS } from './types.js';

const log = logger.child({ module: 'tts-elevenlabs' });

/**
 * ElevenLabs TTS adapter.
 *
 * Posts to /v1/text-to-speech/{voice_id} and returns MP3 audio.
 */
export class ElevenLabsTtsAdapter implements TtsAdapter {
  readonly provider = 'elevenlabs' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;

  constructor(config: TtsConfig) {
    const defaults = TTS_DEFAULTS.elevenlabs;
    this.baseUrl = config.baseUrl ?? defaults.baseUrl!;
    this.apiKey = config.apiKey ?? '';
    this.model = config.model ?? defaults.model!;
    this.voice = config.voice ?? defaults.voice!;

    if (!this.apiKey) {
      throw new Error('ElevenLabs TTS requires an API key');
    }
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<{ audio: Buffer; format: 'wav' | 'mp3' }> {
    const url = `${this.baseUrl}/v1/text-to-speech/${this.voice}`;

    log.info({ url, textLength: text.length, model: this.model, voice: this.voice }, 'sending text to ElevenLabs TTS');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': this.apiKey,
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: this.model,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
      signal: signal ?? AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ElevenLabs TTS returned ${res.status}: ${body}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    log.info({ audioBytes: buffer.length }, 'ElevenLabs TTS audio received');
    return { audio: buffer, format: 'mp3' };
  }
}
