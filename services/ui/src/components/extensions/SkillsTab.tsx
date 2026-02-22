import { useState } from 'react';
import { getSkills, updateSkill, uploadSkillZip } from '../../api/client';
import { usePolling } from '../../hooks/usePolling';
import { SkillDetailPanel } from '../skills/SkillDetailPanel';
import type { Skill } from '../../api/types';

export function SkillsTab() {
  const { data: allSkills, loading, error, refresh } = usePolling(getSkills, 10_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Filter to Tier 0 (instruction) skills only
  const skills = allSkills?.filter((s) => s.tier === 'instruction') ?? [];
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

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    try {
      await uploadSkillZip(file);
      refresh();
    } catch (err) {
      setUploadError(String(err));
    }
  }

  if (loading && !allSkills) {
    return <p className="text-gray-400 p-4">Loading skills...</p>;
  }

  if (error) {
    return <p className="text-red-400 p-4">Error: {String(error)}</p>;
  }

  return (
    <div className="flex gap-6">
      <div className="flex-1">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-white">Instruction Skills</h2>
          <div className="flex gap-2">
            <label className="cursor-pointer px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg">
              Upload Zip
              <input type="file" accept=".zip" className="hidden" onChange={handleUpload} />
            </label>
          </div>
        </div>
        {uploadError && (
          <p className="text-red-400 text-sm mb-2">{uploadError}</p>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-gray-800">
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">Description</th>
              <th className="pb-2 font-medium">Tags</th>
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
                <td className="py-2 text-gray-400 truncate max-w-xs">{skill.description}</td>
                <td className="py-2">
                  {(skill.tags ?? []).map((tag) => (
                    <span key={tag} className="inline-block px-1.5 py-0.5 bg-gray-700 text-gray-300 text-xs rounded mr-1">
                      {tag}
                    </span>
                  ))}
                </td>
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
                <td colSpan={4} className="py-8 text-center text-gray-500">
                  No instruction skills installed
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
    </div>
  );
}
