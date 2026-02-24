import { logger } from '@bakerst/shared';
import type { VoiceProviderConfig, SttConfig, TtsConfig, SttProvider, TtsProvider } from './providers/index.js';
import { STT_DEFAULTS, TTS_DEFAULTS } from './providers/index.js';

const log = logger.child({ module: 'voice-config' });

export interface VoiceConfig {
  port: number;
  brainUrl: string;
  authToken: string;
}

export function loadConfig(): VoiceConfig {
  const port = parseInt(process.env.PORT ?? '3001', 10);
  const brainUrl = process.env.BRAIN_URL ?? 'http://brain.bakerst.svc.cluster.local:3000';
  const authToken = process.env.AUTH_TOKEN ?? '';

  if (!authToken) {
    log.warn('AUTH_TOKEN not set — voice service running in dev mode (no auth enforcement)');
  }

  log.info({ port, brainUrl, hasAuth: !!authToken }, 'voice config loaded');
  return { port, brainUrl, authToken };
}

/**
 * Resolve the full provider config by merging: env vars > DB config > provider defaults.
 *
 * @param dbConfig - Config fetched from Brain's /voice-config/raw endpoint (may be empty on first run)
 */
export function resolveProviderConfig(dbConfig?: Partial<VoiceProviderConfig>): VoiceProviderConfig {
  const sttProvider = (process.env.STT_PROVIDER ?? dbConfig?.stt?.provider ?? 'whisper') as SttProvider;
  const sttDefaults = STT_DEFAULTS[sttProvider] ?? STT_DEFAULTS.whisper;

  const stt: SttConfig = {
    provider: sttProvider,
    baseUrl: process.env.STT_BASE_URL ?? process.env.WHISPER_URL ?? dbConfig?.stt?.baseUrl ?? sttDefaults.baseUrl,
    apiKey: process.env.STT_API_KEY ?? dbConfig?.stt?.apiKey,
    model: process.env.STT_MODEL ?? dbConfig?.stt?.model ?? sttDefaults.model,
    language: process.env.STT_LANGUAGE ?? dbConfig?.stt?.language ?? sttDefaults.language,
  };

  const ttsProvider = (process.env.TTS_PROVIDER ?? dbConfig?.tts?.provider ?? 'coqui') as TtsProvider;
  const ttsDefaults = TTS_DEFAULTS[ttsProvider] ?? TTS_DEFAULTS.coqui;

  const tts: TtsConfig = {
    provider: ttsProvider,
    baseUrl: process.env.TTS_BASE_URL ?? process.env.TTS_URL ?? dbConfig?.tts?.baseUrl ?? ttsDefaults.baseUrl,
    apiKey: process.env.TTS_API_KEY ?? dbConfig?.tts?.apiKey,
    model: process.env.TTS_MODEL ?? dbConfig?.tts?.model ?? ttsDefaults.model,
    voice: process.env.TTS_VOICE ?? dbConfig?.tts?.voice ?? ttsDefaults.voice,
    language: process.env.TTS_LANGUAGE ?? dbConfig?.tts?.language ?? ttsDefaults.language,
  };

  log.info(
    {
      sttProvider: stt.provider,
      sttBaseUrl: stt.baseUrl,
      sttModel: stt.model,
      ttsProvider: tts.provider,
      ttsBaseUrl: tts.baseUrl,
      ttsModel: tts.model,
      ttsVoice: tts.voice,
    },
    'provider config resolved',
  );

  return { stt, tts };
}
