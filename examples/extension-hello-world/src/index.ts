import { createExtension } from '@bakerst/extension-sdk';
import { z } from 'zod';

const ext = createExtension({
  id: 'hello-world',
  name: 'Hello World',
  version: '0.1.0',
  description: 'A minimal example extension with greeting and time tools',
  tags: ['example'],
});

const greetSchema = { name: z.string() };

// Register tools on the MCP server
// @ts-expect-error — MCP SDK generics cause TS2589; tools register and work correctly at runtime
ext.server.tool('hello_greet', 'Greet someone by name', greetSchema, async ({ name }: { name: string }) => ({
  content: [{ type: 'text' as const, text: `Hello, ${name}! Greetings from the Hello World extension.` }],
}));

ext.server.tool('hello_time', 'Get the current server time', {}, async () => ({
  content: [{ type: 'text' as const, text: `The current server time is: ${new Date().toISOString()}` }],
}));

// Start the extension
ext.start().catch((err) => {
  console.error('Failed to start extension:', err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = () => ext.shutdown().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
