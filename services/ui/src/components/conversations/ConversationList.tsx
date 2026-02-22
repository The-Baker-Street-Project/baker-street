import type { Conversation } from '../../api/types';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

export function ConversationList({ conversations, selectedId, onSelect }: ConversationListProps) {
  if (conversations.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-600">No conversations yet</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-800/50">
      {conversations.map((c) => (
        <button
          key={c.id}
          onClick={() => onSelect(c.id)}
          className={`block w-full text-left px-4 py-3 transition-colors ${
            c.id === selectedId ? 'bg-gray-800/50' : 'hover:bg-gray-800/30'
          }`}
        >
          <div className="text-sm text-gray-200 truncate">{c.title || 'Untitled'}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-gray-500">{new Date(c.updated_at).toLocaleDateString()}</span>
            <span className="text-xs text-gray-600">{c.message_count} messages</span>
          </div>
        </button>
      ))}
    </div>
  );
}
