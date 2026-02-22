import type { Message } from '../../api/types';

interface ConversationDetailProps {
  messages: Message[];
  title: string;
}

export function ConversationDetail({ messages, title }: ConversationDetailProps) {
  return (
    <div className="flex-1 flex flex-col">
      <div className="px-4 py-3 border-b border-gray-800">
        <h3 className="text-sm font-medium text-white truncate">{title}</h3>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-100'
                }`}
              >
                <div className="text-sm whitespace-pre-wrap break-words">{msg.content}</div>
                <div className="text-xs mt-1 opacity-50">
                  {new Date(msg.created_at).toLocaleTimeString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
