import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getConversations, getConversationMessages } from '../api/client';
import { ConversationList } from '../components/conversations/ConversationList';
import { ConversationDetail } from '../components/conversations/ConversationDetail';
import type { Conversation, Message } from '../api/types';

export function ConversationsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getConversations()
      .then(setConversations)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (id) {
      getConversationMessages(id)
        .then(({ conversation, messages: msgs }) => {
          setSelectedConv(conversation);
          setMessages(msgs);
        })
        .catch(() => {});
    } else {
      setSelectedConv(null);
      setMessages([]);
    }
  }, [id]);

  function handleSelect(convId: string) {
    navigate(`/conversations/${convId}`);
  }

  return (
    <div className="flex h-full">
      <div className="w-80 border-r border-gray-800 overflow-y-auto">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-medium text-white">Conversations</h2>
        </div>
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-gray-500">Loading...</p>
          </div>
        ) : (
          <ConversationList
            conversations={conversations}
            selectedId={id}
            onSelect={handleSelect}
          />
        )}
      </div>

      {selectedConv ? (
        <ConversationDetail
          messages={messages}
          title={selectedConv.title || 'Untitled'}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-gray-600">Select a conversation</p>
        </div>
      )}
    </div>
  );
}
