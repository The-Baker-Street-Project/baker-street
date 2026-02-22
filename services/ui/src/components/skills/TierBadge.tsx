const tierColors: Record<string, string> = {
  instruction: 'bg-gray-600 text-gray-200',
  stdio: 'bg-blue-600 text-blue-100',
  sidecar: 'bg-purple-600 text-purple-100',
  service: 'bg-green-600 text-green-100',
};

export function TierBadge({ tier }: { tier: string }) {
  const colors = tierColors[tier] ?? 'bg-gray-600 text-gray-200';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors}`}>
      {tier}
    </span>
  );
}
