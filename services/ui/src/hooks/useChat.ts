import { useState, useRef, useCallback } from 'react';
import { chatStream } from '../api/stream';
import { getConversationMessages } from '../api/client';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

export function useChat(initialConversationId?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const abortRef = useRef<AbortController | null>(null);

  const loadConversation = useCallback(async (id: string) => {
    const { messages: msgs } = await getConversationMessages(id);
    setConversationId(id);
    setMessages(msgs.map((m) => ({ role: m.role, content: m.content })));
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = { role: 'user', content: text };
      setMessages((prev) => [...prev, userMsg]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const assistantMsg: ChatMessage = { role: 'assistant', content: '', toolCalls: [] };
      setMessages((prev) => [...prev, assistantMsg]);

      let currentToolCallIndex = -1;

      try {
        for await (const event of chatStream(text, conversationId, controller.signal)) {
          if (event.type === 'delta') {
            setMessages((prev) => {
              const last = { ...prev[prev.length - 1] };
              last.content += event.text ?? '';
              return [...prev.slice(0, -1), last];
            });
          } else if (event.type === 'thinking') {
            const toolCall: ToolCall = { name: event.tool ?? '', input: event.input ?? {} };
            setMessages((prev) => {
              const last = { ...prev[prev.length - 1] };
              const toolCalls = [...(last.toolCalls ?? []), toolCall];
              currentToolCallIndex = toolCalls.length - 1;
              return [...prev.slice(0, -1), { ...last, toolCalls }];
            });
          } else if (event.type === 'tool_result') {
            if (currentToolCallIndex >= 0) {
              const idx = currentToolCallIndex;
              setMessages((prev) => {
                const last = { ...prev[prev.length - 1] };
                const toolCalls = [...(last.toolCalls ?? [])];
                if (toolCalls[idx]) {
                  toolCalls[idx] = { ...toolCalls[idx], result: event.summary ?? '' };
                }
                return [...prev.slice(0, -1), { ...last, toolCalls }];
              });
              currentToolCallIndex = -1;
            }
          } else if (event.type === 'error') {
            setMessages((prev) => {
              const last = { ...prev[prev.length - 1] };
              last.content += (last.content ? '\n\n' : '') + `[Error: ${event.message ?? 'unknown error'}]`;
              return [...prev.slice(0, -1), last];
            });
          } else if (event.type === 'done') {
            if (event.conversationId) {
              setConversationId(event.conversationId);
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setMessages((prev) => {
            const last = { ...prev[prev.length - 1] };
            last.content += '\n\n[Error: connection lost]';
            return [...prev.slice(0, -1), last];
          });
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [conversationId],
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const newChat = useCallback(() => {
    setMessages([]);
    setConversationId(undefined);
  }, []);

  return { messages, isStreaming, conversationId, sendMessage, stopStreaming, loadConversation, newChat, setMessages, setConversationId };
}

