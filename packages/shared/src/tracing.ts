/**
 * Tracing utilities — thin wrapper around OpenTelemetry API.
 *
 * The actual SDK initialization happens in each service's instrument.ts.
 * This module provides helpers that work whether or not the SDK is loaded.
 */
import { trace, context, SpanStatusCode, type Span, propagation, type Context } from '@opentelemetry/api';

const TRACER_NAME = 'bakerst';

/** Get a tracer instance */
export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/** Get trace headers from the current active context for propagation */
export function getTraceHeaders(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};

  const spanContext = span.spanContext();
  return {
    traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, '0')}`,
  };
}

/** Extract trace context from incoming headers and restore as an OTel Context */
export function extractTraceContext(headers: Record<string, string>): Context {
  return propagation.extract(context.active(), headers);
}

/**
 * Wrap an async function in an OTel span.
 * Automatically records errors and sets span status.
 * Optionally accepts a parent context for distributed trace propagation.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
  parentContext?: Context,
): Promise<T> {
  const tracer = getTracer();
  const ctx = parentContext ?? context.active();
  return context.with(ctx, () => {
    return tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        span.end();
      }
    });
  });
}
