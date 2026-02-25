import { createExtension } from '@bakerst/extension-sdk';
import { readFile, writeFile, readdir, stat, mkdir, rename, unlink } from 'node:fs/promises';
import { join, relative, extname, dirname } from 'node:path';
import { z } from 'zod';

const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
if (!vaultPath) {
  console.error('OBSIDIAN_VAULT_PATH environment variable is required');
  process.exit(1);
}

const ext = createExtension({
  id: 'obsidian',
  name: 'Obsidian',
  version: '0.1.0',
  description: 'Read, write, and search notes in an Obsidian vault',
  tags: ['obsidian', 'notes', 'pkm', 'knowledge'],
});

const MAX_BODY = 16_384;

function truncate(text: string, max = MAX_BODY): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (truncated, ${text.length} chars total)`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

/** Resolve a vault-relative path, preventing directory traversal */
function resolve(notePath: string): string {
  const resolved = join(vaultPath!, notePath);
  if (!resolved.startsWith(vaultPath!)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

/** Ensure path has .md extension */
function ensureMd(p: string): string {
  return extname(p) === '' ? p + '.md' : p;
}

/** Parse YAML frontmatter from markdown content */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      frontmatter[key] = val;
    }
  }
  return { frontmatter, body: match[2] };
}

/** Recursively collect all .md files in a directory */
async function collectNotes(dir: string, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectNotes(full, base));
    } else if (entry.name.endsWith('.md')) {
      results.push(relative(base, full));
    }
  }
  return results;
}

// ---------- Read Tools ----------

ext.server.tool(
  'obsidian_read_note',
  'Read a note from the Obsidian vault. Path is relative to vault root (e.g. "Projects/Baker Street.md"). The .md extension is optional.',
  { path: z.string().describe('Vault-relative path to the note') },
  // @ts-expect-error — MCP SDK generics cause TS2589
  async ({ path }: { path: string }) => {
    try {
      const full = resolve(ensureMd(path));
      const content = await readFile(full, 'utf-8');
      return ok(`# ${path}\n\n${truncate(content)}`);
    } catch (e) {
      return err(`Failed to read note: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'obsidian_get_frontmatter',
  'Get the YAML frontmatter of a note as key-value pairs.',
  { path: z.string().describe('Vault-relative path to the note') },
  async ({ path }: { path: string }) => {
    try {
      const full = resolve(ensureMd(path));
      const content = await readFile(full, 'utf-8');
      const { frontmatter } = parseFrontmatter(content);
      if (Object.keys(frontmatter).length === 0) return ok(`${path}: no frontmatter found`);
      const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
      return ok(`Frontmatter for ${path}:\n${lines.join('\n')}`);
    } catch (e) {
      return err(`Failed to read frontmatter: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ---------- Write Tools ----------

ext.server.tool(
  'obsidian_write_note',
  'Create or overwrite a note in the vault. Parent directories are created automatically.',
  {
    path: z.string().describe('Vault-relative path'),
    content: z.string().describe('Full markdown content of the note'),
  },
  async ({ path, content }: { path: string; content: string }) => {
    try {
      const full = resolve(ensureMd(path));
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf-8');
      return ok(`Written: ${path} (${content.length} chars)`);
    } catch (e) {
      return err(`Failed to write note: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'obsidian_append_note',
  'Append content to an existing note. Creates the note if it does not exist.',
  {
    path: z.string().describe('Vault-relative path'),
    content: z.string().describe('Content to append'),
  },
  async ({ path, content }: { path: string; content: string }) => {
    try {
      const full = resolve(ensureMd(path));
      let existing = '';
      try {
        existing = await readFile(full, 'utf-8');
      } catch {
        await mkdir(dirname(full), { recursive: true });
      }
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      await writeFile(full, existing + separator + content, 'utf-8');
      return ok(`Appended to: ${path}`);
    } catch (e) {
      return err(`Failed to append: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ---------- Organization Tools ----------

ext.server.tool(
  'obsidian_move_note',
  'Move or rename a note within the vault.',
  {
    from: z.string().describe('Current vault-relative path'),
    to: z.string().describe('New vault-relative path'),
  },
  async ({ from, to }: { from: string; to: string }) => {
    try {
      const src = resolve(ensureMd(from));
      const dst = resolve(ensureMd(to));
      await mkdir(dirname(dst), { recursive: true });
      await rename(src, dst);
      return ok(`Moved: ${from} → ${to}`);
    } catch (e) {
      return err(`Failed to move note: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'obsidian_delete_note',
  'Delete a note from the vault.',
  { path: z.string().describe('Vault-relative path to the note') },
  async ({ path }: { path: string }) => {
    try {
      const full = resolve(ensureMd(path));
      await unlink(full);
      return ok(`Deleted: ${path}`);
    } catch (e) {
      return err(`Failed to delete note: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ---------- Search & Discovery Tools ----------

ext.server.tool(
  'obsidian_list_notes',
  'List all notes in the vault or a subfolder. Returns vault-relative paths.',
  { folder: z.string().optional().describe('Subfolder to list (default: vault root)') },
  async ({ folder }: { folder?: string }) => {
    try {
      const dir = folder ? resolve(folder) : vaultPath!;
      const notes = await collectNotes(dir, vaultPath!);
      notes.sort();
      if (notes.length === 0) return ok('No notes found.');
      return ok(`Notes (${notes.length}):\n${notes.join('\n')}`);
    } catch (e) {
      return err(`Failed to list notes: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'obsidian_search',
  'Search note contents for a text pattern (case-insensitive). Returns matching note paths with context.',
  {
    query: z.string().describe('Search text'),
    folder: z.string().optional().describe('Subfolder to search (default: entire vault)'),
    max_results: z.number().optional().describe('Maximum results to return (default: 20)'),
  },
  // @ts-expect-error — MCP SDK generics cause TS2589
  async ({ query, folder, max_results }: { query: string; folder?: string; max_results?: number }) => {
    try {
      const dir = folder ? resolve(folder) : vaultPath!;
      const notes = await collectNotes(dir, vaultPath!);
      const limit = max_results ?? 20;
      const pattern = query.toLowerCase();
      const matches: string[] = [];

      for (const note of notes) {
        if (matches.length >= limit) break;
        const content = await readFile(join(vaultPath!, note), 'utf-8');
        const lower = content.toLowerCase();
        const idx = lower.indexOf(pattern);
        if (idx >= 0) {
          const start = Math.max(0, idx - 80);
          const end = Math.min(content.length, idx + query.length + 80);
          const context = content.slice(start, end).replace(/\n/g, ' ');
          matches.push(`${note}\n  ...${context}...`);
        }
      }

      if (matches.length === 0) return ok(`No notes match "${query}".`);
      return ok(`Search results for "${query}" (${matches.length} matches):\n\n${matches.join('\n\n')}`);
    } catch (e) {
      return err(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'obsidian_find_links',
  'Find all wiki-links ([[target]]) and backlinks in a note. Returns outgoing links and notes that link to this note.',
  { path: z.string().describe('Vault-relative path to the note') },
  async ({ path }: { path: string }) => {
    try {
      const full = resolve(ensureMd(path));
      const content = await readFile(full, 'utf-8');
      const noteName = path.replace(/\.md$/, '');

      // Outgoing links: [[target]] or [[target|alias]]
      const outgoing = new Set<string>();
      const linkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      let match;
      while ((match = linkPattern.exec(content)) !== null) {
        outgoing.add(match[1]);
      }

      // Backlinks: scan all notes for links pointing to this note
      const allNotes = await collectNotes(vaultPath!, vaultPath!);
      const backlinks: string[] = [];
      for (const note of allNotes) {
        if (note === path) continue;
        const noteContent = await readFile(join(vaultPath!, note), 'utf-8');
        if (noteContent.includes(`[[${noteName}]]`) || noteContent.includes(`[[${noteName}|`)) {
          backlinks.push(note);
        }
      }

      const lines = [`Links for: ${path}`];
      lines.push(`\nOutgoing (${outgoing.size}):`);
      if (outgoing.size > 0) lines.push(...[...outgoing].map((l) => `  → [[${l}]]`));
      else lines.push('  (none)');
      lines.push(`\nBacklinks (${backlinks.length}):`);
      if (backlinks.length > 0) lines.push(...backlinks.map((l) => `  ← ${l}`));
      else lines.push('  (none)');

      return ok(lines.join('\n'));
    } catch (e) {
      return err(`Failed to find links: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'obsidian_recent',
  'List recently modified notes in the vault.',
  { count: z.number().optional().describe('Number of recent notes (default: 10)') },
  async ({ count }: { count?: number }) => {
    try {
      const limit = count ?? 10;
      const allNotes = await collectNotes(vaultPath!, vaultPath!);
      const withTimes: Array<{ path: string; mtime: Date }> = [];

      for (const note of allNotes) {
        const s = await stat(join(vaultPath!, note));
        withTimes.push({ path: note, mtime: s.mtime });
      }

      withTimes.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      const recent = withTimes.slice(0, limit);
      const lines = recent.map((n) => `${n.mtime.toISOString().slice(0, 16)}  ${n.path}`);
      return ok(`Recently modified (${recent.length}):\n${lines.join('\n')}`);
    } catch (e) {
      return err(`Failed to list recent: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// Start the extension
ext.start().catch((e) => {
  console.error('Failed to start Obsidian extension:', e);
  process.exit(1);
});

const shutdown = () => ext.shutdown().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
