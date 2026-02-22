interface ConnectionBadgeProps {
  connected?: boolean;
  enabled: boolean;
}

export function ConnectionBadge({ connected, enabled }: ConnectionBadgeProps) {
  if (!enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
        <span className="w-2 h-2 rounded-full bg-gray-600" />
        disabled
      </span>
    );
  }

  if (connected) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-green-400">
        <span className="w-2 h-2 rounded-full bg-green-500" />
        connected
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-red-400">
      <span className="w-2 h-2 rounded-full bg-red-500" />
      disconnected
    </span>
  );
}
