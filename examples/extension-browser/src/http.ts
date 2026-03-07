import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { connect, type NatsConnection, JSONCodec } from "nats";
import { createServer, NAME, VERSION } from "./server.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const NATS_URL = process.env.NATS_URL || "nats://nats.bakerst.svc.cluster.local:4222";
const EXTENSION_ID = process.env.EXTENSION_ID || "agent-browser";
const HEARTBEAT_MS = 30_000;
const startTime = Date.now();

const sessions = new Map<string, StreamableHTTPServerTransport>();
const jc = JSONCodec();

export async function startHttpServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  // Express 4 does not handle async rejections — wrap handlers to catch errors
  function asyncHandler(
    fn: (req: express.Request, res: express.Response) => Promise<void>
  ) {
    return (req: express.Request, res: express.Response) => {
      fn(req, res).catch((err) => {
        console.error(`[${NAME}] Request error:`, err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal server error" });
        }
      });
    };
  }

  // ── MCP Streamable-HTTP endpoint ────────────────────────────

  app.post("/mcp", asyncHandler(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    const newSessionId = transport.sessionId;
    if (newSessionId) {
      sessions.set(newSessionId, transport);
    }
  }));

  app.get("/mcp", asyncHandler(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res);
    } else {
      res.status(400).json({ error: "No active session" });
    }
  }));

  app.delete("/mcp", asyncHandler(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
      sessions.delete(sessionId);
    } else {
      res.status(400).json({ error: "No active session" });
    }
  }));

  // ── Health endpoint ─────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", id: EXTENSION_ID, version: VERSION });
  });

  // ── Start HTTP server ───────────────────────────────────────

  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(PORT, () => {
      console.error(`[${NAME}] HTTP server listening on port ${PORT}`);
      resolve(s);
    });
  });

  // ── NATS announce + heartbeat ───────────────────────────────

  let nc: NatsConnection | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  try {
    nc = await connect({ servers: NATS_URL, name: `ext-${EXTENSION_ID}` });
    console.error(`[${NAME}] Connected to NATS at ${NATS_URL}`);

    const mcpUrl = `http://ext-${EXTENSION_ID}.bakerst.svc.cluster.local:${PORT}/mcp`;

    nc.publish(
      "bakerst.extensions.announce",
      jc.encode({
        id: EXTENSION_ID,
        name: "Agent Browser",
        version: VERSION,
        description: "AI-driven browser automation via Vercel agent-browser",
        mcpUrl,
        transport: "streamable-http",
        tags: ["browser", "automation"],
      })
    );
    console.error(`[${NAME}] Announced on NATS as "${EXTENSION_ID}"`);

    heartbeatTimer = setInterval(() => {
      if (!nc || nc.isClosed()) return;
      nc.publish(
        `bakerst.extensions.${EXTENSION_ID}.heartbeat`,
        jc.encode({
          id: EXTENSION_ID,
          timestamp: new Date().toISOString(),
          uptime: Date.now() - startTime,
          activeRequests: sessions.size,
        })
      );
    }, HEARTBEAT_MS);
  } catch (err) {
    console.error(`[${NAME}] NATS connection failed (running without discovery): ${err}`);
  }

  // ── Graceful shutdown ───────────────────────────────────────

  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.error(`[${NAME}] Shutting down...`);
    try {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (nc && !nc.isClosed()) await nc.drain();

      for (const transport of sessions.values()) {
        await transport.close().catch(() => {});
      }
      sessions.clear();

      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      console.error(`[${NAME}] Shutdown complete`);
    } catch (err) {
      console.error(`[${NAME}] Error during shutdown:`, err);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
