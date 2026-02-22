import { EventEmitter } from 'node:events';
import type { BrainState } from '@bakerst/shared';

/**
 * Valid state transitions for the brain state machine.
 * Maps from current state to the set of valid next states.
 */
const VALID_TRANSITIONS: Record<BrainState, Set<BrainState>> = {
  pending: new Set(['active']),
  active: new Set(['draining', 'shutdown']),
  draining: new Set(['shutdown']),
  shutdown: new Set(),
};

export class BrainStateMachine extends EventEmitter {
  private _state: BrainState;

  constructor(initialState: BrainState) {
    super();
    this._state = initialState;
  }

  get state(): BrainState {
    return this._state;
  }

  /** True only when state is 'active'. */
  isAcceptingRequests(): boolean {
    return this._state === 'active';
  }

  /** True only when state is 'active'. */
  isReady(): boolean {
    return this._state === 'active';
  }

  /** Transition from pending to active. */
  activate(): void {
    this.transition('active');
  }

  /** Skip transfer protocol — start directly as active. */
  forceActive(): void {
    this._state = 'active';
    this.emit('active');
  }

  /** Transition from active to draining. */
  drain(): void {
    this.transition('draining');
  }

  /** Transition from active or draining to shutdown. */
  shutdown(): void {
    this.transition('shutdown');
  }

  private transition(to: BrainState): void {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.has(to)) {
      throw new Error(`Invalid state transition: ${this._state} -> ${to}`);
    }
    this._state = to;
    this.emit(to);
  }
}
