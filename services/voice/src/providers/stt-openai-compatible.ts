import { logger } from '@bakerst/shared';
import type { SttAdapter, SttConfig } from './types.js';
import { STT_DEFAULTS } from './types.js';

const log = logger.child({ module: 'stt-openai-compatible' });

/**
 * OpenAI-compatible STT adapter.
 *
 * Works with both local Faster-Whisper (which exposes an OpenAI-compatible API)
 * and the actual OpenAI /v1/audio/transcriptions endpoint.
 */
export class OpenAICompatibleSttAdapter implements SttAdapter {
  readonly provider: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly language: string;

  constructor(config: SttConfig) {
    this.provider = config.provider;
    const defaults = STT_DEFAULTS[config.provider];
    this.baseUrl = config.baseUrl ?? defaults.baseUrl!;
    this.apiKey = config.apiKey;
    this.model = config.model ?? defaults.model!;
    this.language = config.language ?? defaults.language!;
  }

  async transcribe(audioBuffer: Buffer, mimeType: string, signal?: AbortSignal): Promise<string> {
    const url = `${this.baseUrl}/v1/audio/transcriptions`;

    const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('wav') ? 'wav' : 'ogg';

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', this.model);
    formData.append('response_format', 'json');
    if (this.language) {
      formData.append('language', this.language);
    }

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    log.info(
      { url, mimeType, audioBytes: audioBuffer.length, provider: this.provider, model: this.model },
      'sending audio to STT',
    );

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      signal: signal ?? AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`STT (${this.provider}) returned ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { text: string };
    log.info({ textLength: data.text.length, provider: this.provider }, 'STT transcription received');
    return data.text;
  }
}
