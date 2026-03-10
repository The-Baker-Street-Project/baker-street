import { createExtension } from '@bakerst/extension-sdk';
import { registerGithubTools } from './tools/github.js';
import { registerUtilityTools } from './tools/utilities.js';
import { registerPerplexityTools } from './tools/perplexity.js';
import { registerObsidianTools } from './tools/obsidian.js';

const ext = createExtension({
  id: 'toolbox',
  name: 'Toolbox',
  version: '0.1.0',
  description: 'Combined utility, GitHub, Perplexity, and Obsidian tools',
  tags: ['utilities', 'github', 'perplexity', 'search', 'time', 'network', 'obsidian', 'notes', 'pkm'],
});

// Register tool modules — each gracefully skips if secrets are missing
registerUtilityTools(ext.server);
registerGithubTools(ext.server);
registerPerplexityTools(ext.server);
registerObsidianTools(ext.server);

// Start the extension
ext.start().catch((e) => {
  console.error('Failed to start Toolbox extension:', e);
  process.exit(1);
});

const shutdown = () => ext.shutdown().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
