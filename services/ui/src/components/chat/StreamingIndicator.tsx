export function StreamingIndicator() {
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
      <span className="text-sm text-gray-500">Thinking...</span>
    </div>
  );
}
