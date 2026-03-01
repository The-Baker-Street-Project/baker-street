import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useChat } from '../hooks/useChat';
import { useVoiceChat } from '../hooks/useVoiceChat';
import { MessageList } from '../components/chat/MessageList';
import { ChatInput } from '../components/chat/ChatInput';
import { getConversations } from '../api/client';
import type { Conversation } from '../api/types';

export function ChatPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    messages, isStreaming, conversationId,
    sendMessage, stopStreaming, loadConversation, newChat,
    setMessages, setConversationId,
  } = useChat(id);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const voice = useVoiceChat({
    conversationId,
    onTranscript: (text) => {
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: text },
        { role: 'assistant', content: '', toolCalls: [] },
      ]);
    },
    onDelta: (text) => {
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const last = { ...prev[prev.length - 1] };
        last.content += text;
        return [...prev.slice(0, -1), last];
      });
    },
    onToolCall: (tool, input) => {
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const last = { ...prev[prev.length - 1] };
        const toolCalls = [...(last.toolCalls ?? []), { name: tool, input }];
        return [...prev.slice(0, -1), { ...last, toolCalls }];
      });
    },
    onToolResult: (summary) => {
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const last = { ...prev[prev.length - 1] };
        const toolCalls = [...(last.toolCalls ?? [])];
        const lastIdx = toolCalls.length - 1;
        if (lastIdx >= 0) {
          toolCalls[lastIdx] = { ...toolCalls[lastIdx], result: summary };
        }
        return [...prev.slice(0, -1), { ...last, toolCalls }];
      });
    },
    onDone: (convId) => {
      if (convId) setConversationId(convId);
    },
    onError: (message) => {
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const last = { ...prev[prev.length - 1] };
        last.content += (last.content ? '\n\n' : '') + `[Error: ${message}]`;
        return [...prev.slice(0, -1), last];
      });
    },
  });

  useEffect(() => {
    if (id && id !== conversationId) {
      loadConversation(id);
    }
  }, [id, conversationId, loadConversation]);

  useEffect(() => {
    if (conversationId && !id) {
      navigate(`/chat/${conversationId}`, { replace: true });
    }
  }, [conversationId, id, navigate]);

  // Restore last active conversation when navigating to /chat without an ID
  useEffect(() => {
    if (!id && !conversationId && messages.length === 0) {
      const savedId = sessionStorage.getItem('bakerst_active_conversation');
      if (savedId) {
        loadConversation(savedId).catch(() => {
          sessionStorage.removeItem('bakerst_active_conversation');
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (showHistory) {
      getConversations().then(setConversations).catch(() => {});
    }
  }, [showHistory]);

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              History
            </button>
          </div>
          <button
            onClick={() => {
              newChat();
              navigate('/chat', { replace: true });
            }}
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            New Chat
          </button>
        </div>
        <MessageList messages={messages} isStreaming={isStreaming || voice.state === 'processing'} />
        <ChatInput
          onSend={sendMessage}
          onStop={stopStreaming}
          isStreaming={isStreaming}
          voiceState={voice.state}
          onVoiceStart={voice.startRecording}
          onVoiceStop={voice.stopRecording}
        />
      </div>

      {showHistory && (
        <div className="w-64 border-l border-gray-800 overflow-y-auto bg-gray-900/50">
          <div className="p-3">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Recent</h3>
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  navigate(`/chat/${c.id}`);
                  setShowHistory(false);
                }}
                className={`block w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors ${
                  c.id === conversationId
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
                }`}
              >
                {c.title || 'Untitled'}
              </button>
            ))}
            {conversations.length === 0 && (
              <p className="text-xs text-gray-600 px-3">No conversations yet</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
