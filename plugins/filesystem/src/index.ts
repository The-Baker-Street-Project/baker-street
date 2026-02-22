/**
 * Filesystem MCP Server — Tier 1 stdio skill.
 *
 * Provides sandboxed filesystem access (read_file, list_directory, file_info)
 * restricted to a configurable set of allowed paths (default: /tmp).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, normalize } from 'node:path';

// Parse allowed paths from environment (comma-separated) or default to /tmp
const ALLOWED_PATHS = (process.env.ALLOWED_PATHS ?? '/tmp')
  .split(',')
  .map((p) => resolve(normalize(p.trim())))
  .filter(Boolean);

/**
 * Validate that a target path is within one of the allowed base paths.
 * Prevents path traversal attacks.
 */
function validatePath(targetPath: string): string {
  const resolved = resolve(normalize(targetPath));

  const allowed = ALLOWED_PATHS.some(
    (base) => resolved === base || resolved.startsWith(base + '/'),
  );

  if (!allowed) {
    throw new Error(
      `Access denied: "${resolved}" is not within allowed paths [${ALLOWED_PATHS.join(', ')}]`,
    );
  }

  return resolved;
}

// Create the MCP server
const server = new McpServer(
  { name: 'filesystem-tools', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// Tool: read_file
server.tool(
  'read_file',
  'Read the contents of a file. Path must be within the allowed directories.',
  {
    path: z.string().describe('Absolute or relative path to the file to read'),
  },
  async (args) => {
    try {
      const resolvedPath = validatePath(args.path);
      const content = await readFile(resolvedPath, 'utf-8');
      return { content: [{ type: 'text' as const, text: content }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// Tool: list_directory
server.tool(
  'list_directory',
  'List entries in a directory. Path must be within the allowed directories.',
  {
    path: z.string().describe('Absolute or relative path to the directory to list'),
  },
  async (args) => {
    try {
      const resolvedPath = validatePath(args.path);
      const entries = await readdir(resolvedPath, { withFileTypes: true });
      const lines = entries.map((e) => {
        const suffix = e.isDirectory() ? '/' : '';
        return `${e.name}${suffix}`;
      });
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') || '(empty directory)' }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// Tool: file_info
server.tool(
  'file_info',
  'Get file metadata (size, modification time, type). Path must be within the allowed directories.',
  {
    path: z.string().describe('Absolute or relative path to the file or directory'),
  },
  async (args) => {
    try {
      const resolvedPath = validatePath(args.path);
      const stats = await stat(resolvedPath);
      const info = {
        path: resolvedPath,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        created: stats.birthtime.toISOString(),
        type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
        permissions: stats.mode.toString(8),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// Start stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Filesystem MCP server running (allowed paths: ${ALLOWED_PATHS.join(', ')})`);
}

main().catch((err) => {
  console.error('Fatal error starting filesystem MCP server:', err);
  process.exit(1);
});
