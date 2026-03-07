import { EventEmitter } from 'node:events';
import { logger } from '@bakerst/shared';
import type { SysAdminState } from '@bakerst/shared';

const log = logger.child({ module: 'sysadmin-state' });

/**
 * Valid state transitions for the sysadmin state machine.
 *
 * verify  → runtime
 * runtime → update | shutdown
 * update  → runtime | shutdown
 * shutdown → (terminal)
 */
const VALID_TRANSITIONS: Record<SysAdminState, Set<SysAdminState>> = {
  verify: new Set(['runtime', 'shutdown']),
  runtime: new Set(['update', 'shutdown']),
  update: new Set(['runtime', 'shutdown']),
  shutdown: new Set(),
};

export class SysAdminStateMachine extends EventEmitter {
  private _state: SysAdminState;

  constructor(initialState: SysAdminState) {
    super();
    this._state = initialState;
  }

  get state(): SysAdminState {
    return this._state;
  }

  transition(to: SysAdminState): void {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.has(to)) {
      throw new Error(`Invalid state transition: ${this._state} -> ${to}`);
    }
    log.info({ from: this._state, to }, 'state transition');
    this._state = to;
    this.emit('transition', to);
    this.emit(to);
  }
}
