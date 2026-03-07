import { useState, useEffect } from 'react';
import { getModels, setConversationModel } from '../../api/client';
import type { Model } from '../../api/types';

interface ModelSelectorProps {
  conversationId: string | undefined;
  currentModel: string | null;
  onModelChange: (model: string | null) => void;
}

export function ModelSelector({ conversationId, currentModel, onModelChange }: ModelSelectorProps) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getModels().then(setModels).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function handleChange(modelId: string) {
    if (!conversationId) return;
    const model = modelId || null;
    setSaving(true);
    try {
      await setConversationModel(conversationId, model);
      onModelChange(model);
    } catch {
      // silently fail — model stays as previous
    } finally {
      setSaving(false);
    }
  }

  if (loading || models.length === 0) return null;

  // Group models by provider
  const providers = [...new Set(models.map((m) => m.provider))];

  return (
    <select
      value={currentModel ?? ''}
      onChange={(e) => handleChange(e.target.value)}
      disabled={!conversationId || saving}
      className="text-xs bg-transparent border border-gray-700 rounded px-2 py-1 text-gray-400 hover:text-white focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
      title="Model for this conversation"
    >
      <option value="">Default (agent role)</option>
      {providers.map((provider) => (
        <optgroup key={provider} label={provider}>
          {models
            .filter((m) => m.provider === provider)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
