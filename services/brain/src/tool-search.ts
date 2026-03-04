import type { ToolDefinition } from '@bakerst/shared';

export interface ToolIndexEntry {
  name: string;
  description: string;
  server: string;
  fullSchema: ToolDefinition;
}

export class ToolSearchIndex {
  private entries: ToolIndexEntry[] = [];

  /** Register tools from a server (extension, plugin, etc.) */
  add(server: string, tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.entries.push({
        name: tool.name,
        description: tool.description,
        server,
        fullSchema: tool,
      });
    }
  }

  /** Remove all tools from a server (e.g. extension disconnect) */
  remove(server: string): void {
    this.entries = this.entries.filter((e) => e.server !== server);
  }

  /** Search tools by keyword. Scores name (3x), server (2x), description (1x). */
  search(query: string, limit = 5): ToolIndexEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    return this.entries
      .map((entry) => {
        const nameLower = entry.name.toLowerCase();
        const descLower = entry.description.toLowerCase();
        const serverLower = entry.server.toLowerCase();

        let score = 0;
        for (const term of terms) {
          if (nameLower.includes(term)) score += 3;
          if (serverLower.includes(term)) score += 2;
          if (descLower.includes(term)) score += 1;
        }
        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  /** Total indexed tools */
  count(): number {
    return this.entries.length;
  }

  /** The single tool definition exposed to the LLM */
  getSearchToolDefinition(): ToolDefinition {
    const servers = [...new Set(this.entries.map((e) => e.server))];
    const categoryHint = servers.length > 0
      ? ` Available categories: ${servers.join(', ')}.`
      : '';

    return {
      name: 'search_tools',
      description:
        'Search for available tools by keyword or capability.' +
        categoryHint +
        ' Call this before attempting to use an extension tool.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: "What you want to do, e.g. 'create a github issue' or 'browse a website'",
          },
          limit: {
            type: 'number',
            description: 'Max results (default 5)',
          },
        },
        required: ['query'],
      },
    };
  }
}
