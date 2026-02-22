import { useState } from 'react';
import { getSkills, updateSkill } from '../../api/client';
import { usePolling } from '../../hooks/usePolling';
import { TierBadge } from '../skills/TierBadge';
import { ConnectionBadge } from '../skills/ConnectionBadge';
import { InstallSkillModal } from '../skills/InstallSkillModal';
import { SkillDetailPanel } from '../skills/SkillDetailPanel';
import { RegistryBrowser } from '../skills/RegistryBrowser';
import type { Skill, RegistryServer } from '../../api/types';

export function McpServersTab() {
  const { data: allSkills, loading, error, refresh } = usePolling(getSkills, 10_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  const [showBrowse, setShowBrowse] = useState(false);
  const [prefillServer, setPrefillServer] = useState<RegistryServer | undefined>();
  const [toggling, setToggling] = useState<string | null>(null);

  // Filter to non-instruction skills
  const skills = allSkills?.filter((s) => s.tier !== 'instruction') ?? [];
  const selectedSkill = skills.find((s) => s.id === selectedId) ?? null;

  async function handleToggle(skill: Skill, e: React.MouseEvent) {
    e.stopPropagation();
    setToggling(skill.id);
    try {
      await updateSkill(skill.id, { enabled: !skill.enabled });
      refresh();
    } catch {
      // visible on next refresh
    } finally {
      setToggling(null);
    }
  }

  function handleRegistryInstall(server: RegistryServer) {
    setPrefillServer(server);
    setShowInstall(true);
    setShowBrowse(false);
  }

  if (loading && !allSkills) {
    return <p className="text-gray-400 p-4">Loading MCP servers...</p>;
  }

  if (error) {
    return <p className="text-red-400 p-4">Error: {String(error)}</p>;
  }

  return (
    <div className="flex gap-6">
      <div className="flex-1">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-white">MCP Servers</h2>
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg"
              onClick={() => setShowBrowse(!showBrowse)}
            >
              {showBrowse ? 'Hide Registry' : 'Browse Registry'}
            </button>
            <button
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg"
              onClick={() => setShowInstall(true)}
            >
              Install New
            </button>
          </div>
        </div>

        {showBrowse && (
          <div className="mb-6">
            <RegistryBrowser onInstall={handleRegistryInstall} />
          </div>
        )}

        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-gray-800">
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">Tier</th>
              <th className="pb-2 font-medium">Transport</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 font-medium">Tools</th>
              <th className="pb-2 font-medium">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((skill) => (
              <tr
                key={skill.id}
                className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer"
                onClick={() => setSelectedId(skill.id === selectedId ? null : skill.id)}
              >
                <td className="py-2 text-white">{skill.name}</td>
                <td className="py-2"><TierBadge tier={skill.tier} /></td>
                <td className="py-2 text-gray-400">{skill.transport ?? '-'}</td>
                <td className="py-2"><ConnectionBadge connected={skill.connected ?? false} enabled={skill.enabled} /></td>
                <td className="py-2 text-gray-400">{skill.toolCount ?? 0}</td>
                <td className="py-2">
                  <button
                    onClick={(e) => handleToggle(skill, e)}
                    disabled={toggling === skill.id}
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      skill.enabled ? 'bg-green-600/20 text-green-400' : 'bg-gray-700 text-gray-400'
                    }`}
                  >
                    {skill.enabled ? 'On' : 'Off'}
                  </button>
                </td>
              </tr>
            ))}
            {skills.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-gray-500">
                  No MCP servers installed
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedSkill && (
        <div className="w-80 shrink-0">
          <SkillDetailPanel skillId={selectedSkill.id} onClose={() => setSelectedId(null)} onUpdated={refresh} />
        </div>
      )}

      {showInstall && (
        <InstallSkillModal
          onClose={() => { setShowInstall(false); setPrefillServer(undefined); }}
          onInstalled={() => { setShowInstall(false); setPrefillServer(undefined); refresh(); }}
          prefill={prefillServer}
        />
      )}
    </div>
  );
}
