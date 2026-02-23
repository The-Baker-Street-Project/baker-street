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

// Start the extension
ext.start().catch((err) => {
  console.error('Failed to start extension:', err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = () => ext.shutdown().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
