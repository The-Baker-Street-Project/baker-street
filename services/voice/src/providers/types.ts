/** Provider adapter interfaces and config types for STT/TTS. */

// --- Adapter interfaces ---

export interface SttAdapter {
  readonly provider: string;
  transcribe(audioBuffer: Buffer, mimeType: string, signal?: AbortSignal): Promise<string>;
}

export interface TtsAdapter {
  readonly provider: string;
  synthesize(text: string, signal?: AbortSignal): Promise<{ audio: Buffer; format: 'wav' | 'mp3' }>;
}

// --- Config types ---

export type SttProvider = 'whisper' | 'openai';
export type TtsProvider = 'coqui' | 'openai' | 'elevenlabs';

export interface SttConfig {
  provider: SttProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  language?: string;
}

export interface TtsConfig {
  provider: TtsProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  language?: string;
}

export interface VoiceProviderConfig {
  stt: SttConfig;
  tts: TtsConfig;
}

// --- Provider defaults ---

export const STT_DEFAULTS: Record<SttProvider, Omit<SttConfig, 'provider'>> = {
  whisper: {
    baseUrl: 'http://host.docker.internal:8083',
    model: 'base',
    language: 'en',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    model: 'whisper-1',
    language: 'en',
  },
};

export const TTS_DEFAULTS: Record<TtsProvider, Omit<TtsConfig, 'provider'>> = {
  coqui: {
    baseUrl: 'http://host.docker.internal:8084',
    language: 'en',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    model: 'tts-1',
    voice: 'alloy',
  },
  elevenlabs: {
    baseUrl: 'https://api.elevenlabs.io',
    model: 'eleven_multilingual_v2',
    voice: '21m00Tcm4TlvDq8ikWAM', // Rachel
  },
};
