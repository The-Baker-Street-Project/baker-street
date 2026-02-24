import { useState, useRef, useCallback } from 'react';
import { TOKEN_KEY } from '../api/constants';

export type VoiceState = 'idle' | 'recording' | 'processing';

export interface UseVoiceChatOptions {
  conversationId?: string;
  onTranscript: (text: string) => void;
  onDelta: (text: string) => void;
  onToolCall: (tool: string, input: Record<string, unknown>) => void;
  onToolResult: (summary: string) => void;
  onDone: (conversationId: string) => void;
  onError: (message: string) => void;
}

export function useVoiceChat(options: UseVoiceChatOptions) {
  const [state, setState] = useState<VoiceState>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const processAudio = useCallback(
    async (audioBlob: Blob) => {
      setState('processing');

      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');
      if (options.conversationId) {
        formData.append('conversationId', options.conversationId);
      }

      const headers: Record<string, string> = {};
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      try {
        const res = await fetch('/voice/chat', {
          method: 'POST',
          headers,
          body: formData,
        });

        if (res.status === 401) {
          window.dispatchEvent(
            new CustomEvent('bakerst:unauthorized', { detail: { status: 401 } }),
          );
          throw new Error('Unauthorized');
        }

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Voice error ${res.status}: ${body}`);
        }

        if (!res.body) {
          throw new Error('Response body is null');
        }

        // Parse SSE stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6);
              try {
                const event = JSON.parse(data);
                switch (event.type) {
                  case 'transcript':
                    options.onTranscript(event.text);
                    break;
                  case 'delta':
                    options.onDelta(event.text);
                    break;
                  case 'thinking':
                    options.onToolCall(event.tool, {});
                    break;
                  case 'tool_result':
                    options.onToolResult(event.tool ?? '');
                    break;
                  case 'audio': {
                    // Use format from SSE event to set correct MIME type
                    const mime = event.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
                    try {
                      const audio = new Audio(`data:${mime};base64,${event.data}`);
                      audio.play().catch(() => {
                        // Autoplay may be blocked
                      });
                    } catch {
                      // Audio playback error — non-fatal
                    }
                    break;
                  }
                  case 'done':
                    options.onDone(event.conversationId ?? '');
                    break;
                  case 'error':
                    options.onError(event.message ?? 'unknown error');
                    break;
                }
              } catch {
                // skip malformed SSE events
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        options.onError(err instanceof Error ? err.message : 'unknown error');
      } finally {
        setState('idle');
      }
    },
    [options],
  );

  const startRecording = useCallback(async () => {
    try {
      // Check for available audio input devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasAudioInput = devices.some((d) => d.kind === 'audioinput');
      if (!hasAudioInput) {
        options.onError('No microphone found. Connect a microphone and reload the page.');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        // Stop all mic tracks
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        chunksRef.current = [];

        if (blob.size > 0) {
          processAudio(blob);
        } else {
          setState('idle');
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setState('recording');
    } catch (err) {
      let message = 'Failed to access microphone';
      if (err instanceof DOMException) {
        switch (err.name) {
          case 'NotFoundError':
            message = 'No microphone found. Check that a mic is connected and allowed in Windows Settings > Privacy > Microphone.';
            break;
          case 'NotAllowedError':
            message = 'Microphone access denied. Allow microphone access in your browser when prompted.';
            break;
          case 'NotReadableError':
            message = 'Microphone is busy. Close other apps using the mic and try again.';
            break;
          default:
            message = err.message;
        }
      } else if (err instanceof Error) {
        message = err.message;
      }
      options.onError(message);
    }
  }, [processAudio, options]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      mediaRecorderRef.current = null;
    }
  }, []);

  return { state, startRecording, stopRecording };
}
