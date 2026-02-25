import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { connect, type NatsConnection } from 'nats';
import { codec, Subjects, type ExtensionAnnounce, type ExtensionHeartbeat } from '@bakerst/shared';

export interface ExtensionConfig {
  /** DNS-safe unique ID (e.g., "weather-tools") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semver version */
  version: string;
  /** Description of what this extension provides */
  description: string;
  /** Port to listen on (default: 8080) */
  port?: number;
  /** NATS server URL (default: nats://nats.bakerst.svc.cluster.local:4222) */
  natsUrl?: string;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;
  /** Tags for categorization */
  tags?: string[];
}

export interface Extension {
  /** The MCP server instance — register tools on this */
  server: McpServer;
  /** Start the extension (HTTP server + NATS announce + heartbeat) */
  start(): Promise<void>;
  /** Gracefully shut down */
  shutdown(): Promise<void>;
}

export function createExtension(config: ExtensionConfig): Extension {
  const port = config.port ?? 8080;
  const natsUrl = config.natsUrl ?? 'nats://nats.bakerst.svc.cluster.local:4222';
  const heartbeatMs = config.heartbeatInterval ?? 30_000;

  // The "template" server where developers register tools.
  const server = new McpServer({
    name: config.name,
    version: config.version,
  });

  // Track active sessions — each client gets its own transport + McpServer pair.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  let nc: NatsConnection | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let httpServer: ReturnType<typeof express.prototype.listen> | undefined;
  const startTime = Date.now();

  // Create a per-session McpServer with the same tools as the template.
  function createSessionServer(): McpServer {
    const s = new McpServer({ name: config.name, version: config.version });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = (server as any)._registeredTools;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dst = (s as any)._registeredTools;
    if (src && typeof src === 'object') {
      for (const name of Object.keys(src)) {
        dst[name] = src[name];
      }
    }
    // Ensure the tools/list and tools/call request handlers are registered.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any).setToolRequestHandlers();
    return s;
  }

  async function start(): Promise<void> {
    const app = express();
    app.use(express.json());

    app.post('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      // Existing session — route to its transport
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.handleRequest(req, res, req.body);
        return;
      }

      // New client — create a fresh transport + server
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };

      const sessionServer = createSessionServer();
      await sessionServer.connect(transport);
      await transport.handleRequest(req, res, req.body);

      // After handleRequest, the session ID has been assigned
      const newSessionId = transport.sessionId;
      if (newSessionId) {
        sessions.set(newSessionId, transport);
      }
    });

    app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.handleRequest(req, res);
      } else {
        res.status(400).json({ error: 'No active session' });
      }
    });

    app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        sessions.delete(sessionId);
      } else {
        res.status(400).json({ error: 'No active session' });
      }
    });

    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', id: config.id, version: config.version });
    });

    await new Promise<void>((resolve) => {
      httpServer = app.listen(port, () => {
        console.log(`[${config.name}] MCP server listening on port ${port}`);
        resolve();
      });
    });

    // Connect to NATS and announce
    nc = await connect({ servers: natsUrl, name: `ext-${config.id}` });
    console.log(`[${config.name}] Connected to NATS`);

    const mcpUrl = `http://ext-${config.id}.bakerst.svc.cluster.local:${port}/mcp`;

    const announce: ExtensionAnnounce = {
      id: config.id,
      name: config.name,
      version: config.version,
      description: config.description,
      mcpUrl,
      transport: 'streamable-http',
      tags: config.tags,
    };

    nc.publish(Subjects.EXTENSION_ANNOUNCE, codec.encode(announce));
    console.log(`[${config.name}] Announced on NATS`);

    // Start heartbeat loop (re-announces on each heartbeat so the brain
    // picks up extensions even if it missed the initial announcement)
    heartbeatTimer = setInterval(() => {
      if (!nc || nc.isClosed()) return;

      // Re-announce so brain discovers us if it started after us
      nc.publish(Subjects.EXTENSION_ANNOUNCE, codec.encode(announce));

      const hb: ExtensionHeartbeat = {
        id: config.id,
        timestamp: new Date().toISOString(),
        uptime: Date.now() - startTime,
        activeRequests: 0,
      };
      nc.publish(Subjects.extensionHeartbeat(config.id), codec.encode(hb));
    }, heartbeatMs);
  }

  async function shutdown(): Promise<void> {
    console.log(`[${config.name}] Shutting down...`);

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    if (nc && !nc.isClosed()) {
      await nc.drain();
    }

    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err: Error | undefined) => (err ? reject(err) : resolve()));
      });
    }

    console.log(`[${config.name}] Shut down complete`);
  }

  return { server, start, shutdown };
}
