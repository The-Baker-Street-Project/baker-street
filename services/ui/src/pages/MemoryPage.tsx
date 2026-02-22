import { useState, useEffect } from 'react';
import { searchMemories, listMemories } from '../api/client';
import type { MemoryEntry } from '../api/types';

const CATEGORIES = ['all', 'gear', 'preferences', 'homelab', 'personal', 'work', 'general'];

export function MemoryPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
  }, [category]);

  async function load() {
    setLoading(true);
    try {
      const cat = category === 'all' ? undefined : category;
      const results = await listMemories(cat, 50);
      setMemories(results);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) {
      load();
      return;
    }
    setLoading(true);
    try {
      const results = await searchMemories(query.trim());
      setMemories(results);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-800 space-y-3">
        <h2 className="text-sm font-medium text-white">Memory</h2>
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memories..."
            className="flex-1 rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
          >
            Search
          </button>
        </form>
        <div className="flex gap-1 flex-wrap">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => { setCategory(cat); setQuery(''); }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                cat === category
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-gray-500">Loading...</p>
          </div>
        ) : memories.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-gray-600">No memories found</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-3">
            {memories.map((mem) => (
              <div key={mem.id} className="rounded-lg bg-gray-800/50 border border-gray-800 p-4">
                <div className="text-sm text-gray-200 whitespace-pre-wrap break-words">
                  {mem.content}
                </div>
                <div className="flex items-center gap-3 mt-3 text-xs text-gray-500">
                  <span className="inline-block px-2 py-0.5 rounded-full bg-gray-700 text-gray-300">
                    {mem.category}
                  </span>
                  {mem.score !== undefined && (
                    <span>score: {mem.score.toFixed(3)}</span>
                  )}
                  <span>created: {new Date(mem.created_at).toLocaleDateString()}</span>
                  <span>updated: {new Date(mem.updated_at).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
