import { useState } from 'react';
import type { ToolCall } from '../../hooks/useChat';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const input = toolCall.input && typeof toolCall.input === 'object' ? toolCall.input : {};
  let inputSummary: string;
  try {
    inputSummary = Object.entries(input)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80)}`)
      .join(', ');
  } catch {
    inputSummary = '(unable to display input)';
  }

  return (
    <div
      className="rounded-lg bg-gray-900/60 border border-gray-700 text-xs cursor-pointer"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-blue-400 font-mono font-medium">{toolCall.name}</span>
        {toolCall.result === undefined && (
          <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
        )}
        {!expanded && (
          <span className="text-gray-500 truncate">{inputSummary}</span>
        )}
      </div>
      {expanded && (
        <div className="border-t border-gray-700 px-3 py-2 space-y-1">
          <div>
            <span className="text-gray-500">Input: </span>
            <pre className="text-gray-300 whitespace-pre-wrap">{JSON.stringify(input, null, 2)}</pre>
          </div>
          {toolCall.result !== undefined && (
            <div>
              <span className="text-gray-500">Result: </span>
              <pre className="text-gray-300 whitespace-pre-wrap">{toolCall.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
