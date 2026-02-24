import { useState, useEffect } from 'react';
import { getModels, getModelConfig, updateModelConfig, getVoiceConfig, updateVoiceConfig } from '../api/client';
import type { Model, ModelConfig, VoiceProviderConfig } from '../api/types';

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

  // Voice provider config
  const [voiceConfig, setVoiceConfig] = useState<VoiceProviderConfig>({});
  const [voiceForm, setVoiceForm] = useState<VoiceProviderConfig>({});
  const [voiceSaving, setVoiceSaving] = useState(false);

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
      const [m, c, vc] = await Promise.all([getModels(), getModelConfig(), getVoiceConfig().catch(() => ({}))]);
      setModels(m);
      setConfig(c);
      setAgentModel(c.roles?.agent ?? '');
      setObserverModel(c.roles?.observer ?? '');
      setWorkerModel(c.roles?.worker ?? '');
      setVoiceConfig(vc);
      setVoiceForm(vc);
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

  const hasVoiceChanges = JSON.stringify(voiceForm) !== JSON.stringify(voiceConfig);

  async function handleSaveVoice() {
    setVoiceSaving(true);
    setStatus(null);
    try {
      await updateVoiceConfig(voiceForm);
      setStatus({ type: 'success', message: 'Voice provider config updated' });
      setVoiceConfig(voiceForm);
    } catch (err) {
      setStatus({ type: 'error', message: (err as Error).message });
    } finally {
      setVoiceSaving(false);
    }
  }

  function updateStt(updates: Partial<NonNullable<VoiceProviderConfig['stt']>>) {
    setVoiceForm((prev) => ({ ...prev, stt: { ...prev.stt, ...updates } }));
  }

  function updateTts(updates: Partial<NonNullable<VoiceProviderConfig['tts']>>) {
    setVoiceForm((prev) => ({ ...prev, tts: { ...prev.tts, ...updates } }));
  }

  // Provider defaults for auto-fill
  const sttDefaults: Record<string, { baseUrl: string; model: string }> = {
    whisper: { baseUrl: 'http://host.docker.internal:8083', model: 'base' },
    openai: { baseUrl: 'https://api.openai.com', model: 'whisper-1' },
  };
  const ttsDefaults: Record<string, { baseUrl: string; model: string; voice: string }> = {
    coqui: { baseUrl: 'http://host.docker.internal:8084', model: '', voice: '' },
    openai: { baseUrl: 'https://api.openai.com', model: 'tts-1', voice: 'alloy' },
    elevenlabs: { baseUrl: 'https://api.elevenlabs.io', model: 'eleven_multilingual_v2', voice: '21m00Tcm4TlvDq8ikWAM' },
  };

  function handleSttProviderChange(provider: string) {
    const defaults = sttDefaults[provider] ?? sttDefaults.whisper;
    updateStt({ provider: provider as 'whisper' | 'openai', baseUrl: defaults.baseUrl, model: defaults.model, apiKey: '' });
  }

  function handleTtsProviderChange(provider: string) {
    const defaults = ttsDefaults[provider] ?? ttsDefaults.coqui;
    updateTts({ provider: provider as 'coqui' | 'openai' | 'elevenlabs', baseUrl: defaults.baseUrl, model: defaults.model, voice: defaults.voice, apiKey: '' });
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

            {/* Voice Providers */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs text-gray-500 uppercase tracking-wider">Voice Providers</h3>
                {hasVoiceChanges && (
                  <button
                    onClick={handleSaveVoice}
                    disabled={voiceSaving}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      voiceSaving
                        ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                        : 'bg-blue-600 hover:bg-blue-700 text-white'
                    }`}
                  >
                    {voiceSaving ? 'Saving...' : 'Save Voice Config'}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* STT config */}
                <div className="rounded-xl border border-gray-700 bg-gray-800/50 px-4 py-3 space-y-3">
                  <div className="text-sm font-medium text-gray-300">Speech-to-Text (STT)</div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Provider</label>
                    <select
                      value={voiceForm.stt?.provider ?? 'whisper'}
                      onChange={(e) => handleSttProviderChange(e.target.value)}
                      className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="whisper">Whisper (local)</option>
                      <option value="openai">OpenAI (cloud)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Base URL</label>
                    <input
                      type="text"
                      value={voiceForm.stt?.baseUrl ?? ''}
                      onChange={(e) => updateStt({ baseUrl: e.target.value })}
                      className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder={sttDefaults[voiceForm.stt?.provider ?? 'whisper']?.baseUrl}
                    />
                  </div>
                  {voiceForm.stt?.provider === 'openai' && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">API Key</label>
                      <input
                        type="password"
                        value={voiceForm.stt?.apiKey ?? ''}
                        onChange={(e) => updateStt({ apiKey: e.target.value })}
                        className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="sk-..."
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Model</label>
                    <input
                      type="text"
                      value={voiceForm.stt?.model ?? ''}
                      onChange={(e) => updateStt({ model: e.target.value })}
                      className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder={sttDefaults[voiceForm.stt?.provider ?? 'whisper']?.model}
                    />
                  </div>
                </div>

                {/* TTS config */}
                <div className="rounded-xl border border-gray-700 bg-gray-800/50 px-4 py-3 space-y-3">
                  <div className="text-sm font-medium text-gray-300">Text-to-Speech (TTS)</div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Provider</label>
                    <select
                      value={voiceForm.tts?.provider ?? 'coqui'}
                      onChange={(e) => handleTtsProviderChange(e.target.value)}
                      className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="coqui">Coqui/XTTS (local)</option>
                      <option value="openai">OpenAI (cloud)</option>
                      <option value="elevenlabs">ElevenLabs (cloud)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Base URL</label>
                    <input
                      type="text"
                      value={voiceForm.tts?.baseUrl ?? ''}
                      onChange={(e) => updateTts({ baseUrl: e.target.value })}
                      className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder={ttsDefaults[voiceForm.tts?.provider ?? 'coqui']?.baseUrl}
                    />
                  </div>
                  {(voiceForm.tts?.provider === 'openai' || voiceForm.tts?.provider === 'elevenlabs') && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">API Key</label>
                      <input
                        type="password"
                        value={voiceForm.tts?.apiKey ?? ''}
                        onChange={(e) => updateTts({ apiKey: e.target.value })}
                        className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder={voiceForm.tts?.provider === 'openai' ? 'sk-...' : 'xi-...'}
                      />
                    </div>
                  )}
                  {voiceForm.tts?.provider !== 'coqui' && (
                    <>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Model</label>
                        <input
                          type="text"
                          value={voiceForm.tts?.model ?? ''}
                          onChange={(e) => updateTts({ model: e.target.value })}
                          className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder={ttsDefaults[voiceForm.tts?.provider ?? 'openai']?.model}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Voice</label>
                        <input
                          type="text"
                          value={voiceForm.tts?.voice ?? ''}
                          onChange={(e) => updateTts({ voice: e.target.value })}
                          className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder={ttsDefaults[voiceForm.tts?.provider ?? 'openai']?.voice}
                        />
                      </div>
                    </>
                  )}
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
