import { getSystemHealth, getSkillsStatus } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { HealthCard } from '../components/system/HealthCard';
import { TierBadge } from '../components/skills/TierBadge';
import { ConnectionBadge } from '../components/skills/ConnectionBadge';

export function SystemPage() {
  const { data: health, loading: healthLoading, error: healthError } = usePolling(getSystemHealth, 15_000);
  const { data: skillsStatus, loading: skillsLoading, error: skillsError } = usePolling(getSkillsStatus, 15_000);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800">
        <h2 className="text-sm font-medium text-white">System</h2>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-5xl mx-auto space-y-8">
          {/* Health Grid */}
          <div>
            <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3">Component Health</h3>
            {healthLoading && !health ? (
              <p className="text-gray-500 text-sm">Loading...</p>
            ) : healthError ? (
              <div className="px-3 py-2 rounded bg-red-900/50 text-red-300 text-sm">{healthError}</div>
            ) : health ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {Object.entries(health).map(([name, info]) => (
                  <HealthCard
                    key={name}
                    name={name}
                    status={info.status}
                    detail={info.detail}
                  />
                ))}
              </div>
            ) : null}
          </div>

          {/* Skills Status */}
          <div>
            <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3">Skills Status</h3>
            {skillsLoading && !skillsStatus ? (
              <p className="text-gray-500 text-sm">Loading...</p>
            ) : skillsError ? (
              <div className="px-3 py-2 rounded bg-red-900/50 text-red-300 text-sm">{skillsError}</div>
            ) : skillsStatus && skillsStatus.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wider">
                    <th className="pb-3 pr-4">Name</th>
                    <th className="pb-3 pr-4 w-24">Tier</th>
                    <th className="pb-3 pr-4 w-20">Enabled</th>
                    <th className="pb-3 w-32">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {skillsStatus.map((skill) => (
                    <tr key={skill.id} className="hover:bg-gray-800/50 transition-colors">
                      <td className="py-3 pr-4">
                        <span className="text-sm text-white">{skill.name}</span>
                      </td>
                      <td className="py-3 pr-4">
                        <TierBadge tier={skill.tier} />
                      </td>
                      <td className="py-3 pr-4">
                        <span className={`text-sm ${skill.enabled ? 'text-green-400' : 'text-gray-500'}`}>
                          {skill.enabled ? 'Yes' : 'No'}
                        </span>
                      </td>
                      <td className="py-3">
                        <ConnectionBadge connected={skill.connected} enabled={skill.enabled} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-gray-500 text-sm">No skills installed</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
