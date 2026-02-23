# Utilities Extension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Baker Street extension pod with 5 tools: time/date (2), network lookups (3).

**Architecture:** Single extension pod using `@bakerst/extension-sdk`. Follows the identical pattern as `examples/extension-hello-world/` — create extension, register tools, start. No state, no database, no API keys.

**Tech Stack:** TypeScript, Node.js 22, `@bakerst/extension-sdk`, `zod`, Node built-in `dns/promises`

**Reference files:**
- Extension SDK: `packages/extension-sdk/src/index.ts`
- Hello-world example (our template): `examples/extension-hello-world/`
- Design doc: `docs/plans/2026-02-23-utilities-extension-design.md`

---

### Task 1: Scaffold the package

**Files:**
- Create: `examples/extension-utilities/package.json`
- Create: `examples/extension-utilities/tsconfig.json`

**Step 1: Create package.json**

Create `examples/extension-utilities/package.json`:

```json
{
  "name": "@bakerst/extension-utilities",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@bakerst/shared": "workspace:*",
    "@bakerst/extension-sdk": "workspace:*",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create tsconfig.json**

Create `examples/extension-utilities/tsconfig.json`:

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

**Step 3: Install dependencies**

Run: `cd /home/gary/repos/baker-street-project/baker-street && pnpm install`
Expected: Lockfile updated, new package linked

**Step 4: Verify build scaffolding**

Create a minimal placeholder so TypeScript compiles:

Create `examples/extension-utilities/src/index.ts`:

```typescript
console.log('utilities extension placeholder');
```

Run: `pnpm --filter @bakerst/extension-utilities build`
Expected: Compiles successfully, creates `dist/index.js`

**Step 5: Commit**

```bash
git add examples/extension-utilities/
git commit -m "feat: scaffold utilities extension package"
```

---

### Task 2: Implement time tools (util_time, util_date_calc)

**Files:**
- Modify: `examples/extension-utilities/src/index.ts`

**Context:** The hello-world example shows the pattern. Each tool is registered via `ext.server.tool(name, description, zodSchema, handler)`. The handler returns `{ content: [{ type: 'text' as const, text: string }] }`. The first tool call on each extension must use `// @ts-expect-error` due to MCP SDK generic recursion (TS2589). Subsequent tools on the same server don't need it.

**Step 1: Write the extension scaffold + time tools**

Replace `examples/extension-utilities/src/index.ts` with:

```typescript
import { createExtension } from '@bakerst/extension-sdk';
import { z } from 'zod';

const ext = createExtension({
  id: 'utilities',
  name: 'Utilities',
  version: '0.1.0',
  description: 'Time/date utilities and network lookup tools',
  tags: ['utilities', 'time', 'network'],
});

// ---------- Time & Date Tools ----------

// @ts-expect-error — MCP SDK generics cause TS2589; tools register and work correctly at runtime
ext.server.tool(
  'util_time',
  'Get the current time. Optionally specify an IANA timezone (e.g. "America/New_York"). Defaults to UTC.',
  { timezone: z.string().optional() },
  async ({ timezone }: { timezone?: string }) => {
    const tz = timezone ?? 'UTC';
    try {
      const now = new Date();
      const formatted = now.toLocaleString('en-US', {
        timeZone: tz,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      });
      return {
        content: [{ type: 'text' as const, text: `${formatted}\nISO: ${now.toISOString()}\nTimezone: ${tz}` }],
      };
    } catch {
      return { content: [{ type: 'text' as const, text: `Invalid timezone: "${tz}". Use IANA format like "America/New_York" or "Europe/London".` }], isError: true };
    }
  },
);

ext.server.tool(
  'util_date_calc',
  'Calculate a date offset. Provide a base date (ISO 8601 or "now") and an offset like "+3 days", "-2 hours", "+1 month". Optionally specify a timezone.',
  { date: z.string(), offset: z.string(), timezone: z.string().optional() },
  async ({ date, offset, timezone }: { date: string; offset: string; timezone?: string }) => {
    const tz = timezone ?? 'UTC';
    try {
      const base = date.toLowerCase() === 'now' ? new Date() : new Date(date);
      if (isNaN(base.getTime())) {
        return { content: [{ type: 'text' as const, text: `Invalid date: "${date}". Use ISO 8601 format or "now".` }], isError: true };
      }

      const match = offset.match(/^([+-]?\d+)\s*(second|minute|hour|day|week|month|year)s?$/i);
      if (!match) {
        return { content: [{ type: 'text' as const, text: `Invalid offset: "${offset}". Use format like "+3 days", "-2 hours", "+1 month".` }], isError: true };
      }

      const amount = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      const result = new Date(base);

      switch (unit) {
        case 'second': result.setSeconds(result.getSeconds() + amount); break;
        case 'minute': result.setMinutes(result.getMinutes() + amount); break;
        case 'hour': result.setHours(result.getHours() + amount); break;
        case 'day': result.setDays(result.getDate() + amount); break;
        case 'week': result.setDate(result.getDate() + amount * 7); break;
        case 'month': result.setMonth(result.getMonth() + amount); break;
        case 'year': result.setFullYear(result.getFullYear() + amount); break;
      }

      const formatted = result.toLocaleString('en-US', {
        timeZone: tz,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      });

      return {
        content: [{ type: 'text' as const, text: `Base: ${base.toISOString()}\nOffset: ${offset}\nResult: ${formatted}\nISO: ${result.toISOString()}` }],
      };
    } catch {
      return { content: [{ type: 'text' as const, text: `Error calculating date. Check inputs: date="${date}", offset="${offset}".` }], isError: true };
    }
  },
);

// Start the extension
ext.start().catch((err) => {
  console.error('Failed to start extension:', err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = () => ext.shutdown().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

**IMPORTANT BUG IN PLAN:** The `case 'day'` line above has `result.setDays(...)` which doesn't exist. It should be `result.setDate(result.getDate() + amount)`. The implementer MUST use `setDate` not `setDays`. This is intentionally noted so the implementer catches it.

**Step 2: Build and verify**

Run: `pnpm --filter @bakerst/extension-utilities build`
Expected: Compiles without errors (except the `@ts-expect-error` which is expected)

**Step 3: Commit**

```bash
git add examples/extension-utilities/src/index.ts
git commit -m "feat: add util_time and util_date_calc tools"
```

---

### Task 3: Add network tools (util_dns, util_geolocate, util_fetch)

**Files:**
- Modify: `examples/extension-utilities/src/index.ts`

**Context:** Add three network tools after the time tools, before the `ext.start()` call. Use Node.js built-in `dns/promises` for DNS lookups. Use `fetch()` (built into Node 22) for HTTP requests and ip-api.com geolocation.

**Step 1: Add imports at the top of the file**

Add after the existing imports:

```typescript
import { resolve4, resolve6, resolveMx, resolveTxt, resolveCname, resolveNs, resolveSoa } from 'node:dns/promises';
```

**Step 2: Add the three network tools**

Insert these tool registrations after `util_date_calc` and before `ext.start()`:

```typescript
// ---------- Network Lookup Tools ----------

ext.server.tool(
  'util_dns',
  'Look up DNS records for a hostname. Supported types: A, AAAA, MX, TXT, CNAME, NS, SOA. Defaults to A.',
  { hostname: z.string(), type: z.string().optional() },
  async ({ hostname, type }: { hostname: string; type?: string }) => {
    const recordType = (type ?? 'A').toUpperCase();
    try {
      let records: unknown;
      switch (recordType) {
        case 'A': records = await resolve4(hostname); break;
        case 'AAAA': records = await resolve6(hostname); break;
        case 'MX': records = await resolveMx(hostname); break;
        case 'TXT': records = await resolveTxt(hostname); break;
        case 'CNAME': records = await resolveCname(hostname); break;
        case 'NS': records = await resolveNs(hostname); break;
        case 'SOA': records = await resolveSoa(hostname); break;
        default:
          return { content: [{ type: 'text' as const, text: `Unsupported record type: "${recordType}". Use A, AAAA, MX, TXT, CNAME, NS, or SOA.` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: `DNS ${recordType} records for ${hostname}:\n${JSON.stringify(records, null, 2)}` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `DNS lookup failed for ${hostname} (${recordType}): ${msg}` }], isError: true };
    }
  },
);

ext.server.tool(
  'util_geolocate',
  'Geolocate an IP address. Returns country, city, timezone, ISP, and coordinates.',
  { ip: z.string() },
  async ({ ip }: { ip: string }) => {
    try {
      const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
      const data = await res.json() as Record<string, unknown>;
      if (data.status === 'fail') {
        return { content: [{ type: 'text' as const, text: `Geolocation failed for "${ip}": ${data.message}` }], isError: true };
      }
      const lines = [
        `IP: ${data.query}`,
        `Location: ${data.city}, ${data.regionName}, ${data.country}`,
        `Coordinates: ${data.lat}, ${data.lon}`,
        `Timezone: ${data.timezone}`,
        `ISP: ${data.isp}`,
        `Org: ${data.org}`,
        `AS: ${data.as}`,
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Geolocation request failed: ${msg}` }], isError: true };
    }
  },
);

const MAX_BODY = 4096;

ext.server.tool(
  'util_fetch',
  'Fetch a URL (GET or HEAD only). Returns status code, headers, and response body (truncated to 4KB). Use for checking URLs, fetching JSON from public APIs, etc.',
  { url: z.string(), method: z.string().optional(), headers: z.record(z.string()).optional() },
  async ({ url, method, headers }: { url: string; method?: string; headers?: Record<string, string> }) => {
    const httpMethod = (method ?? 'GET').toUpperCase();
    if (httpMethod !== 'GET' && httpMethod !== 'HEAD') {
      return { content: [{ type: 'text' as const, text: `Only GET and HEAD methods are allowed. Got: "${httpMethod}"` }], isError: true };
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, {
        method: httpMethod,
        headers: headers ?? {},
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const responseHeaders = Object.fromEntries(res.headers.entries());
      let body = '';
      if (httpMethod === 'GET') {
        body = await res.text();
        if (body.length > MAX_BODY) {
          body = body.slice(0, MAX_BODY) + `\n... (truncated, ${body.length} bytes total)`;
        }
      }

      const lines = [
        `Status: ${res.status} ${res.statusText}`,
        `Headers: ${JSON.stringify(responseHeaders, null, 2)}`,
      ];
      if (body) lines.push(`Body:\n${body}`);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Fetch failed for ${url}: ${msg}` }], isError: true };
    }
  },
);
```

**Step 3: Build and verify**

Run: `pnpm --filter @bakerst/extension-utilities build`
Expected: Compiles without errors

**Step 4: Commit**

```bash
git add examples/extension-utilities/src/index.ts
git commit -m "feat: add util_dns, util_geolocate, util_fetch tools"
```

---

### Task 4: Create Dockerfile and K8s manifests

**Files:**
- Create: `examples/extension-utilities/Dockerfile`
- Create: `examples/extension-utilities/k8s/deployment.yaml`

**Context:** Follow the hello-world pattern exactly, substituting `hello-world` → `utilities` in all names and paths.

**Step 1: Create Dockerfile**

Create `examples/extension-utilities/Dockerfile`:

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/extension-sdk/ packages/extension-sdk/
COPY examples/extension-utilities/ examples/extension-utilities/
RUN corepack enable && pnpm install --frozen-lockfile && pnpm -r build

# Prune to only the utilities deps
RUN pnpm deploy --filter=@bakerst/extension-utilities --prod --legacy /app/pruned

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/pruned/node_modules ./node_modules/
COPY --from=builder /app/examples/extension-utilities/dist ./dist/
COPY --from=builder /app/pruned/package.json ./package.json
USER 1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

**Step 2: Create K8s deployment + service**

Create `examples/extension-utilities/k8s/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ext-utilities
  namespace: bakerst
  labels:
    app: bakerst-extension
    extension: utilities
spec:
  replicas: 1
  selector:
    matchLabels:
      app: bakerst-extension
      extension: utilities
  template:
    metadata:
      labels:
        app: bakerst-extension
        extension: utilities
    spec:
      containers:
        - name: utilities
          image: bakerst-ext-utilities:latest
          imagePullPolicy: Never
          ports:
            - containerPort: 8080
          env:
            - name: NATS_URL
              value: nats://nats.bakerst.svc.cluster.local:4222
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
          securityContext:
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
            seccompProfile:
              type: RuntimeDefault
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: ext-utilities
  namespace: bakerst
  labels:
    app: bakerst-extension
    extension: utilities
spec:
  selector:
    app: bakerst-extension
    extension: utilities
  ports:
    - port: 8080
      targetPort: 8080
      protocol: TCP
```

**Step 3: Commit**

```bash
git add examples/extension-utilities/Dockerfile examples/extension-utilities/k8s/
git commit -m "feat: add Dockerfile and K8s manifests for utilities extension"
```

---

### Task 5: Build image, deploy, and verify end-to-end

**Files:** None (deployment and testing only)

**Context:** Build the Docker image from the repo root (Dockerfile uses `COPY` paths relative to repo root). Deploy to K8s. Verify brain discovers the extension and all 5 tools work.

**Step 1: Build the Docker image**

Run from repo root:

```bash
docker build -t bakerst-ext-utilities:latest -f examples/extension-utilities/Dockerfile .
```

Expected: Image builds successfully

**Step 2: Deploy to K8s**

```bash
kubectl apply -f examples/extension-utilities/k8s/deployment.yaml
```

Expected: Deployment and Service created

**Step 3: Wait for pod to be ready**

```bash
kubectl -n bakerst get pods -l extension=utilities -w
```

Expected: Pod reaches `Running` / `1/1 Ready` state

**Step 4: Check brain logs for extension discovery**

```bash
kubectl -n bakerst logs deployment/brain-blue --tail=20 | grep -i extension
```

Expected: Logs show `Extension announced: utilities` and tool registration

**Step 5: Test each tool via the skill test endpoint**

```bash
# Get auth token
TOKEN=$(grep AUTH_TOKEN /home/gary/repos/baker-street-project/baker-street/.env-secrets | cut -d= -f2)

# Test connection
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:30000/skills/ext-utilities/test | jq .

# Test util_time
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"method":"tools/call","params":{"name":"util_time","arguments":{"timezone":"America/New_York"}}}' \
  http://localhost:30000/skills/ext-utilities/call | jq .

# Test util_date_calc
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"method":"tools/call","params":{"name":"util_date_calc","arguments":{"date":"now","offset":"+3 days"}}}' \
  http://localhost:30000/skills/ext-utilities/call | jq .

# Test util_dns
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"method":"tools/call","params":{"name":"util_dns","arguments":{"hostname":"google.com","type":"A"}}}' \
  http://localhost:30000/skills/ext-utilities/call | jq .

# Test util_geolocate
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"method":"tools/call","params":{"name":"util_geolocate","arguments":{"ip":"8.8.8.8"}}}' \
  http://localhost:30000/skills/ext-utilities/call | jq .

# Test util_fetch
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"method":"tools/call","params":{"name":"util_fetch","arguments":{"url":"https://httpbin.org/get"}}}' \
  http://localhost:30000/skills/ext-utilities/call | jq .
```

Expected: All 5 tools return valid responses

**Step 6: Verify tools appear in /extensions list**

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:30000/extensions | jq .
```

Expected: `ext-utilities` listed with `connected: true`, `toolCount: 5`

**Step 7: Commit any fixes needed, then final commit if clean**

If all tests pass, no commit needed for this task. If fixes were required during testing, commit them.
