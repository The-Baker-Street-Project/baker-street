import { useState } from 'react';
import { SkillsTab } from '../components/extensions/SkillsTab';
import { McpServersTab } from '../components/extensions/McpServersTab';
import { ToolboxesTab } from '../components/extensions/ToolboxesTab';

type Tab = 'skills' | 'mcp' | 'toolboxes';

const tabs: Array<{ key: Tab; label: string }> = [
  { key: 'skills', label: 'Skills' },
  { key: 'mcp', label: 'MCP Servers' },
  { key: 'toolboxes', label: 'Toolboxes' },
];

export function ExtensionsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('skills');

  return (
    <div className="p-6 max-w-6xl">
      <h1 className="text-2xl font-bold text-white mb-6">Extensions</h1>
      <div className="flex gap-1 border-b border-gray-800 mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'text-white border-blue-500'
                : 'text-gray-400 border-transparent hover:text-gray-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === 'skills' && <SkillsTab />}
      {activeTab === 'mcp' && <McpServersTab />}
      {activeTab === 'toolboxes' && <ToolboxesTab />}
    </div>
  );
}
