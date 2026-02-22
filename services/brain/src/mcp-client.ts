/**
 * MCP Client Manager — manages connections to MCP servers via stdio or HTTP transports.
 *
 * Each connected skill gets its own MCP Client instance. The manager handles
 * connecting, listing tools, calling tools, and graceful shutdown.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger, type SkillTransport } from '@bakerst/shared';

const log = logger.child({ module: 'mcp-client' });

/** Tool info returned from MCP list_tools */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** Result from calling an MCP tool */
export interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface ConnectedClient {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
}

export class McpClientManager {
  private clients = new Map<string, ConnectedClient>();

  /**
   * Connect to an MCP server via stdio transport.
   * Spawns the command as a child process and communicates over stdin/stdout.
   */
  async connectStdio(skillId: string, command: string, args: string[] = [], env?: Record<string, string>): Promise<void> {
    if (this.clients.has(skillId)) {
      log.warn({ skillId }, 'skill already connected, closing existing connection');
      await this.close(skillId);
    }

    log.info({ skillId, command, args }, 'connecting MCP client via stdio');

    const client = new Client(
      { name: `bakerst-${skillId}`, version: '1.0.0' },
      { capabilities: {} },
    );

    const transport = new StdioClientTransport({
      command,
      args,
      env: env ? { ...process.env, ...env } as Record<string, string> : undefined,
    });

    // Handle transport errors to prevent unhandled exceptions crashing the process
    client.onerror = (err) => {
      log.error({ err, skillId }, 'MCP client error, cleaning up connection');
      this.clients.delete(skillId);
    };

    try {
      await client.connect(transport);
      this.clients.set(skillId, { client, transport });
      log.info({ skillId }, 'MCP client connected via stdio');
    } catch (err) {
      log.error({ err, skillId, command }, 'failed to connect MCP client via stdio');
      throw err;
    }
  }

  /**
   * Connect to an MCP server via HTTP transport.
   * Supports both SSE (legacy) and streamable-http (modern) transports.
   */
  async connectHttp(skillId: string, url: string, transportType: SkillTransport = 'streamable-http', headers?: Record<string, string>): Promise<void> {
    if (this.clients.has(skillId)) {
      log.warn({ skillId }, 'skill already connected, closing existing connection');
      await this.close(skillId);
    }

    log.info({ skillId, url, transportType }, 'connecting MCP client via HTTP');

    const client = new Client(
      { name: `bakerst-${skillId}`, version: '1.0.0' },
      { capabilities: {} },
    );

    let transport: SSEClientTransport | StreamableHTTPClientTransport;
    const requestInit: RequestInit | undefined = headers ? { headers } : undefined;

    if (transportType === 'http') {
      // Legacy SSE transport
      transport = new SSEClientTransport(new URL(url), { requestInit });
    } else {
      // Modern streamable-http transport
      transport = new StreamableHTTPClientTransport(new URL(url), { requestInit });
    }

    // Handle transport errors to prevent unhandled exceptions crashing the process
    client.onerror = (err) => {
      log.error({ err, skillId }, 'MCP client error, cleaning up connection');
      this.clients.delete(skillId);
    };

    try {
      await client.connect(transport);
      this.clients.set(skillId, { client, transport });
      log.info({ skillId }, 'MCP client connected via HTTP');
    } catch (err) {
      log.error({ err, skillId, url }, 'failed to connect MCP client via HTTP');
      throw err;
    }
  }

  /**
   * List all tools available from a connected MCP server.
   */
  async listTools(skillId: string): Promise<McpToolInfo[]> {
    const entry = this.clients.get(skillId);
    if (!entry) {
      throw new Error(`MCP client not connected for skill: ${skillId}`);
    }

    const result = await entry.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as McpToolInfo['inputSchema'],
    }));
  }

  /**
   * Call a tool on a connected MCP server.
   */
  async callTool(skillId: string, toolName: string, input: Record<string, unknown>): Promise<McpToolResult> {
    const entry = this.clients.get(skillId);
    if (!entry) {
      throw new Error(`MCP client not connected for skill: ${skillId}`);
    }

    log.info({ skillId, toolName }, 'calling MCP tool');

    try {
      const result = await entry.client.callTool({
        name: toolName,
        arguments: input,
      });

      return {
        content: (result.content ?? []) as McpToolResult['content'],
        isError: result.isError as boolean | undefined,
      };
    } catch (err) {
      log.error({ err, skillId, toolName }, 'MCP tool call failed');
      throw err;
    }
  }

  /** Check if a skill is currently connected */
  isConnected(skillId: string): boolean {
    return this.clients.has(skillId);
  }

  /** Close a specific skill's MCP client connection */
  async close(skillId: string): Promise<void> {
    const entry = this.clients.get(skillId);
    if (!entry) return;

    try {
      await entry.client.close();
      log.info({ skillId }, 'MCP client closed');
    } catch (err) {
      log.error({ err, skillId }, 'error closing MCP client');
    } finally {
      this.clients.delete(skillId);
    }
  }

  /** Close all MCP client connections */
  async closeAll(): Promise<void> {
    const skillIds = [...this.clients.keys()];
    for (const skillId of skillIds) {
      await this.close(skillId);
    }
    log.info({ count: skillIds.length }, 'all MCP clients closed');
  }
}
