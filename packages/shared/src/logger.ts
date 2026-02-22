import pino from 'pino';
import { trace } from '@opentelemetry/api';

export const logger = pino({
  name: 'bakerst',
  level: process.env.LOG_LEVEL ?? 'info',
  mixin() {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const ctx = span.spanContext();
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
    };
  },
});
