import { useState, useEffect } from 'react';
import { getSkillDetail, updateSkill, deleteSkill, testSkillConnection } from '../../api/client';
import { TierBadge } from './TierBadge';
import { ConnectionBadge } from './ConnectionBadge';
import type { SkillDetail, SkillTool } from '../../api/types';

interface SkillDetailPanelProps {
  skillId: string;
  onClose: () => void;
  onUpdated: () => void;
}

export function SkillDetailPanel({ skillId, onClose, onUpdated }: SkillDetailPanelProps) {
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ tools: SkillTool[] } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, [skillId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const detail = await getSkillDetail(skillId);
      setSkill(detail);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle() {
    if (!skill) return;
    setToggling(true);
    try {
      await updateSkill(skill.id, { enabled: !skill.enabled });
      await load();
      onUpdated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setToggling(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const result = await testSkillConnection(skillId);
      setTestResult(result);
    } catch (err) {
      setTestError((err as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await deleteSkill(skillId);
      onUpdated();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-md bg-gray-800 border-l border-gray-700 overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-700 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Skill Details</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            &times;
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-gray-500">Loading...</p>
          </div>
        ) : error && !skill ? (
          <div className="px-6 py-4">
            <div className="px-3 py-2 rounded bg-red-900/50 text-red-300 text-sm">{error}</div>
          </div>
        ) : skill ? (
          <div className="px-6 py-4 space-y-6">
            {error && (
              <div className="px-3 py-2 rounded bg-red-900/50 text-red-300 text-sm">{error}</div>
            )}

            {/* Metadata */}
            <div className="space-y-3">
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Name</div>
                <div className="text-white font-medium">{skill.name}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Description</div>
                <div className="text-gray-300 text-sm">{skill.description}</div>
              </div>
              <div className="flex gap-4">
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Version</div>
                  <div className="text-gray-300 text-sm">{skill.version}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Tier</div>
                  <TierBadge tier={skill.tier} />
                </div>
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Transport</div>
                  <div className="text-gray-300 text-sm">{skill.transport ?? 'n/a'}</div>
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Status</div>
                <ConnectionBadge connected={skill.connected} enabled={skill.enabled} />
              </div>

              {/* Tier-specific info */}
              {skill.stdioCommand && (
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Command</div>
                  <code className="text-sm text-gray-300 font-mono">
                    {skill.stdioCommand} {skill.stdioArgs?.join(' ')}
                  </code>
                </div>
              )}
              {skill.httpUrl && (
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">URL</div>
                  <code className="text-sm text-gray-300 font-mono">{skill.httpUrl}</code>
                </div>
              )}
              {skill.instructionPath && (
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Instruction Path</div>
                  <code className="text-sm text-gray-300 font-mono">{skill.instructionPath}</code>
                </div>
              )}
            </div>

            {/* Enable/Disable toggle */}
            <div className="flex items-center justify-between py-3 border-t border-b border-gray-700">
              <span className="text-sm text-gray-300">Enabled</span>
              <button
                onClick={handleToggle}
                disabled={toggling}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  skill.enabled ? 'bg-blue-600' : 'bg-gray-600'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    skill.enabled ? 'translate-x-5' : ''
                  }`}
                />
              </button>
            </div>

            {/* Tools list */}
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">
                Tools ({skill.tools?.length ?? 0})
              </div>
              {skill.tools && skill.tools.length > 0 ? (
                <div className="space-y-2">
                  {skill.tools.map((tool) => (
                    <div key={tool.name} className="rounded bg-gray-900 px-3 py-2">
                      <div className="text-sm text-white font-mono">{tool.name}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{tool.description}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-gray-500">No tools available</div>
              )}
            </div>

            {/* Test connection */}
            {skill.tier !== 'instruction' && (
              <div>
                <button
                  onClick={handleTest}
                  disabled={testing}
                  className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    testing
                      ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                      : 'bg-gray-700 hover:bg-gray-600 text-white'
                  }`}
                >
                  {testing ? 'Testing...' : 'Test Connection'}
                </button>
                {testResult && (
                  <div className="mt-2 px-3 py-2 rounded bg-green-900/30 text-green-300 text-sm">
                    Connection successful. Found {testResult.tools.length} tool(s).
                  </div>
                )}
                {testError && (
                  <div className="mt-2 px-3 py-2 rounded bg-red-900/30 text-red-300 text-sm">
                    {testError}
                  </div>
                )}
              </div>
            )}

            {/* Delete */}
            <div className="pt-2">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  confirmDelete
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-gray-700 hover:bg-red-900/50 text-red-400 hover:text-red-300'
                }`}
              >
                {deleting ? 'Deleting...' : confirmDelete ? 'Confirm Delete' : 'Delete Skill'}
              </button>
              {confirmDelete && !deleting && (
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="w-full mt-1 px-4 py-1.5 rounded text-xs text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
