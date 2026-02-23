# Utilities Extension Design

## Overview

A Baker Street extension pod providing time/date and network lookup tools. These fill genuine gaps that the LLM cannot handle natively — real clock access and network queries.

**Extension ID:** `utilities`
**Image:** `bakerst-ext-utilities`
**K8s Service:** `ext-utilities.bakerst.svc.cluster.local:8080`

## Tools

### Time & Date (2 tools)

| Tool | Params | Returns |
|------|--------|---------|
| `util_time` | `timezone?: string` (IANA, e.g. "America/New_York") | Current time in ISO + human-readable, defaults to UTC |
| `util_date_calc` | `date: string`, `offset: string` (e.g. "+3 days", "-2 hours"), `timezone?: string` | Computed date/time |

### Network Lookups (3 tools)

| Tool | Params | Returns |
|------|--------|---------|
| `util_dns` | `hostname: string`, `type?: string` (A, AAAA, MX, TXT, etc.) | DNS records |
| `util_geolocate` | `ip: string` | Country, city, timezone, ISP (uses ip-api.com free tier, no key needed) |
| `util_fetch` | `url: string`, `method?: string` (GET/HEAD, default GET), `headers?: object` | Status code, response headers, body (truncated to 4KB) |

## Constraints

- `util_fetch` restricted to GET and HEAD only (no mutations)
- Response body capped at 4KB to avoid blowing up LLM context
- No API keys needed — uses Node.js built-in `dns` module and free geolocation API (ip-api.com)
- Same security posture as hello-world: read-only filesystem, non-root, drop all capabilities
- Network policy already covers it (`app: bakerst-extension` label)

## Architecture

Identical to hello-world: `createExtension()` → register 5 tools → `start()`. Single source file, single container, single deployment. No database, no state.

## Files

| File | Purpose |
|------|---------|
| `examples/extension-utilities/src/index.ts` | Extension source — all 5 tools |
| `examples/extension-utilities/package.json` | Package manifest |
| `examples/extension-utilities/tsconfig.json` | TypeScript config |
| `examples/extension-utilities/Dockerfile` | Multi-stage build (same pattern as hello-world) |
| `examples/extension-utilities/k8s/deployment.yaml` | K8s Deployment + Service |
