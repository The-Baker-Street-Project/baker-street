import { useState, useEffect } from 'react';
import { getSecrets, updateSecrets, restartServices } from '../api/client';
import type { SecretEntry } from '../api/types';

interface EditableSecret {
  key: string;
  value: string;
  isNew?: boolean;
}

export function SecretsPage() {
  const [secrets, setSecrets] = useState<EditableSecret[]>([]);
  const [original, setOriginal] = useState<EditableSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (status) {
      const t = setTimeout(() => setStatus(null), 5000);
      return () => clearTimeout(t);
    }
  }, [status]);

  async function load() {
    setLoading(true);
    try {
      const entries = await getSecrets();
      const editable = entries.map((e: SecretEntry) => ({ key: e.key, value: e.value }));
      setSecrets(editable);
      setOriginal(editable.map(e => ({ ...e })));
      setRevealed(new Set());
    } catch (err) {
      setStatus({ type: 'error', message: `Failed to load secrets: ${err}` });
    } finally {
      setLoading(false);
    }
  }

  const hasChanges = JSON.stringify(secrets) !== JSON.stringify(original);

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      const data: Record<string, string> = {};
      for (const s of secrets) {
        if (s.key.trim()) data[s.key.trim()] = s.value;
      }
      await updateSecrets(data);
      setStatus({ type: 'success', message: `Saved ${Object.keys(data).length} secrets` });
      await load();
    } catch (err) {
      setStatus({ type: 'error', message: `Failed to save: ${err}` });
    } finally {
      setSaving(false);
    }
  }

  async function handleRestart() {
    setRestarting(true);
    setStatus(null);
    try {
      const res = await restartServices();
      setStatus({ type: 'success', message: `Restarted: ${res.restarted.join(', ')}` });
    } catch (err) {
      setStatus({ type: 'error', message: `Failed to restart: ${err}` });
    } finally {
      setRestarting(false);
    }
  }

  function updateValue(index: number, value: string) {
    setSecrets(prev => prev.map((s, i) => i === index ? { ...s, value } : s));
  }

  function deleteSecret(index: number) {
    setSecrets(prev => prev.filter((_, i) => i !== index));
  }

  function addSecret() {
    const key = newKey.trim();
    if (!key) return;
    if (secrets.some(s => s.key === key)) {
      setStatus({ type: 'error', message: `Key "${key}" already exists` });
      return;
    }
    setSecrets(prev => [...prev, { key, value: newValue, isNew: true }]);
    setNewKey('');
    setNewValue('');
  }

  function toggleReveal(key: string) {
    setRevealed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function mask(value: string): string {
    if (value.length <= 4) return '****';
    return value.slice(0, 2) + '*'.repeat(Math.min(value.length - 4, 20)) + value.slice(-2);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h2 className="text-sm font-medium text-white">Secrets</h2>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              hasChanges && !saving
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : 'bg-gray-700 text-gray-500 cursor-not-allowed'
            }`}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button
            onClick={handleRestart}
            disabled={restarting}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              restarting
                ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                : 'bg-amber-600 hover:bg-amber-700 text-white'
            }`}
          >
            {restarting ? 'Restarting...' : 'Restart Services'}
          </button>
        </div>
      </div>

      {/* Status banner */}
      {status && (
        <div className={`px-4 py-2 text-sm ${
          status.type === 'success' ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'
        }`}>
          {status.message}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-gray-500">Loading...</p>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wider">
                  <th className="pb-3 pr-4 w-64">Key</th>
                  <th className="pb-3 pr-4">Value</th>
                  <th className="pb-3 w-24"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {secrets.map((secret, i) => (
                  <tr key={secret.key} className="group">
                    <td className="py-3 pr-4">
                      <code className="text-sm text-gray-300 font-mono">{secret.key}</code>
                      {secret.isNew && (
                        <span className="ml-2 px-1.5 py-0.5 text-xs rounded bg-green-900 text-green-300">new</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      {revealed.has(secret.key) ? (
                        <input
                          type="text"
                          value={secret.value}
                          onChange={(e) => updateValue(i, e.target.value)}
                          className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      ) : (
                        <code className="text-sm text-gray-500 font-mono">{mask(secret.value)}</code>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex gap-1 justify-end">
                        <button
                          onClick={() => toggleReveal(secret.key)}
                          className="px-2 py-1 rounded text-xs text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
                        >
                          {revealed.has(secret.key) ? 'Hide' : 'Show'}
                        </button>
                        <button
                          onClick={() => deleteSecret(i)}
                          className="px-2 py-1 rounded text-xs text-red-400 hover:text-red-300 hover:bg-red-900/30 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Add secret row */}
            <div className="mt-4 flex gap-2 items-center border-t border-gray-800 pt-4">
              <input
                type="text"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                placeholder="KEY_NAME"
                className="w-64 rounded bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="text"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="value"
                className="flex-1 rounded bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={addSecret}
                disabled={!newKey.trim()}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  newKey.trim()
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                }`}
              >
                Add
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
