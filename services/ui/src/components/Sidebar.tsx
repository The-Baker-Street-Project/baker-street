import { NavLink } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { getPing } from '../api/client';

const links = [
  { to: '/chat', label: 'Chat' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/schedules', label: 'Schedules' },
  { to: '/conversations', label: 'Conversations' },
  { to: '/memory', label: 'Memory' },
  { to: '/secrets', label: 'Secrets' },
  { to: '/extensions', label: 'Extensions' },
  { to: '/models', label: 'Models' },
  { to: '/system', label: 'System' },
];

export function Sidebar() {
  const [mode, setMode] = useState<string | null>(null);
  const [agentName, setAgentName] = useState('Baker Street');

  useEffect(() => {
    getPing()
      .then((data) => {
        setMode(data.mode ?? null);
        setAgentName(data.name ?? 'Baker Street');
      })
      .catch(() => {});
  }, []);

  return (
    <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col">
      <div className="px-4 py-5 flex items-center gap-2">
        <h1 className="text-xl font-bold text-white tracking-tight">{agentName}</h1>
        {mode === 'dev' && (
          <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-400 rounded">
            dev
          </span>
        )}
      </div>
      <nav className="flex-1 px-2 space-y-1">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) =>
              `block px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
              }`
            }
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
