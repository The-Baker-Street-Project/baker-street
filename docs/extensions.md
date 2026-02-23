# Extensions

Pod-based extension system for Baker Street. Deploy a pod, get tools — no restarts, no config changes.

## Overview

Extensions let developers add tool capabilities to the Baker Street agent by deploying a Kubernetes pod. Each extension pod:

1. Announces itself on NATS
2. Serves tools via an MCP HTTP endpoint
3. Sends periodic heartbeats

Brain automatically discovers the extension, connects to its MCP server, discovers its tools, and makes them available to the agent. When the extension goes offline (missed heartbeats), its tools are removed. When it comes back, they reappear.

## How It Works

```
Extension Pod                          Brain Service
─────────────                          ─────────────
     │                                       │
     │  1. Publish NATS announce             │
     │──────────────────────────────────────>│
     │                                       │
     │  2. Brain connects to MCP endpoint    │
     │<──────────────────────────────────────│
     │                                       │
     │  3. Brain calls tools/list            │
     │<──────────────────────────────────────│
     │  4. Returns tool definitions          │
     │──────────────────────────────────────>│
     │                                       │
     │  5. Heartbeat every 30s               │
     │──────────────────────────────────────>│
     │                                       │
     │  6. Agent calls tool via MCP          │
     │<──────────────────────────────────────│
     │  7. Returns tool result               │
     │──────────────────────────────────────>│
     │                                       │
     │  (pod deleted)                        │
     │                                       │
     │           8. 90s timeout → offline    │
     │                        tools removed  │
```

## Quick Start

### 1. Create an extension

```typescript
import { createExtension } from '@bakerst/extension-sdk';
import { z } from 'zod';

const ext = createExtension({
  id: 'my-tools',
  name: 'My Tools',
  version: '0.1.0',
  description: 'Custom tools for my workflow',
});

ext.server.tool('my_tool', 'Does something useful', {
  input: z.string(),
}, async ({ input }) => ({
  content: [{ type: 'text', text: `Result: ${input}` }],
}));

ext.start();
```

### 2. Build a Docker image

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install && pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules ./node_modules/
USER 1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

### 3. Deploy to Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ext-my-tools
  namespace: bakerst
  labels:
    app: bakerst-extension      # Required for network policies
    extension: my-tools
spec:
  replicas: 1
  selector:
    matchLabels:
      app: bakerst-extension
      extension: my-tools
  template:
    metadata:
      labels:
        app: bakerst-extension  # Required for network policies
        extension: my-tools
    spec:
      containers:
        - name: my-tools
          image: my-registry/ext-my-tools:latest
          ports:
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: ext-my-tools
  namespace: bakerst
spec:
  selector:
    app: bakerst-extension
    extension: my-tools
  ports:
    - port: 8080
      targetPort: 8080
```

### 4. Enable the feature flag

Set `FEATURE_EXTENSIONS=true` in the brain deployment environment.

## NATS Protocol Reference

### Announce Message

Subject: `bakerst.extensions.announce`

```json
{
  "id": "my-tools",
  "name": "My Tools",
  "version": "0.1.0",
  "description": "Custom tools for my workflow",
  "mcpUrl": "http://ext-my-tools.bakerst.svc.cluster.local:8080/mcp",
  "transport": "streamable-http",
  "tools": ["my_tool"],
  "tags": ["custom"]
}
```

### Heartbeat Message

Subject: `bakerst.extensions.<id>.heartbeat`

```json
{
  "id": "my-tools",
  "timestamp": "2025-01-15T10:30:00Z",
  "uptime": 3600000,
  "activeRequests": 0
}
```

## Pod Requirements

| Requirement | Detail |
|-------------|--------|
| Namespace | `bakerst` |
| Label | `app: bakerst-extension` (required for network policies) |
| Port | `8080` (TCP, for MCP HTTP server) |
| NATS | Publish announce on startup, heartbeat every 30s |
| MCP | HTTP endpoint serving `tools/list` and `tools/call` |
| Timeout | 90s without heartbeat = marked offline |

## Security Model

Network policies restrict extension pods to:

- **Ingress**: Only brain can reach extensions (port 8080)
- **Egress**: Extensions can only reach NATS (port 4222)

Extensions cannot reach other services, the internet, or each other. If your extension needs external access, you'll need to add custom network policies.

## Building Without the SDK

The SDK is a convenience wrapper. Any language can implement an extension by:

1. Starting an MCP-compatible HTTP server (streamable-http transport)
2. Connecting to NATS and publishing an announce message
3. Sending heartbeat messages every 30 seconds

The MCP server must implement `tools/list` and `tools/call` methods per the [MCP specification](https://modelcontextprotocol.io).

## API

### GET /extensions

Returns a list of discovered extensions and their status.

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:30000/extensions
```

Response:
```json
[
  {
    "id": "hello-world",
    "name": "Hello World",
    "version": "0.1.0",
    "description": "A minimal example extension",
    "online": true,
    "skillId": "ext-hello-world"
  }
]
```

## Troubleshooting

**Extension not discovered**
- Check that `FEATURE_EXTENSIONS=true` is set in the brain env
- Verify the extension pod is running: `kubectl -n bakerst get pods -l app=bakerst-extension`
- Check brain logs: `kubectl -n bakerst logs deployment/brain -f | grep extension`
- Verify NATS connectivity from the extension pod

**Tools not appearing**
- Check that the MCP endpoint is reachable from brain: `kubectl -n bakerst exec deployment/brain -- curl http://ext-<id>.bakerst.svc.cluster.local:8080/health`
- Verify the MCP server responds to `tools/list`

**Extension going offline unexpectedly**
- Ensure heartbeats are sent every 30 seconds
- Check for NATS connection issues in extension logs
- The offline timeout is 90 seconds (3 missed heartbeats)

**Network policy blocking traffic**
- Ensure the pod has `app: bakerst-extension` label
- Check that the extension service name matches `ext-<id>` in the MCP URL
