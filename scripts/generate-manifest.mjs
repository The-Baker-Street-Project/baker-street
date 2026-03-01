#!/usr/bin/env node

/**
 * Generate a release manifest JSON file from package.json versions,
 * prompts.json metadata, and image digests passed via CLI flags.
 *
 * Usage:
 *   node scripts/generate-manifest.mjs \
 *     --release-version 1.2.3 \
 *     --brain-digest sha256:abc... \
 *     --worker-digest sha256:def... \
 *     --ui-digest sha256:ghi... \
 *     --gateway-digest sha256:jkl... \
 *     --sysadmin-digest sha256:mno... \
 *     --ext-utilities-digest sha256:stu... \
 *     --ext-github-digest sha256:vwx... \
 *     --ext-obsidian-digest sha256:yza... \
 *     --output release-manifest.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      const key = argv[i].slice(2);
      args[key] = argv[++i];
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const releaseVersion = args['release-version'];
const output = args['output'] ?? 'release-manifest.json';

if (!releaseVersion) {
  console.error('Error: --release-version is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Read package versions
// ---------------------------------------------------------------------------

const components = [
  { name: 'brain',         pkgPath: 'services/brain',                required: true },
  { name: 'worker',        pkgPath: 'services/worker',               required: true },
  { name: 'ui',            pkgPath: 'services/ui',                   required: true },
  { name: 'gateway',       pkgPath: 'services/gateway',              required: true },
  { name: 'sysadmin',      pkgPath: 'services/sysadmin',             required: false },
  { name: 'ext-utilities', pkgPath: 'examples/extension-utilities',  required: false },
  { name: 'ext-github',    pkgPath: 'examples/extension-github',     required: false },
  { name: 'ext-obsidian',  pkgPath: 'examples/extension-obsidian',   required: false },
];
const IMAGE_PREFIX = 'ghcr.io/the-baker-street-project/bakerst';

function readVersion(pkgPath) {
  const pkg = JSON.parse(readFileSync(join(ROOT, pkgPath, 'package.json'), 'utf-8'));
  return pkg.version;
}

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Read prompts.json and compute content hashes
// ---------------------------------------------------------------------------

const promptsMeta = JSON.parse(readFileSync(join(ROOT, 'operating_system', 'prompts.json'), 'utf-8'));
const prompts = {};

for (const [name, meta] of Object.entries(promptsMeta)) {
  const entry = { version: meta.version };

  // OS files live in operating_system/
  if (name.endsWith('.md')) {
    try {
      const content = readFileSync(join(ROOT, 'operating_system', name), 'utf-8');
      entry.contentHash = sha256(content);
    } catch {
      entry.contentHash = 'sha256:unknown';
    }
  }

  // Sysadmin prompts live in services/sysadmin/prompts/
  if (name.startsWith('sysadmin-')) {
    const promptFile = name.replace('sysadmin-', '') + '.md';
    try {
      const content = readFileSync(join(ROOT, 'services', 'sysadmin', 'prompts', promptFile), 'utf-8');
      entry.contentHash = sha256(content);
      // Inline sysadmin-runtime content into the manifest
      if (name === 'sysadmin-runtime') {
        entry.content = content;
      }
    } catch {
      entry.contentHash = 'sha256:unknown';
    }
  }

  prompts[name] = entry;
}

// ---------------------------------------------------------------------------
// Build images array
// ---------------------------------------------------------------------------

const images = components.map(({ name, pkgPath, required }) => {
  const version = readVersion(pkgPath);
  const digest = args[`${name}-digest`] ?? '';
  return {
    component: name,
    image: `${IMAGE_PREFIX}-${name}:${version}`,
    version,
    digest,
    required,
  };
});

// ---------------------------------------------------------------------------
// Build checksums from digests
// ---------------------------------------------------------------------------

const checksums = {};
for (const img of images) {
  if (img.digest) {
    checksums[img.image] = img.digest;
  }
}

// ---------------------------------------------------------------------------
// Assemble manifest
// ---------------------------------------------------------------------------

const manifest = {
  schemaVersion: 1,
  version: releaseVersion,
  date: new Date().toISOString(),
  minSysadminVersion: readVersion('services/sysadmin'),
  releaseNotes: `Baker Street ${releaseVersion}`,

  images,
  prompts,

  requiredSecrets: [
    {
      key: 'ANTHROPIC_API_KEY',
      description: 'Anthropic API key or OAuth token for Claude',
      required: true,
      inputType: 'secret',
      targetSecrets: ['bakerst-brain-secrets', 'bakerst-worker-secrets'],
    },
    {
      key: 'AUTH_TOKEN',
      description: 'API auth token (auto-generated if not provided)',
      required: false,
      inputType: 'secret',
      targetSecrets: ['bakerst-brain-secrets', 'bakerst-gateway-secrets'],
    },
    {
      key: 'AGENT_NAME',
      description: 'AI persona name',
      required: false,
      inputType: 'text',
      targetSecrets: ['bakerst-brain-secrets', 'bakerst-worker-secrets'],
    },
  ],

  optionalFeatures: [
    {
      id: 'telegram',
      name: 'Telegram Gateway',
      description: 'Enable Telegram bot adapter',
      defaultEnabled: false,
      secrets: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS'],
    },
    {
      id: 'discord',
      name: 'Discord Gateway',
      description: 'Enable Discord bot adapter',
      defaultEnabled: false,
      secrets: ['DISCORD_BOT_TOKEN'],
    },
    {
      id: 'voyage',
      name: 'Voyage Embeddings',
      description: 'Enable Voyage AI for long-term memory embeddings',
      defaultEnabled: true,
      secrets: ['VOYAGE_API_KEY'],
    },
    {
      id: 'github',
      name: 'GitHub Extension',
      description: 'Enable GitHub integration extension',
      defaultEnabled: false,
      secrets: ['GITHUB_TOKEN'],
    },
    {
      id: 'perplexity',
      name: 'Perplexity Search',
      description: 'Enable Perplexity AI search and research tools',
      defaultEnabled: false,
      secrets: ['PERPLEXITY_API_KEY'],
    },
    {
      id: 'obsidian',
      name: 'Obsidian Extension',
      description: 'Enable Obsidian vault integration',
      defaultEnabled: false,
      secrets: ['OBSIDIAN_VAULT_PATH'],
    },
  ],

  defaults: {
    agentName: 'Baker',
    namespace: 'bakerst',
    resourceProfile: 'standard',
  },

  checksums,
};

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Release manifest written to ${output}`);
console.log(`  Version: ${releaseVersion}`);
console.log(`  Images: ${images.length}`);
console.log(`  Prompts: ${Object.keys(prompts).length}`);
