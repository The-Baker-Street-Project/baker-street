/**
 * Guardrail hooks and audit sink interfaces.
 *
 * These define the seams where enterprise deployments inject security middleware:
 * - GuardrailHook: before/after tool execution (prompt injection detection, output sanitization)
 * - AuditSink: structured event emission (SIEM integration, compliance logging)
 *
 * The consumer (open-source) deployment uses no-op defaults with zero overhead.
 */

// ---------------------------------------------------------------------------
// Guardrail hooks
// ---------------------------------------------------------------------------

export interface GuardrailContext {
  conversationId: string;
  userId?: string;
  toolName: string;
  toolInput: unknown;
}

export interface GuardrailResult {
  /** Whether to allow execution */
  allow: boolean;
  /** Human-readable reason (logged and optionally shown to user) */
  reason?: string;
}

export interface GuardrailHook {
  /** Called before tool execution. Return { allow: false } to block. */
  beforeToolExecution(ctx: GuardrailContext): Promise<GuardrailResult>;
  /** Called after tool execution with the result. Can transform the result. */
  afterToolExecution(ctx: GuardrailContext, result: unknown): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Audit sink
// ---------------------------------------------------------------------------

export interface AuditEvent {
  timestamp: string;
  category: 'auth' | 'tool' | 'secret' | 'admin' | 'llm';
  action: string;
  actor: string;
  detail: Record<string, unknown>;
}

export interface AuditSink {
  /** Emit a structured audit event */
  emit(event: AuditEvent): void;
}

// ---------------------------------------------------------------------------
// No-op defaults (consumer/open-source path — zero overhead)
// ---------------------------------------------------------------------------

/** Guardrail hook that allows everything. */
export const noopGuardrailHook: GuardrailHook = {
  async beforeToolExecution() {
    return { allow: true };
  },
  async afterToolExecution(_ctx, result) {
    return result;
  },
};

/** Audit sink that discards all events. */
export const noopAuditSink: AuditSink = {
  emit() {
    // intentionally empty
  },
};
