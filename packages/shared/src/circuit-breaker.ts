/**
 * Lightweight circuit breaker for external API calls.
 * States: closed (normal) -> open (fast-fail) -> half-open (testing)
 */
import { logger } from './logger.js';

const log = logger.child({ module: 'circuit-breaker' });

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Name for logging */
  name: string;
  /** Number of failures before opening (default: 5) */
  failureThreshold?: number;
  /** Time in ms before trying half-open (default: 30000) */
  resetTimeoutMs?: number;
  /** Successes in half-open before closing (default: 1) */
  halfOpenSuccessThreshold?: number;
  /** Callback when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.halfOpenSuccessThreshold = opts.halfOpenSuccessThreshold ?? 1;
    this.onStateChange = opts.onStateChange;
  }

  get currentState(): CircuitState {
    return this.state;
  }

  private transition(to: CircuitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    log.info({ name: this.name, from, to }, 'circuit breaker state change');
    this.onStateChange?.(from, to);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      // Check if reset timeout has elapsed
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.transition('half-open');
        this.successCount = 0;
      } else {
        throw new Error(`Circuit breaker '${this.name}' is open`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.halfOpenSuccessThreshold) {
        this.failureCount = 0;
        this.transition('closed');
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === 'half-open') {
      this.transition('open');
    } else if (this.failureCount >= this.failureThreshold) {
      this.transition('open');
    }
  }

  /** Reset the breaker to closed state */
  reset(): void {
    this.failureCount = 0;
    this.successCount = 0;
    this.transition('closed');
  }
}
