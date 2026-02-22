import { useState, useEffect } from 'react';
import { getModels, getModelConfig, updateModelConfig } from '../api/client';
import type { Model, ModelConfig } from '../api/types';

const providerColors: Record<string, string> = {
  anthropic: 'bg-amber-600 text-amber-100',
  openrouter: 'bg-indigo-600 text-indigo-100',
  ollama: 'bg-teal-600 text-teal-100',
  'openai-compatible': 'bg-cyan-600 text-cyan-100',
};

export function ModelsPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Editable roles
  const [agentModel, setAgentModel] = useState('');
  const [observerModel, setObserverModel] = useState('');
  const [workerModel, setWorkerModel] = useState('');

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (status) {
      const t = setTimeout(() => setStatus(null), 5000);
      return () => clearTimeout(t);
    }
  }, [status]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [m, c] = await Promise.all([getModels(), getModelConfig()]);
      setModels(m);
      setConfig(c);
      setAgentModel(c.roles?.agent ?? '');
      setObserverModel(c.roles?.observer ?? '');
      setWorkerModel(c.roles?.worker ?? '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const hasRoleChanges =
    config &&
    (agentModel !== (config.roles?.agent ?? '') ||
      observerModel !== (config.roles?.observer ?? '') ||
      workerModel !== (config.roles?.worker ?? ''));

  async function handleSaveRoles() {
    setSaving(true);
    setStatus(null);
    try {
      const roles: Record<string, string> = {
        agent: agentModel,
        observer: observerModel,
      };
      if (workerModel) roles.worker = workerModel;
      await updateModelConfig({ roles });
      setStatus({ type: 'success', message: 'Model roles updated' });
      await load();
    } catch (err) {
      setStatus({ type: 'error', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  function formatCost(cost?: number): string {
    if (cost === undefined || cost === null) return '-';
    return `$${cost.toFixed(2)}`;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h2 className="text-sm font-medium text-white">Models</h2>
        {hasRoleChanges && (
          <button
            onClick={handleSaveRoles}
            disabled={saving}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              saving
                ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {saving ? 'Saving...' : 'Save Roles'}
          </button>
        )}
      </div>

      {/* Status banner */}
      {status && (
        <div
          className={`px-4 py-2 text-sm ${
            status.type === 'success' ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'
          }`}
        >
          {status.message}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-gray-500">Loading...</p>
          </div>
        ) : error ? (
          <div className="px-4 py-2 text-sm bg-red-900/50 text-red-300 rounded">{error}</div>
        ) : (
          <div className="max-w-5xl mx-auto space-y-8">
            {/* Role Assignment */}
            <div>
              <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3">Role Assignment</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Agent Model</label>
                  <select
                    value={agentModel}
                    onChange={(e) => setAgentModel(e.target.value)}
                    className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">-- select --</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id} ({m.provider})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Observer Model</label>
                  <select
                    value={observerModel}
                    onChange={(e) => setObserverModel(e.target.value)}
                    className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">-- select --</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id} ({m.provider})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Worker Model (optional)</label>
                  <select
                    value={workerModel}
                    onChange={(e) => setWorkerModel(e.target.value)}
                    className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">-- falls back to agent --</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id} ({m.provider})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Models Table */}
            <div>
              <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3">Available Models</h3>
              <table className="w-full">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wider">
                    <th className="pb-3 pr-4">ID</th>
                    <th className="pb-3 pr-4">Model Name</th>
                    <th className="pb-3 pr-4 w-28">Provider</th>
                    <th className="pb-3 pr-4 w-24 text-right">Max Tokens</th>
                    <th className="pb-3 pr-4 w-24 text-right">Input $/1M</th>
                    <th className="pb-3 pr-4 w-24 text-right">Output $/1M</th>
                    <th className="pb-3 w-28">Roles</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {models.map((model) => (
                    <tr key={model.id} className="hover:bg-gray-800/50 transition-colors">
                      <td className="py-3 pr-4">
                        <code className="text-sm text-white font-mono">{model.id}</code>
                      </td>
                      <td className="py-3 pr-4">
                        <code className="text-sm text-gray-300 font-mono">{model.modelName}</code>
                      </td>
                      <td className="py-3 pr-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            providerColors[model.provider] ?? 'bg-gray-600 text-gray-200'
                          }`}
                        >
                          {model.provider}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-right text-sm text-gray-400">
                        {model.maxTokens.toLocaleString()}
                      </td>
                      <td className="py-3 pr-4 text-right text-sm text-gray-400">
                        {formatCost(model.costPer1MInput)}
                      </td>
                      <td className="py-3 pr-4 text-right text-sm text-gray-400">
                        {formatCost(model.costPer1MOutput)}
                      </td>
                      <td className="py-3">
                        <div className="flex gap-1 flex-wrap">
                          {model.roles.map((role) => (
                            <span
                              key={role}
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-700 text-gray-300"
                            >
                              {role}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Provider Info */}
            {config?.providers && Object.keys(config.providers).length > 0 && (
              <div>
                <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3">Providers</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {Object.entries(config.providers).map(([key, provider]) => (
                    <div key={key} className="rounded-xl border border-gray-700 bg-gray-800/50 px-4 py-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            providerColors[provider.provider] ?? 'bg-gray-600 text-gray-200'
                          }`}
                        >
                          {provider.provider}
                        </span>
                        <span className="text-sm text-gray-400">{key}</span>
                      </div>
                      <div className="space-y-1">
                        {Object.entries(provider)
                          .filter(([k]) => k !== 'provider')
                          .map(([k, v]) => (
                            <div key={k} className="flex items-center text-xs gap-2">
                              <span className="text-gray-500">{k}:</span>
                              <code className="text-gray-400 font-mono">{String(v)}</code>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
