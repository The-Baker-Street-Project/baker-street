import { useState } from 'react';
import { getSkills, updateSkill } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { TierBadge } from '../components/skills/TierBadge';
import { ConnectionBadge } from '../components/skills/ConnectionBadge';
import { InstallSkillModal } from '../components/skills/InstallSkillModal';
import { SkillDetailPanel } from '../components/skills/SkillDetailPanel';
import { RegistryBrowser } from '../components/skills/RegistryBrowser';
import type { Skill, RegistryServer } from '../api/types';

type Tab = 'installed' | 'browse';

export function SkillsPage() {
  const { data: skills, loading, error, refresh } = usePolling(getSkills, 10_000);
  const [tab, setTab] = useState<Tab>('installed');
  const [showInstall, setShowInstall] = useState(false);
  const [prefillServer, setPrefillServer] = useState<RegistryServer | undefined>();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  async function handleToggle(skill: Skill, e: React.MouseEvent) {
    e.stopPropagation();
    setToggling(skill.id);
    try {
      await updateSkill(skill.id, { enabled: !skill.enabled });
      refresh();
    } catch {
      // error visible on next refresh
    } finally {
      setToggling(null);
    }
  }

  function handleRegistryInstall(server: RegistryServer) {
    setPrefillServer(server);
    setShowInstall(true);
  }

  function handleInstallClose() {
    setShowInstall(false);
    setPrefillServer(undefined);
  }

  function handleInstalled() {
    handleInstallClose();
    setTab('installed');
    refresh();
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with tabs */}
      <div className="px-4 py-3 border-b border-gray-800">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-white">Skills / MCP Servers</h2>
          <button
            onClick={() => { setPrefillServer(undefined); setShowInstall(true); }}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
          >
            Install New
          </button>
        </div>
        <div className="flex gap-1">
          {(['installed', 'browse'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === t
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
              }`}
            >
              {t === 'installed' ? 'Installed' : 'Browse Registry'}
            </button>
          ))}
        </div>
      </div>

      {/* Error banner */}
      {error && tab === 'installed' && (
        <div className="px-4 py-2 text-sm bg-red-900/50 text-red-300">{error}</div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'installed' ? (
          loading && !skills ? (
            <div className="flex items-center justify-center h-64">
              <p className="text-gray-500">Loading...</p>
            </div>
          ) : skills && skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <p className="text-gray-500">No skills installed</p>
              <button
                onClick={() => setTab('browse')}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
              >
                Browse MCP Registry
              </button>
            </div>
          ) : (
            <div className="max-w-5xl mx-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wider">
                    <th className="pb-3 pr-4">Name</th>
                    <th className="pb-3 pr-4 w-24">Tier</th>
                    <th className="pb-3 pr-4 w-28">Transport</th>
                    <th className="pb-3 pr-4 w-20">Enabled</th>
                    <th className="pb-3 pr-4 w-32">Status</th>
                    <th className="pb-3 w-16 text-right">Tools</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {skills?.map((skill) => (
                    <tr
                      key={skill.id}
                      onClick={() => setSelectedSkillId(skill.id)}
                      className="group cursor-pointer hover:bg-gray-800/50 transition-colors"
                    >
                      <td className="py-3 pr-4">
                        <div className="text-sm text-white font-medium">{skill.name}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{skill.description}</div>
                      </td>
                      <td className="py-3 pr-4">
                        <TierBadge tier={skill.tier} />
                      </td>
                      <td className="py-3 pr-4">
                        <span className="text-sm text-gray-400">
                          {skill.transport ?? (skill.tier === 'instruction' ? 'n/a' : skill.tier === 'stdio' ? 'stdio' : 'http')}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <button
                          onClick={(e) => handleToggle(skill, e)}
                          disabled={toggling === skill.id}
                          className={`relative w-9 h-5 rounded-full transition-colors ${
                            skill.enabled ? 'bg-blue-600' : 'bg-gray-600'
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                              skill.enabled ? 'translate-x-4' : ''
                            }`}
                          />
                        </button>
                      </td>
                      <td className="py-3 pr-4">
                        <ConnectionBadge connected={skill.connected} enabled={skill.enabled} />
                      </td>
                      <td className="py-3 text-right">
                        <span className="text-sm text-gray-400">{skill.toolCount ?? 0}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <div className="max-w-3xl mx-auto">
            <RegistryBrowser onInstall={handleRegistryInstall} />
          </div>
        )}
      </div>

      {/* Install Modal */}
      {showInstall && (
        <InstallSkillModal
          onClose={handleInstallClose}
          onInstalled={handleInstalled}
          prefill={prefillServer}
        />
      )}

      {/* Detail Panel */}
      {selectedSkillId && (
        <SkillDetailPanel
          skillId={selectedSkillId}
          onClose={() => setSelectedSkillId(null)}
          onUpdated={refresh}
        />
      )}
    </div>
  );
}
