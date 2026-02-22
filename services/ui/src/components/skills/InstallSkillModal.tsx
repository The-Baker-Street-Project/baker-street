import { useState } from 'react';
import { createSkill } from '../../api/client';
import type { RegistryServer } from '../../api/types';

interface InstallSkillModalProps {
  onClose: () => void;
  onInstalled: () => void;
  prefill?: RegistryServer;
}

type Tier = 'instruction' | 'stdio' | 'sidecar' | 'service';
type InstructionSource = 'inline' | 'file';

interface EnvVar {
  key: string;
  value: string;
}

function deriveDefaults(prefill?: RegistryServer) {
  if (!prefill) return {};
  const pkg = prefill.version_detail?.packages?.[0];
  const remote = prefill.version_detail?.remotes?.[0];

  // Derive tier from transport
  let tier: Tier = 'stdio';
  if (remote?.transport_type === 'sse' || remote?.transport_type === 'streamable-http') {
    tier = 'service';
  }

  // Derive command from package
  let stdioCommand = '';
  let stdioArgs = '';
  if (pkg?.registry_name === 'npm' && pkg?.name) {
    stdioCommand = 'npx';
    stdioArgs = `-y ${pkg.name}`;
  }

  // Derive env vars from package
  const envVars: EnvVar[] = (pkg?.environment_variables ?? []).map((ev) => ({
    key: ev.name,
    value: '',
  }));

  return {
    name: prefill.name,
    description: prefill.description,
    version: pkg?.version ?? '1.0.0',
    tier,
    stdioCommand,
    stdioArgs,
    httpUrl: remote?.url ?? '',
    envVars,
  };
}

export function InstallSkillModal({ onClose, onInstalled, prefill }: InstallSkillModalProps) {
  const defaults = deriveDefaults(prefill);

  const [name, setName] = useState(defaults.name ?? '');
  const [description, setDescription] = useState(defaults.description ?? '');
  const [version, setVersion] = useState(defaults.version ?? '1.0.0');
  const [tier, setTier] = useState<Tier>(defaults.tier ?? 'stdio');
  const [stdioCommand, setStdioCommand] = useState(defaults.stdioCommand ?? '');
  const [stdioArgs, setStdioArgs] = useState(defaults.stdioArgs ?? '');
  const [httpUrl, setHttpUrl] = useState(defaults.httpUrl ?? '');
  const [instructionPath, setInstructionPath] = useState('');
  const [instructionContent, setInstructionContent] = useState('');
  const [instructionSource, setInstructionSource] = useState<InstructionSource>('inline');
  const [envVars, setEnvVars] = useState<EnvVar[]>(defaults.envVars ?? []);
  const [headers, setHeaders] = useState<EnvVar[]>([]);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addEnvVar() {
    setEnvVars([...envVars, { key: '', value: '' }]);
  }

  function removeEnvVar(index: number) {
    setEnvVars(envVars.filter((_, i) => i !== index));
  }

  function updateEnvVar(index: number, field: 'key' | 'value', val: string) {
    const updated = [...envVars];
    updated[index] = { ...updated[index], [field]: val };
    setEnvVars(updated);
  }

  function addHeader() {
    setHeaders([...headers, { key: '', value: '' }]);
  }

  function removeHeader(index: number) {
    setHeaders(headers.filter((_, i) => i !== index));
  }

  function updateHeader(index: number, field: 'key' | 'value', val: string) {
    const updated = [...headers];
    updated[index] = { ...updated[index], [field]: val };
    setHeaders(updated);
  }

  async function handleInstall() {
    if (!name.trim() || !description.trim()) return;

    setInstalling(true);
    setError(null);

    try {
      const isInline = tier === 'instruction' && instructionSource === 'inline';
      const isFilePath = tier === 'instruction' && instructionSource === 'file';

      // Build config with env vars and headers
      const config: Record<string, unknown> = {};
      const validEnvVars = envVars.filter((ev) => ev.key.trim());
      if (validEnvVars.length > 0) {
        config.env = Object.fromEntries(validEnvVars.map((ev) => [ev.key.trim(), ev.value]));
      }
      const validHeaders = headers.filter((h) => h.key.trim());
      if (validHeaders.length > 0) {
        config.headers = Object.fromEntries(validHeaders.map((h) => [h.key.trim(), h.value]));
      }

      await createSkill({
        name: name.trim(),
        description: description.trim(),
        version,
        tier,
        enabled: true,
        stdioCommand: tier === 'stdio' ? stdioCommand.trim() || undefined : undefined,
        stdioArgs: tier === 'stdio' && stdioArgs.trim()
          ? stdioArgs.split(/\s+/).filter(Boolean)
          : undefined,
        httpUrl: (tier === 'sidecar' || tier === 'service') ? httpUrl.trim() || undefined : undefined,
        instructionPath: isFilePath ? instructionPath.trim() || undefined : undefined,
        instructionContent: isInline ? instructionContent.trim() || undefined : undefined,
        config,
      });
      onInstalled();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="relative bg-gray-800 rounded-xl shadow-2xl border border-gray-700 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-700 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">
            {prefill ? `Install ${prefill.name}` : 'Install New Skill'}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            &times;
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {error && (
            <div className="px-3 py-2 rounded bg-red-900/50 text-red-300 text-sm">{error}</div>
          )}

          <div>
            <label className="block text-sm text-gray-400 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. filesystem"
              className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this skill does"
              className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm text-gray-400 mb-1">Version</label>
              <input
                type="text"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm text-gray-400 mb-1">Tier</label>
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as Tier)}
                className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="instruction">Tier 0 - Instruction</option>
                <option value="stdio">Tier 1 - Stdio</option>
                <option value="sidecar">Tier 2 - Sidecar</option>
                <option value="service">Tier 3 - Service / External</option>
              </select>
            </div>
          </div>

          {/* Tier-specific fields */}
          {tier === 'instruction' && (
            <>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Source</label>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setInstructionSource('inline')}
                    className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                      instructionSource === 'inline'
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:text-white'
                    }`}
                  >
                    Paste Content
                  </button>
                  <button
                    type="button"
                    onClick={() => setInstructionSource('file')}
                    className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                      instructionSource === 'file'
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:text-white'
                    }`}
                  >
                    File Path
                  </button>
                </div>
              </div>

              {instructionSource === 'inline' ? (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Instruction Content (Markdown)</label>
                  <textarea
                    value={instructionContent}
                    onChange={(e) => setInstructionContent(e.target.value)}
                    placeholder="Paste your instruction markdown here..."
                    rows={8}
                    className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Instruction Path</label>
                  <input
                    type="text"
                    value={instructionPath}
                    onChange={(e) => setInstructionPath(e.target.value)}
                    placeholder="/etc/bakerst/skills/my-skill.md"
                    className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}
            </>
          )}

          {tier === 'stdio' && (
            <>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Command</label>
                <input
                  type="text"
                  value={stdioCommand}
                  onChange={(e) => setStdioCommand(e.target.value)}
                  placeholder="e.g. npx or node"
                  className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Arguments (space-separated)</label>
                <input
                  type="text"
                  value={stdioArgs}
                  onChange={(e) => setStdioArgs(e.target.value)}
                  placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp"
                  className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </>
          )}

          {(tier === 'sidecar' || tier === 'service') && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">HTTP URL</label>
              <input
                type="text"
                value={httpUrl}
                onChange={(e) => setHttpUrl(e.target.value)}
                placeholder="http://host.docker.internal:3200/mcp"
                className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          {/* HTTP Headers */}
          {(tier === 'sidecar' || tier === 'service') && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-gray-400">Headers</label>
                <button
                  type="button"
                  onClick={addHeader}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  + Add Header
                </button>
              </div>
              {headers.length === 0 && (
                <p className="text-xs text-gray-600">No headers configured</p>
              )}
              {headers.map((h, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={h.key}
                    onChange={(e) => updateHeader(i, 'key', e.target.value)}
                    placeholder="Header-Name"
                    className="w-1/3 rounded bg-gray-900 border border-gray-700 px-2 py-1.5 text-xs text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    type="text"
                    value={h.value}
                    onChange={(e) => updateHeader(i, 'value', e.target.value)}
                    placeholder="value"
                    className="flex-1 rounded bg-gray-900 border border-gray-700 px-2 py-1.5 text-xs text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => removeHeader(i)}
                    className="text-gray-500 hover:text-red-400 transition-colors px-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Environment Variables */}
          {tier !== 'instruction' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-gray-400">Environment Variables</label>
                <button
                  type="button"
                  onClick={addEnvVar}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  + Add Variable
                </button>
              </div>
              {envVars.length === 0 && (
                <p className="text-xs text-gray-600">No environment variables configured</p>
              )}
              {envVars.map((ev, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={ev.key}
                    onChange={(e) => updateEnvVar(i, 'key', e.target.value)}
                    placeholder="KEY"
                    className="w-1/3 rounded bg-gray-900 border border-gray-700 px-2 py-1.5 text-xs text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    type="text"
                    value={ev.value}
                    onChange={(e) => updateEnvVar(i, 'value', e.target.value)}
                    placeholder="value"
                    className="flex-1 rounded bg-gray-900 border border-gray-700 px-2 py-1.5 text-xs text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => removeEnvVar(i)}
                    className="text-gray-500 hover:text-red-400 transition-colors px-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-700 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={installing || !name.trim() || !description.trim()}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              installing || !name.trim() || !description.trim()
                ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {installing ? 'Installing...' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  );
}
