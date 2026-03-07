#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const transport = process.argv.includes("--transport")
  ? process.argv[process.argv.indexOf("--transport") + 1]
  : process.env.TRANSPORT || "stdio";

async function main() {
  if (transport === "http") {
    const { startHttpServer } = await import("./http.js");
    await startHttpServer();
  } else {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    console.error("agent-browser-mcp server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
