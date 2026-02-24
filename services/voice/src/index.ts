import express from 'express';
import multer from 'multer';
import { timingSafeEqual } from 'node:crypto';
import { logger } from '@bakerst/shared';
import { loadConfig, resolveProviderConfig } from './config.js';
import { handleVoiceChat } from './voice-handler.js';
import { createSttAdapter, createTtsAdapter, STT_DEFAULTS, TTS_DEFAULTS } from './providers/index.js';
import type { SttAdapter, TtsAdapter, VoiceProviderConfig } from './providers/index.js';

const log = logger.child({ module: 'voice' });

const config = loadConfig();

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Mask an API key for display: 'sk-abc...xyz' → 'sk...yz' */
function maskKey(key?: string): string | undefined {
  if (!key) return undefined;
  if (key.length <= 4) return '****';
  return key.slice(0, 2) + '...' + key.slice(-2);
}

// --- Adapter lifecycle ---

let currentStt: SttAdapter;
let currentTts: TtsAdapter;

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

// --- Express app ---

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

// GET /voice/providers — returns available providers and current config (keys masked)
app.get('/voice/providers', (_req, res) => {
  res.json({
    current: {
      stt: {
        provider: currentStt.provider,
      },
      tts: {
        provider: currentTts.provider,
      },
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
app.post('/voice/chat', upload.single('audio'), (req, res) => {
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

  // Capture adapter references at request start to avoid mid-request swaps
  const stt = currentStt;
  const tts = currentTts;

  // Create abort controller for client disconnect cleanup
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

// --- Startup ---

async function start() {
  await loadAdapters();

  app.listen(config.port, () => {
    log.info({ port: config.port }, 'voice service listening');
  });
}

start().catch((err) => {
  log.error({ err }, 'voice service failed to start');
  process.exit(1);
});
