import { useState } from 'react';
import { getToolboxes, buildToolbox } from '../../api/client';
import { usePolling } from '../../hooks/usePolling';
import type { Toolbox } from '../../api/types';

const statusColors: Record<string, string> = {
  built: 'bg-green-600/20 text-green-400',
  not_built: 'bg-gray-700 text-gray-400',
  building: 'bg-yellow-600/20 text-yellow-400',
  error: 'bg-red-600/20 text-red-400',
};

export function ToolboxesTab() {
  const { data: toolboxes, loading, error, refresh } = usePolling(getToolboxes, 30_000);
  const [building, setBuilding] = useState<string | null>(null);

  async function handleBuild(name: string) {
    setBuilding(name);
    try {
      await buildToolbox(name);
      refresh();
    } catch {
      // visible on next refresh
    } finally {
      setBuilding(null);
    }
  }

  if (loading && !toolboxes) {
    return <p className="text-gray-400 p-4">Loading toolboxes...</p>;
  }

  if (error) {
    return <p className="text-red-400 p-4">Error: {String(error)}</p>;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-white">Toolboxes</h2>
        <button
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg"
          onClick={refresh}
        >
          Refresh
        </button>
      </div>
      <p className="text-gray-400 text-sm mb-4">
        Docker image variants for Task Pods. Source:{' '}
        <a
          href="https://github.com/garyld1962/bakerst-toolboxes"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300"
        >
          bakerst-toolboxes
        </a>
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-400 border-b border-gray-800">
            <th className="pb-2 font-medium">Name</th>
            <th className="pb-2 font-medium">Description</th>
            <th className="pb-2 font-medium">Packages</th>
            <th className="pb-2 font-medium">Status</th>
            <th className="pb-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {(toolboxes ?? []).map((tb: Toolbox) => (
            <tr key={tb.name} className="border-b border-gray-800/50">
              <td className="py-2 text-white font-medium">{tb.name}</td>
              <td className="py-2 text-gray-400">{tb.description}</td>
              <td className="py-2">
                {tb.packages.map((pkg) => (
                  <span key={pkg} className="inline-block px-1.5 py-0.5 bg-gray-700 text-gray-300 text-xs rounded mr-1 mb-1">
                    {pkg}
                  </span>
                ))}
              </td>
              <td className="py-2">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[tb.status] ?? 'bg-gray-700 text-gray-400'}`}>
                  {tb.status.replace('_', ' ')}
                </span>
              </td>
              <td className="py-2">
                <button
                  className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded disabled:opacity-50"
                  disabled={building === tb.name || tb.status === 'building'}
                  onClick={() => handleBuild(tb.name)}
                >
                  {tb.status === 'built' ? 'Rebuild' : 'Build'}
                </button>
              </td>
            </tr>
          ))}
          {(!toolboxes || toolboxes.length === 0) && (
            <tr>
              <td colSpan={5} className="py-8 text-center text-gray-500">
                No toolboxes configured. Set TOOLBOX_MANIFEST_URL on the brain.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
