#!/usr/bin/env node
import { connect, type NatsConnection, JSONCodec } from "nats";

// ── Configuration (all from env vars) ────────────────────────

const EXTENSION_ID = requiredEnv("EXTENSION_ID");
const EXTENSION_NAME = requiredEnv("EXTENSION_NAME");
const MCP_URL = requiredEnv("MCP_URL");

const EXTENSION_VERSION = process.env.EXTENSION_VERSION || "0.1.0";
const EXTENSION_DESCRIPTION = process.env.EXTENSION_DESCRIPTION || "";
const NATS_URL = process.env.NATS_URL || "nats://nats.bakerst.svc.cluster.local:4222";
const HEALTH_URL = process.env.HEALTH_URL || "";
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_INTERVAL || "30000", 10);
const TAGS = process.env.TAGS ? process.env.TAGS.split(",").map((t) => t.trim()) : [];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[nats-sidecar] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

// ── Health polling ───────────────────────────────────────────

async function waitForHealth(url: string): Promise<void> {
  console.error(`[nats-sidecar] Waiting for ${url} ...`);
  while (true) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.error(`[nats-sidecar] Health check passed`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ── Main ─────────────────────────────────────────────────────

const jc = JSONCodec();
const startTime = Date.now();
let nc: NatsConnection | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let shuttingDown = false;

async function main(): Promise<void> {
  // Wait for the main container to be healthy
  if (HEALTH_URL) {
    await waitForHealth(HEALTH_URL);
  }

  // Connect to NATS
  nc = await connect({ servers: NATS_URL, name: `ext-${EXTENSION_ID}` });
  console.error(`[nats-sidecar] Connected to NATS at ${NATS_URL}`);

  // Announce
  nc.publish(
    "bakerst.extensions.announce",
    jc.encode({
      id: EXTENSION_ID,
      name: EXTENSION_NAME,
      version: EXTENSION_VERSION,
      description: EXTENSION_DESCRIPTION,
      mcpUrl: MCP_URL,
      transport: "streamable-http",
      tags: TAGS.length > 0 ? TAGS : undefined,
    })
  );
  console.error(`[nats-sidecar] Announced "${EXTENSION_ID}" on NATS`);

  // Heartbeat
  heartbeatTimer = setInterval(() => {
    if (!nc || nc.isClosed()) return;
    nc.publish(
      `bakerst.extensions.${EXTENSION_ID}.heartbeat`,
      jc.encode({
        id: EXTENSION_ID,
        timestamp: new Date().toISOString(),
        uptime: Date.now() - startTime,
        activeRequests: 0,
      })
    );
  }, HEARTBEAT_MS);

  console.error(`[nats-sidecar] Heartbeat running every ${HEARTBEAT_MS}ms`);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.error("[nats-sidecar] Shutting down...");
  try {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (nc && !nc.isClosed()) await nc.drain();
    console.error("[nats-sidecar] Shutdown complete");
  } catch (err) {
    console.error("[nats-sidecar] Error during shutdown:", err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
  console.error("[nats-sidecar] Fatal error:", err);
  process.exit(1);
});
