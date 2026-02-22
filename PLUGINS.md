# Plugin System

Baker Street plugins extend the brain's capabilities by contributing tools that Claude can call during conversations. Each plugin registers tool definitions (name, description, JSON Schema) and provides handlers to execute them. The brain merges plugin tools with its built-in tools, routes `tool_use` calls to the correct plugin, and supports external triggers via webhook.

## Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │                   Brain                      │
                       │                                              │
PLUGINS.json ─────────►│  loadPlugins()                               │
                       │    ├── import(@bakerst/plugin-<name>)          │
                       │    ├── plugin.init(context)                   │
                       │    └── register tool → plugin mapping         │
                       │                                              │
                       │  createAgent()                               │
                       │    └── allTools = builtInTools                │
                       │                  + pluginRegistry.allTools()  │
                       │                                              │
                       │  Claude API  ◄──── tools: allTools ──────►   │
                       │    │                                         │
                       │    ▼  tool_use { name, input }               │
                       │  executeTool()                               │
                       │    ├── pluginRegistry.hasPlugin(name)?       │
                       │    │     └── pluginRegistry.execute(name, …) │
                       │    └── else: handle built-in tool            │
                       │                                              │
  POST /hooks/:plugin ─►  pluginRegistry.handleTrigger(name, event)  │
                       └──────────────────────────────────────────────┘
```

**Flow:**

1. On startup, `loadPlugins()` reads `PLUGINS.json`, dynamically imports each enabled package, calls `init()`, and builds a `toolName → plugin` map.
2. `createAgent()` merges built-in tools with `pluginRegistry.allTools()` and passes the combined list to every Claude API call.
3. When Claude returns a `tool_use` block, `executeTool()` checks `pluginRegistry.hasPlugin(toolName)` — if true, the call is routed to the plugin's `execute()` method; otherwise it's handled as a built-in tool.
4. External systems can POST to `/hooks/:plugin` to deliver trigger events, which are forwarded to the plugin's optional `onTrigger()` method.

## The BakerstPlugin Interface

All types are exported from `packages/shared/src/plugin.ts`.

### PluginToolDefinition

Describes a tool that Claude can call. Compatible with the Anthropic SDK `Tool` type.

```typescript
interface PluginToolDefinition {
  name: string;           // unique tool name, e.g. "gmail_search"
  description: string;    // shown to Claude as the tool description
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;  // JSON Schema for parameters
    required?: string[];
  };
}
```

### ToolResult

Returned by a plugin after executing a tool call.

```typescript
interface ToolResult {
  result: string;    // text content returned to Claude
  jobId?: string;    // optional job ID for async tracking
}
```

### PluginContext

Provided to `init()` — gives the plugin access to brain services.

```typescript
interface PluginContext {
  dispatcher: unknown;       // dispatch jobs to workers
  statusTracker: unknown;    // track job status
  memoryService: unknown;    // vector memory / knowledge base
  logger: {                  // pino-compatible logger
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    child(bindings: Record<string, unknown>): PluginContext['logger'];
  };
  config: Record<string, unknown>;  // plugin-specific config from PLUGINS.json
}
```

### TriggerEvent

Delivered to `onTrigger()` when an external system POSTs to `/hooks/:plugin`.

```typescript
interface TriggerEvent {
  source: string;                     // plugin name from URL
  event: string;                      // event type, e.g. "new_email"
  data: Record<string, unknown>;      // arbitrary payload
  timestamp: string;                  // ISO 8601
}
```

### BakerstPlugin

The main interface every plugin must implement.

```typescript
interface BakerstPlugin {
  name: string;        // unique plugin identifier
  version: string;     // semver
  description: string; // human-readable summary

  tools: PluginToolDefinition[];  // tools this plugin contributes

  init(context: PluginContext): Promise<void>;     // called once at startup
  shutdown(): Promise<void>;                       // called on graceful shutdown
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;

  // Optional: handle an external trigger event
  onTrigger?(event: TriggerEvent): Promise<string | null>;
}
```

## Configuration (PLUGINS.json)

Location: `operating_system/PLUGINS.json` (mounted into the brain container at `/etc/bakerst/PLUGINS.json` via the `bakerst-os` ConfigMap). The path can be overridden with the `PLUGINS_PATH` environment variable.

Format — a JSON array of plugin configs:

```json
[
  {
    "package": "@bakerst/plugin-my-plugin",
    "enabled": true,
    "config": {
      "key": "value"
    }
  }
]
```

| Field     | Type    | Description                                                    |
|-----------|---------|----------------------------------------------------------------|
| `package` | string  | npm package name — must be a pnpm workspace package            |
| `enabled` | boolean | set `false` to skip loading without removing the entry         |
| `config`  | object  | arbitrary config passed to the plugin via `PluginContext.config`|

## Creating a Plugin

### 1. Directory & package setup

Create `plugins/<name>/` with a standard workspace package:

```
plugins/my-plugin/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts    # default export implementing BakerstPlugin
    └── tools.ts    # tool definitions
```

**package.json:**

```json
{
  "name": "@bakerst/plugin-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@bakerst/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0"
  }
}
```

**tsconfig.json:**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### 2. Define tools

Create `src/tools.ts` with your tool definitions. Each tool needs a unique name, a description for Claude, and a JSON Schema `input_schema`:

```typescript
import type { PluginToolDefinition } from '@bakerst/shared';

export const myTools: PluginToolDefinition[] = [
  {
    name: 'my_plugin_do_thing',
    description: 'Does a thing. Describe clearly so Claude knows when to use it.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to do',
        },
      },
      required: ['query'],
    },
  },
];
```

Tool names must be globally unique across all plugins — the registry will log a warning and skip duplicates.

### 3. Implement handlers

Create handler functions that match the signature `(input: Record<string, unknown>) => Promise<ToolResult>`:

```typescript
import type { ToolResult, PluginContext } from '@bakerst/shared';

let log: PluginContext['logger'];

export function initHandlers(ctx: PluginContext): void {
  log = ctx.logger;
}

export async function doThing(input: Record<string, unknown>): Promise<ToolResult> {
  const { query } = input as { query: string };
  // ... your implementation ...
  return { result: `Done: ${query}` };
}
```

### 4. Entry point

Create `src/index.ts` with a default export implementing `BakerstPlugin`:

```typescript
import type { BakerstPlugin, PluginContext, ToolResult } from '@bakerst/shared';
import { myTools } from './tools.js';
import { initHandlers, doThing } from './handlers.js';

const toolHandlers: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>> = {
  my_plugin_do_thing: doThing,
};

const plugin: BakerstPlugin = {
  name: 'my-plugin',
  version: '0.1.0',
  description: 'Does useful things',

  tools: myTools,

  async init(context: PluginContext): Promise<void> {
    initHandlers(context);
  },

  async shutdown(): Promise<void> {
    // cleanup if needed
  },

  async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    const handler = toolHandlers[toolName];
    if (!handler) {
      return { result: `Unknown tool: ${toolName}` };
    }
    return handler(input);
  },
};

export default plugin;
```

### 5. Optional: triggers & webhooks

Implement `onTrigger` to handle events from external systems:

```typescript
async onTrigger(event: TriggerEvent): Promise<string | null> {
  if (event.event === 'something_happened') {
    return `Event received: ${JSON.stringify(event.data)}`;
  }
  return null;
}
```

External systems POST to the brain's webhook endpoint:

```bash
curl -X POST http://brain:3000/hooks/my-plugin \
  -H 'Content-Type: application/json' \
  -d '{"event": "something_happened", "data": {"key": "value"}}'
```

## Registering with the Brain

Three changes are needed to wire a new plugin into the brain:

### 1. Add dependency to `services/brain/package.json`

```json
{
  "dependencies": {
    "@bakerst/plugin-my-plugin": "workspace:*"
  }
}
```

Then run `pnpm install` from the repo root to link the workspace package.

### 2. Add to Dockerfile (`services/brain/Dockerfile`)

In the builder stage, copy the plugin's `package.json` and source, and add it to the build chain:

```dockerfile
# Copy plugin package.json (alongside existing plugins)
COPY plugins/my-plugin/package.json plugins/my-plugin/

# Copy plugin source (alongside existing plugins)
COPY plugins/my-plugin/ plugins/my-plugin/

# Build chain: shared → plugins → brain
RUN pnpm --filter=@bakerst/shared build \
 && pnpm --filter=@bakerst/plugin-my-plugin build \
 && pnpm --filter=@bakerst/brain build
```

In the production stage, copy the built output:

```dockerfile
COPY --from=builder /app/plugins/my-plugin/dist plugins/my-plugin/dist
```

### 3. Add to `operating_system/PLUGINS.json`

```json
[
  {
    "package": "@bakerst/plugin-my-plugin",
    "enabled": true,
    "config": {}
  }
]
```

## Build & Deploy

The plugin directory is already included in the pnpm workspace (`pnpm-workspace.yaml` lists `plugins/*`), so no workspace config changes are needed.

```bash
pnpm install                    # link new plugin workspace
pnpm -r build                   # compile everything
scripts/build.sh                # rebuild Docker images
scripts/deploy.sh               # apply K8s manifests (picks up PLUGINS.json via ConfigMap)
kubectl rollout restart deploy/brain -n bakerst   # restart to load new images
```

## Limitations & Future Work

- **No hot-reload** — adding or changing a plugin requires a rebuild and restart.
- **No distributed plugins** — plugins run in-process with the brain. There is no RPC mechanism for out-of-process plugins.
- **No plugin UI** — plugins cannot contribute UI components; they only add tools.
- **No dependency injection** — `PluginContext` services (`dispatcher`, `statusTracker`, `memoryService`) are typed as `unknown`. Plugins must cast them to use service-specific methods.
- **Tool name collisions** — handled by skipping duplicates with a warning, but there is no namespace enforcement.
