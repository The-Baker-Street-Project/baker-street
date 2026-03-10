import type { Response } from 'express';
import { logger } from '@bakerst/shared';
import { chatStream } from './brain-client.js';
import type { SttAdapter, TtsAdapter } from './providers/index.js';

const log = logger.child({ module: 'voice-handler' });

/** SSE event types sent to the browser. */
export type VoiceSSEEvent =
  | { type: 'transcript'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'thinking'; tool: string }
  | { type: 'tool_result'; tool: string }
  | { type: 'audio'; data: string; format: 'wav' | 'mp3' }
  | { type: 'done'; conversationId: string }
  | { type: 'error'; message: string };

/** Write a single SSE event to the response. */
function sendSSE(res: Response, data: VoiceSSEEvent): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Main voice orchestration handler.
 *
 * 1. Transcribe audio via STT adapter
 * 2. Stream transcript through Brain's chat/stream API
 * 3. Relay Brain's SSE events to the browser
 * 4. Synthesize the full response via TTS adapter
 * 5. Send the base64-encoded audio to the browser
 */
export async function handleVoiceChat(
  stt: SttAdapter,
  tts: TtsAdapter,
  brainUrl: string,
  authToken: string,
  audioBuffer: Buffer,
  mimeType: string,
  conversationId: string | undefined,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    // Step 1: Transcribe audio
    log.info({ audioBytes: audioBuffer.length, mimeType, sttProvider: stt.provider }, 'starting voice pipeline');
    const transcript = await stt.transcribe(audioBuffer, mimeType, signal);

    if (!transcript.trim()) {
      sendSSE(res, { type: 'error', message: 'No speech detected in audio' });
      res.end();
      return;
    }

    sendSSE(res, { type: 'transcript', text: transcript });

    // Step 2 & 3: Stream through Brain and relay events
    let fullText = '';
    let resolvedConversationId = conversationId ?? '';

    for await (const event of chatStream(brainUrl, authToken, transcript, conversationId, signal)) {
      if (event.type === 'delta' && event.text) {
        fullText += event.text;
        sendSSE(res, { type: 'delta', text: event.text });
      } else if (event.type === 'thinking' && event.tool) {
        sendSSE(res, { type: 'thinking', tool: event.tool });
      } else if (event.type === 'tool_result' && event.tool) {
        sendSSE(res, { type: 'tool_result', tool: event.tool });
      } else if (event.type === 'done') {
        if (event.conversationId) {
          resolvedConversationId = event.conversationId;
        }
      } else if (event.type === 'error') {
        sendSSE(res, { type: 'error', message: event.message ?? 'stream error from brain' });
        res.end();
        return;
      }
    }

    // Step 4: Synthesize TTS audio from the full response
    if (fullText.trim()) {
      try {
        const ttsResult = await tts.synthesize(fullText, signal);
        const base64 = ttsResult.audio.toString('base64');
        sendSSE(res, { type: 'audio', data: base64, format: ttsResult.format });
      } catch (ttsErr) {
        // TTS failure is non-fatal — the text response was already streamed
        log.error({ err: ttsErr }, 'TTS synthesis failed (non-fatal)');
        sendSSE(res, { type: 'error', message: 'TTS synthesis failed — text response still available' });
      }
    }

    // Step 5: Done
    sendSSE(res, { type: 'done', conversationId: resolvedConversationId });
    res.end();
  } catch (err) {
    log.error({ err }, 'voice pipeline error');
    try {
      sendSSE(res, { type: 'error', message: err instanceof Error ? err.message : 'unknown error' });
    } catch {
      // Response may already be closed
    }
    res.end();
  }
}
