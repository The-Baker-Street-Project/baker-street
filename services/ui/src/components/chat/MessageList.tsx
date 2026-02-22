import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import { StreamingIndicator } from './StreamingIndicator';
import { useAgentName } from '../../hooks/useAgentName';

interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
}

export function MessageList({ messages, isStreaming }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const agentName = useAgentName();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-semibold text-gray-400 mb-2">{agentName}</h2>
          <p className="text-gray-600">Send a message to start a conversation</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-4">
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        {isStreaming && messages[messages.length - 1]?.content === '' && (
          <StreamingIndicator />
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
