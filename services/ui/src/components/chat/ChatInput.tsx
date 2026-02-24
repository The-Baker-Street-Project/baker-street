import { useState, useRef, type KeyboardEvent } from 'react';
import type { VoiceState } from '../../hooks/useVoiceChat';

interface ChatInputProps {
  onSend: (message: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  voiceState: VoiceState;
  onVoiceStart: () => void;
  onVoiceStop: () => void;
}

export function ChatInput({ onSend, onStop, isStreaming, voiceState, onVoiceStart, onVoiceStop }: ChatInputProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isBusy = isStreaming || voiceState !== 'idle';

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || isBusy) return;
    onSend(trimmed);
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleInput() {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  }

  return (
    <div className="border-t border-gray-800 p-4">
      <div className="flex gap-2 max-w-3xl mx-auto">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={
            voiceState === 'recording'
              ? 'Recording...'
              : voiceState === 'processing'
                ? 'Processing voice...'
                : 'Send a message...'
          }
          rows={1}
          disabled={isBusy}
          className="flex-1 resize-none rounded-lg bg-gray-800 border border-gray-700 px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
        />
        {voiceState === 'recording' ? (
          <button
            onClick={onVoiceStop}
            className="px-3 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
            title="Stop recording"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 animate-pulse">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : voiceState === 'processing' ? (
          <button
            disabled
            className="px-3 py-2 rounded-lg bg-gray-700 text-gray-400 text-sm font-medium"
            title="Processing voice..."
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 animate-spin">
              <circle cx="12" cy="12" r="10" strokeOpacity={0.25} />
              <path d="M12 2a10 10 0 0 1 9.95 9" strokeLinecap="round" />
            </svg>
          </button>
        ) : isStreaming ? (
          <button
            onClick={onStop}
            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
          >
            Stop
          </button>
        ) : (
          <>
            <button
              onClick={onVoiceStart}
              className="px-3 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white text-sm font-medium transition-colors"
              title="Voice input"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3z" />
              </svg>
            </button>
            <button
              onClick={submit}
              disabled={!text.trim()}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              Send
            </button>
          </>
        )}
      </div>
    </div>
  );
}
