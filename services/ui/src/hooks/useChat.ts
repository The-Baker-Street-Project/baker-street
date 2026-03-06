import { useState, useRef, useCallback, useEffect } from 'react';
import { chatStream } from '../api/stream';
import { getConversationMessages } from '../api/client';
import { matchSlashCommand } from './useSlashCommands.js';

const STORAGE_MESSAGES = 'bakerst_chat_messages';
const STORAGE_CONVERSATION = 'bakerst_active_conversation';

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

function loadStoredMessages(): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_MESSAGES);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function loadStoredConversation(): string | undefined {
  return sessionStorage.getItem(STORAGE_CONVERSATION) ?? undefined;
}

export function useChat(initialConversationId?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    initialConversationId ? [] : loadStoredMessages(),
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(
    initialConversationId ?? loadStoredConversation(),
  );
  const abortRef = useRef<AbortController | null>(null);

  // Persist messages and conversationId to sessionStorage on change
  useEffect(() => {
    sessionStorage.setItem(STORAGE_MESSAGES, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    if (conversationId) {
      sessionStorage.setItem(STORAGE_CONVERSATION, conversationId);
    } else {
      sessionStorage.removeItem(STORAGE_CONVERSATION);
    }
  }, [conversationId]);

  const loadConversation = useCallback(async (id: string) => {
    const { conversation, messages: msgs } = await getConversationMessages(id);
    setConversationId(id);
    setMessages(msgs.map((m) => ({ role: m.role, content: m.content })));
    return conversation;
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const cmd = matchSlashCommand(text);
      let apiText = text;

      if (cmd === '/save-this') {
        // Find the last user message to save
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        if (!lastUserMsg) return;
        const content = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '';
        apiText = `Please save this prompt for later: "${content}"`;
      } else if (cmd === '/saved-prompts') {
        apiText = 'Show me my saved prompts';
      }

      const userMsg: ChatMessage = { role: 'user', content: text };
      setMessages((prev) => [...prev, userMsg]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const assistantMsg: ChatMessage = { role: 'assistant', content: '', toolCalls: [] };
      setMessages((prev) => [...prev, assistantMsg]);

      let currentToolCallIndex = -1;

      try {
        for await (const event of chatStream(apiText, conversationId, controller.signal)) {
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
    [conversationId, messages],
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

