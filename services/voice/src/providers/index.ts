import { logger } from '@bakerst/shared';
import type { SttAdapter, TtsAdapter, SttConfig, TtsConfig } from './types.js';
import { OpenAICompatibleSttAdapter } from './stt-openai-compatible.js';
import { CoquiTtsAdapter } from './tts-coqui.js';
import { OpenAITtsAdapter } from './tts-openai.js';
import { ElevenLabsTtsAdapter } from './tts-elevenlabs.js';

export type { SttAdapter, TtsAdapter, SttConfig, TtsConfig, VoiceProviderConfig, SttProvider, TtsProvider } from './types.js';
export { STT_DEFAULTS, TTS_DEFAULTS } from './types.js';

const log = logger.child({ module: 'voice-providers' });

/** Create an STT adapter from config. Both 'whisper' and 'openai' use the same OpenAI-compatible API. */
export function createSttAdapter(config: SttConfig): SttAdapter {
  log.info({ provider: config.provider, baseUrl: config.baseUrl, model: config.model }, 'creating STT adapter');
  return new OpenAICompatibleSttAdapter(config);
}

/** Create a TTS adapter from config. Each provider has a different API. */
export function createTtsAdapter(config: TtsConfig): TtsAdapter {
  log.info({ provider: config.provider, baseUrl: config.baseUrl, model: config.model }, 'creating TTS adapter');

  switch (config.provider) {
    case 'coqui':
      return new CoquiTtsAdapter(config);
    case 'openai':
      return new OpenAITtsAdapter(config);
    case 'elevenlabs':
      return new ElevenLabsTtsAdapter(config);
    default:
      throw new Error(`Unknown TTS provider: ${config.provider}`);
  }
}
