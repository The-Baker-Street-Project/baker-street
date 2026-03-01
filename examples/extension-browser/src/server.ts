import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const NAME = "agent-browser-mcp";
const VERSION = "1.0.0";

export function createServer(): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION });
  registerTools(server);
  return server;
}

export { NAME, VERSION };
