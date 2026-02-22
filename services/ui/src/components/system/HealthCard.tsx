interface HealthCardProps {
  name: string;
  status: 'healthy' | 'unhealthy' | 'unknown' | string;
  detail?: string;
}

const statusColors: Record<string, { dot: string; text: string; bg: string }> = {
  healthy: { dot: 'bg-green-500', text: 'text-green-400', bg: 'bg-green-900/20 border-green-900/30' },
  unhealthy: { dot: 'bg-red-500', text: 'text-red-400', bg: 'bg-red-900/20 border-red-900/30' },
  unknown: { dot: 'bg-yellow-500', text: 'text-yellow-400', bg: 'bg-yellow-900/20 border-yellow-900/30' },
};

export function HealthCard({ name, status, detail }: HealthCardProps) {
  const colors = statusColors[status] ?? statusColors.unknown;

  return (
    <div className={`rounded-xl border px-5 py-4 ${colors.bg}`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-white capitalize">{name}</h3>
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${colors.text}`}>
          <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
          {status}
        </span>
      </div>
      {detail && (
        <p className="text-xs text-gray-400">{detail}</p>
      )}
    </div>
  );
}
