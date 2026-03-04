import { describe, it, expect, beforeEach } from 'vitest';
import { ToolSearchIndex } from './tool-search.js';
import type { ToolDefinition } from '@bakerst/shared';

function makeTool(name: string, description: string): ToolDefinition {
  return { name, description, input_schema: { type: 'object' } };
}

describe('ToolSearchIndex', () => {
  let index: ToolSearchIndex;

  beforeEach(() => {
    index = new ToolSearchIndex();
  });

  it('returns empty array when no tools registered', () => {
    expect(index.search('anything')).toEqual([]);
  });

  it('indexes tools by server and finds by name match', () => {
    index.add('github', [
      makeTool('github_create_issue', 'Create a new GitHub issue'),
      makeTool('github_list_repos', 'List GitHub repositories'),
    ]);
    const results = index.search('create issue');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('github_create_issue');
  });

  it('scores server name matches', () => {
    index.add('github', [makeTool('create_item', 'Create something')]);
    index.add('browser', [makeTool('open_page', 'Open a web page')]);
    const results = index.search('github');
    expect(results[0].server).toBe('github');
  });

  it('removes tools by server', () => {
    index.add('github', [makeTool('github_create_issue', 'Create issue')]);
    index.remove('github');
    expect(index.search('github')).toEqual([]);
  });

  it('respects limit parameter', () => {
    index.add('test', Array.from({ length: 20 }, (_, i) =>
      makeTool(`tool_${i}`, `Tool number ${i} for testing`),
    ));
    const results = index.search('tool', 3);
    expect(results).toHaveLength(3);
  });

  it('returns full schema in results', () => {
    const tool = makeTool('my_tool', 'Does something');
    index.add('srv', [tool]);
    const results = index.search('my_tool');
    expect(results[0].fullSchema).toEqual(tool);
  });

  it('generates the search_tools tool definition', () => {
    const def = index.getSearchToolDefinition();
    expect(def.name).toBe('search_tools');
    expect(def.input_schema.properties).toHaveProperty('query');
  });

  it('count returns total indexed tools', () => {
    index.add('a', [makeTool('t1', 'd1')]);
    index.add('b', [makeTool('t2', 'd2'), makeTool('t3', 'd3')]);
    expect(index.count()).toBe(3);
  });
});
