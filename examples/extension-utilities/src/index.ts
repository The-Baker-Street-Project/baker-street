import { createExtension } from '@bakerst/extension-sdk';
import { z } from 'zod';
import { resolve4, resolve6, resolveMx, resolveTxt, resolveCname, resolveNs, resolveSoa } from 'node:dns/promises';

const ext = createExtension({
  id: 'utilities',
  name: 'Utilities',
  version: '0.1.0',
  description: 'Time/date utilities and network lookup tools',
  tags: ['utilities', 'time', 'network'],
});

// ---------- Time & Date Tools ----------

ext.server.tool(
  'util_time',
  'Get the current time. Optionally specify an IANA timezone (e.g. "America/New_York"). Defaults to UTC.',
  { timezone: z.string().optional() },
  // @ts-expect-error — MCP SDK generics cause TS2589; tools register and work correctly at runtime
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
        case 'day': result.setDate(result.getDate() + amount); break;
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

// ---------- Network Lookup Tools ----------

const MAX_BODY = 4096;

ext.server.tool(
  'util_dns',
  'Look up DNS records for a hostname. Supported types: A, AAAA, MX, TXT, CNAME, NS, SOA. Defaults to A.',
  { hostname: z.string(), type: z.string().optional() },
  async ({ hostname, type }: { hostname: string; type?: string }) => {
    if (!hostname || hostname.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(hostname)) {
      return { content: [{ type: 'text' as const, text: `Invalid hostname: "${hostname}". Must be 1-253 chars, alphanumerics/dots/hyphens only.` }], isError: true };
    }
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
      const json = JSON.stringify(records, null, 2);
      const text = json.length > MAX_BODY
        ? `DNS ${recordType} records for ${hostname}:\n${json.slice(0, MAX_BODY)}\n... (truncated, ${json.length} bytes total)`
        : `DNS ${recordType} records for ${hostname}:\n${json}`;
      return { content: [{ type: 'text' as const, text }] };
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
        `IP: ${data.query ?? ip}`,
        `Location: ${[data.city, data.regionName, data.country].filter(Boolean).join(', ') || 'Unknown'}`,
        `Coordinates: ${data.lat ?? 'N/A'}, ${data.lon ?? 'N/A'}`,
        `Timezone: ${data.timezone ?? 'N/A'}`,
        `ISP: ${data.isp ?? 'N/A'}`,
        `Org: ${data.org ?? 'N/A'}`,
        `AS: ${data.as ?? 'N/A'}`,
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Geolocation request failed: ${msg}` }], isError: true };
    }
  },
);

ext.server.tool(
  'util_fetch',
  'Fetch a URL (GET or HEAD only). Returns status code, headers, and response body (truncated to 4KB). Use for checking URLs, fetching JSON from public APIs, etc.',
  { url: z.string(), method: z.string().optional(), headers: z.record(z.string()).optional() },
  // @ts-expect-error — MCP SDK generics cause TS2589; tools register and work correctly at runtime
  async ({ url, method, headers }: { url: string; method?: string; headers?: Record<string, string> }) => {
    const httpMethod = (method ?? 'GET').toUpperCase();
    if (httpMethod !== 'GET' && httpMethod !== 'HEAD') {
      return { content: [{ type: 'text' as const, text: `Only GET and HEAD methods are allowed. Got: "${httpMethod}"` }], isError: true };
    }
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch {
      return { content: [{ type: 'text' as const, text: `Invalid URL: "${url}"` }], isError: true };
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { content: [{ type: 'text' as const, text: `Only HTTP/HTTPS allowed. Got: "${parsedUrl.protocol}"` }], isError: true };
    }
    const host = parsedUrl.hostname;
    if (host === 'localhost' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host === '::1' || host === '0.0.0.0') {
      return { content: [{ type: 'text' as const, text: `Cannot fetch private/internal addresses.` }], isError: true };
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

// Start the extension
ext.start().catch((err) => {
  console.error('Failed to start extension:', err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = () => ext.shutdown().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
