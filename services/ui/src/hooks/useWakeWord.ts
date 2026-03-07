import { useState, useCallback, useRef, useEffect } from 'react';

interface UseWakeWordReturn {
  isListening: boolean;
  isSupported: boolean;
  start: () => Promise<void>;
  stop: () => void;
  error: string | null;
}

export function useWakeWord(
  accessKey: string | undefined,
  keyword: string,
  onDetected: () => void,
): UseWakeWordReturn {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const porcupineRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processorRef = useRef<any>(null);
  const onDetectedRef = useRef(onDetected);
  useEffect(() => { onDetectedRef.current = onDetected; }, [onDetected]);

  useEffect(() => {
    // Check if we have an access key and browser supports AudioWorklet
    setIsSupported(!!accessKey && typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined');
  }, [accessKey]);

  const start = useCallback(async () => {
    if (!accessKey) {
      setError('No Porcupine access key configured');
      return;
    }
    try {
      const { PorcupineWorker } = await import('@picovoice/porcupine-web');
      const { WebVoiceProcessor } = await import('@picovoice/web-voice-processor');

      const porcupine = await PorcupineWorker.create(
        accessKey,
        [{ builtin: keyword as import('@picovoice/porcupine-web').BuiltInKeyword, sensitivity: 0.65 }],
        (detection: { index: number }) => {
          if (detection.index >= 0) {
            onDetectedRef.current();
          }
        },
        {},
      );
      porcupineRef.current = porcupine;

      await WebVoiceProcessor.subscribe(porcupine);
      processorRef.current = WebVoiceProcessor;
      setIsListening(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start wake word detection');
      setIsListening(false);
    }
  }, [accessKey, keyword]);

  const stop = useCallback(() => {
    if (porcupineRef.current && processorRef.current) {
      processorRef.current.unsubscribe(porcupineRef.current);
      porcupineRef.current.release();
      porcupineRef.current = null;
      processorRef.current = null;
    }
    setIsListening(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (porcupineRef.current && processorRef.current) {
        processorRef.current.unsubscribe(porcupineRef.current);
        porcupineRef.current.release();
      }
    };
  }, []);

  return { isListening, isSupported, start, stop, error };
}
