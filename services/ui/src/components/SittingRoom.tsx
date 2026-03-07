import { useState, useCallback } from 'react';
import { useWakeWord } from '../hooks/useWakeWord';
import { useVoiceChat, type VoiceState } from '../hooks/useVoiceChat';

interface SittingRoomProps {
  picovoiceKey?: string;
}

/** Mic icon for idle/push-to-talk state */
function MicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3z"
      />
    </svg>
  );
}

/** Stop/square icon for recording state */
function StopIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/** Spinner icon for processing state */
function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
      <circle cx="12" cy="12" r="10" strokeOpacity={0.25} />
      <path d="M12 2a10 10 0 0 1 9.95 9" strokeLinecap="round" />
    </svg>
  );
}

/** Minimize/close icon */
function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function stateLabel(voiceState: VoiceState, wakeListening: boolean, wakeSupported: boolean): string {
  switch (voiceState) {
    case 'recording':
      return 'Listening...';
    case 'processing':
      return 'Thinking...';
    default:
      if (wakeListening) return 'Waiting for wake word...';
      if (wakeSupported) return 'Wake word ready';
      return 'Push to talk';
  }
}

export function SittingRoom({ picovoiceKey }: SittingRoomProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');

  const { state: voiceState, startRecording, stopRecording } = useVoiceChat({
    onTranscript: (text) => setTranscript(text),
    onDelta: (text) => setResponse((prev) => prev + text),
    onToolCall: () => {},
    onToolResult: () => {},
    onDone: () => {},
    onError: (msg) => console.error('Voice error:', msg),
  });

  const handleWakeWord = useCallback(() => {
    if (voiceState === 'idle') {
      setIsExpanded(true);
      setTranscript('');
      setResponse('');
      startRecording();
    }
  }, [voiceState, startRecording]);

  const {
    isListening: wakeListening,
    isSupported: wakeSupported,
    start: startWakeWord,
    stop: stopWakeWord,
    error: wakeError,
  } = useWakeWord(picovoiceKey, 'Jarvis', handleWakeWord);

  const handleFabClick = useCallback(() => {
    if (voiceState === 'recording') {
      stopRecording();
      return;
    }
    if (voiceState === 'processing') {
      return; // can't interact while processing
    }
    // idle — start recording (push-to-talk)
    setIsExpanded(true);
    setTranscript('');
    setResponse('');
    startRecording();
  }, [voiceState, startRecording, stopRecording]);

  const handleToggleWake = useCallback(() => {
    if (wakeListening) {
      stopWakeWord();
    } else {
      startWakeWord();
    }
  }, [wakeListening, startWakeWord, stopWakeWord]);

  const handleClose = useCallback(() => {
    if (voiceState === 'recording') {
      stopRecording();
    }
    setIsExpanded(false);
  }, [voiceState, stopRecording]);

  // FAB button styles based on state
  const fabClasses = (() => {
    const base =
      'w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900';
    switch (voiceState) {
      case 'recording':
        return `${base} bg-red-600 hover:bg-red-700 text-white focus:ring-red-500 animate-pulse`;
      case 'processing':
        return `${base} bg-gray-700 text-gray-400 cursor-wait`;
      default:
        if (wakeListening) {
          return `${base} bg-green-600 hover:bg-green-700 text-white focus:ring-green-500`;
        }
        return `${base} bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-500`;
    }
  })();

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      {/* Expanded panel */}
      {isExpanded && (
        <div className="w-80 bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  voiceState === 'recording'
                    ? 'bg-red-500 animate-pulse'
                    : voiceState === 'processing'
                      ? 'bg-yellow-500 animate-pulse'
                      : wakeListening
                        ? 'bg-green-500 animate-pulse'
                        : 'bg-gray-500'
                }`}
              />
              <span className="text-sm text-gray-300">
                {stateLabel(voiceState, wakeListening, wakeSupported)}
              </span>
            </div>
            <button
              onClick={handleClose}
              className="p-1 rounded hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors"
              title="Close"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>

          {/* Content */}
          <div className="px-4 py-3 max-h-60 overflow-y-auto space-y-3">
            {transcript && (
              <div>
                <p className="text-xs text-gray-500 mb-1">You said:</p>
                <p className="text-sm text-gray-200">{transcript}</p>
              </div>
            )}
            {response && (
              <div>
                <p className="text-xs text-gray-500 mb-1">Response:</p>
                <p className="text-sm text-gray-200 whitespace-pre-wrap">{response}</p>
              </div>
            )}
            {!transcript && !response && voiceState === 'idle' && (
              <p className="text-sm text-gray-500 text-center py-2">
                {wakeSupported
                  ? 'Say the wake word or tap the mic to start.'
                  : 'Tap the mic button to start talking.'}
              </p>
            )}
          </div>

          {/* Wake word toggle (only if supported) */}
          {wakeSupported && voiceState === 'idle' && (
            <div className="px-4 py-2 border-t border-gray-800">
              <button
                onClick={handleToggleWake}
                className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
              >
                {wakeListening ? 'Disable wake word' : 'Enable wake word'}
              </button>
            </div>
          )}

          {/* Wake word error */}
          {wakeError && (
            <div className="px-4 py-2 border-t border-gray-800">
              <p className="text-xs text-red-400">{wakeError}</p>
            </div>
          )}
        </div>
      )}

      {/* Floating action button */}
      <button
        onClick={handleFabClick}
        className={fabClasses}
        title={
          voiceState === 'recording'
            ? 'Stop recording'
            : voiceState === 'processing'
              ? 'Processing...'
              : 'Start voice chat'
        }
      >
        {voiceState === 'recording' ? (
          <StopIcon className="w-6 h-6" />
        ) : voiceState === 'processing' ? (
          <SpinnerIcon className="w-6 h-6 animate-spin" />
        ) : wakeListening ? (
          <div className="relative">
            <MicIcon className="w-6 h-6" />
            <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-green-400 rounded-full animate-pulse" />
          </div>
        ) : (
          <MicIcon className="w-6 h-6" />
        )}
      </button>
    </div>
  );
}
