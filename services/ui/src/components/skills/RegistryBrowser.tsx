import { useState } from 'react';
import { searchRegistry } from '../../api/client';
import type { RegistryServer } from '../../api/types';

interface RegistryBrowserProps {
  onInstall: (server: RegistryServer) => void;
}

export function RegistryBrowser({ onInstall }: RegistryBrowserProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RegistryServer[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function handleSearch() {
    if (query.trim().length < 2) return;
    setSearching(true);
    setError(null);
    try {
      const data = await searchRegistry(query.trim());
      setResults(data.servers ?? []);
      setSearched(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleSearch();
  }

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search MCP servers (e.g. obsidian, github, slack)..."
          className="flex-1 rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleSearch}
          disabled={searching || query.trim().length < 2}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            searching || query.trim().length < 2
              ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
        >
          {searching ? 'Searching...' : 'Search'}
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded bg-red-900/50 text-red-300 text-sm">{error}</div>
      )}

      {/* Results */}
      {searched && results.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          No MCP servers found for "{query}"
        </div>
      )}

      <div className="space-y-3">
        {results.map((server) => {
          const pkg = server.version_detail?.packages?.[0];
          const remote = server.version_detail?.remotes?.[0];
          const envVars = pkg?.environment_variables ?? [];

          return (
            <div
              key={server.name}
              className="rounded-lg border border-gray-700 bg-gray-800/50 p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-medium text-white truncate">{server.name}</h3>
                  <p className="text-xs text-gray-400 mt-1 line-clamp-2">{server.description}</p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {pkg?.registry_name && (
                      <span className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300">
                        {pkg.registry_name}
                      </span>
                    )}
                    {pkg?.version && (
                      <span className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300">
                        v{pkg.version}
                      </span>
                    )}
                    {remote?.transport_type && (
                      <span className="px-2 py-0.5 rounded text-xs bg-blue-900/50 text-blue-300">
                        {remote.transport_type}
                      </span>
                    )}
                    {envVars.length > 0 && (
                      <span className="px-2 py-0.5 rounded text-xs bg-yellow-900/50 text-yellow-300">
                        {envVars.length} env var{envVars.length > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => onInstall(server)}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium bg-green-700 hover:bg-green-600 text-white transition-colors flex-shrink-0"
                >
                  Install
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
