const statusStyles: Record<string, string> = {
  dispatched: 'bg-gray-500/20 text-gray-400',
  received: 'bg-blue-500/20 text-blue-400',
  running: 'bg-yellow-500/20 text-yellow-400',
  completed: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusStyles[status] ?? 'bg-gray-700 text-gray-400'}`}>
      {status}
    </span>
  );
}
