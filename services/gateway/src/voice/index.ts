import express from 'express';
import multer from 'multer';
import { timingSafeEqual } from 'node:crypto';
import { logger } from '@bakerst/shared';
import { loadConfig as loadVoiceConfig, resolveProviderConfig } from './config.js';
import { handleVoiceChat } from './voice-handler.js';
import { createSttAdapter, createTtsAdapter, STT_DEFAULTS, TTS_DEFAULTS } from './providers/index.js';
import type { SttAdapter, TtsAdapter, VoiceProviderConfig } from './providers/index.js';

const log = logger.child({ module: 'voice' });

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

let currentStt: SttAdapter;
let currentTts: TtsAdapter;

/**
 * Check if voice feature is configured (any STT/TTS env vars or provider keys present).
 */
export function isVoiceEnabled(): boolean {
  return !!(
    process.env.STT_API_KEY ||
    process.env.TTS_API_KEY ||
    process.env.STT_PROVIDER ||
    process.env.TTS_PROVIDER ||
    process.env.FEATURE_VOICE === 'true'
  );
}

/**
 * Start the voice HTTP server on its own port.
 * Returns the Express app for testing, or undefined if voice is not configured.
 */
export async function startVoiceServer(): Promise<express.Express | undefined> {
  if (!isVoiceEnabled()) {
    log.info('voice feature not configured — skipping');
    return undefined;
  }

  const config = loadVoiceConfig();

  /** Fetch voice config from Brain's DB and create adapters. */
  async function loadAdapters(): Promise<void> {
    let dbConfig: Partial<VoiceProviderConfig> | undefined;

    try {
      const res = await fetch(`${config.brainUrl}/voice-config/raw`, {
        headers: config.authToken ? { 'Authorization': `Bearer ${config.authToken}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        dbConfig = (await res.json()) as Partial<VoiceProviderConfig>;
      } else {
        log.info({ status: res.status }, 'no voice config in brain DB — using defaults');
      }
    } catch (err) {
      log.warn({ err }, 'failed to fetch voice config from brain — using defaults/env');
    }

    const providerConfig = resolveProviderConfig(dbConfig);
    currentStt = createSttAdapter(providerConfig.stt);
    currentTts = createTtsAdapter(providerConfig.tts);

    log.info(
      { stt: currentStt.provider, tts: currentTts.provider },
      'voice adapters initialized',
    );
  }

  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

  // Health check — no auth required
  app.get('/ping', (_req, res) => {
    res.json({ status: 'ok', service: 'voice' });
  });

  // Auth middleware for all routes except /ping
  app.use((req, res, next) => {
    if (req.path === '/ping') return next();

    if (!config.authToken) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    if (!safeCompare(token, config.authToken)) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    next();
  });

  // GET /voice/providers — returns available providers and current config
  app.get('/voice/providers', (_req, res) => {
    res.json({
      current: {
        stt: { provider: currentStt.provider },
        tts: { provider: currentTts.provider },
      },
      available: {
        stt: Object.keys(STT_DEFAULTS),
        tts: Object.keys(TTS_DEFAULTS),
      },
    });
  });

  // POST /voice/reload — re-fetch config from brain, recreate adapters
  app.post('/voice/reload', async (_req, res) => {
    try {
      await loadAdapters();
      res.json({ ok: true, stt: currentStt.provider, tts: currentTts.provider });
    } catch (err) {
      log.error({ err }, 'failed to reload voice adapters');
      res.status(500).json({ error: 'failed to reload adapters' });
    }
  });

  // Main voice chat endpoint
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- multer v4 types clash with hoisted @types/express v5
  app.post('/voice/chat', upload.single('audio') as any, (req: express.Request, res: express.Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Missing audio file — expected multipart field "audio"' });
      return;
    }

    const mimeType = file.mimetype || 'audio/webm';
    const conversationId = (req.body?.conversationId as string) || undefined;

    log.info(
      { mimeType, audioBytes: file.size, conversationId },
      'voice chat request received',
    );

    const stt = currentStt;
    const tts = currentTts;

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        controller.abort();
      }
    });

    handleVoiceChat(stt, tts, config.brainUrl, config.authToken, file.buffer, mimeType, conversationId, res, controller.signal).catch((err) => {
      log.error({ err }, 'unhandled voice handler error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal server error' });
      }
    });
  });

  // Initialize adapters and start listening
  await loadAdapters();

  const voicePort = parseInt(process.env.VOICE_PORT ?? '3002', 10);
  app.listen(voicePort, () => {
    log.info({ port: voicePort }, 'voice server listening');
  });

  return app;
}
