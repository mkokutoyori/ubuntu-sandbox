/**
 * Error hierarchy for the bash interpreter.
 */

import type { SourcePosition } from '@/bash/lexer/Token';

/** Base class for all bash runtime errors. */
export class BashError extends Error {
  constructor(
    message: string,
    public readonly position?: SourcePosition,
  ) {
    super(message);
    this.name = 'BashError';
  }
}

/** Variable expansion errors (unset variables with set -u, bad substitution). */
export class ExpansionError extends BashError {
  constructor(message: string, position?: SourcePosition) {
    super(message, position);
    this.name = 'ExpansionError';
  }
}

/** Arithmetic evaluation errors (division by zero, bad expression). */
export class ArithmeticError extends BashError {
  constructor(message: string, position?: SourcePosition) {
    super(message, position);
    this.name = 'ArithmeticError';
  }
}

/** Signal for `exit` builtin — caught by the interpreter loop. */
export class ExitSignal extends BashError {
  constructor(public readonly exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = 'ExitSignal';
  }
}

/** Signal for `return` builtin — caught by function call handler. */
export class ReturnSignal extends BashError {
  constructor(public readonly exitCode: number) {
    super(`return ${exitCode}`);
    this.name = 'ReturnSignal';
  }
}

/** Signal for `break` — caught by loop handlers. */
export class BreakSignal extends BashError {
  constructor(public readonly levels: number = 1) {
    super(`break ${levels}`);
    this.name = 'BreakSignal';
  }
}

/** Signal for `continue` — caught by loop handlers. */
export class ContinueSignal extends BashError {
  constructor(public readonly levels: number = 1) {
    super(`continue ${levels}`);
    this.name = 'ContinueSignal';
  }
}

/**
 * Raised when a background job walks into an unconditional loop
 * (`while true`, `until false`) — parks there instead of hanging forever.
 * `interp` (typed `unknown` here to avoid a circular import with
 * BashInterpreter) carries the interpreter that actually parked — a
 * rethrow by an outer nested fork (e.g. `bash -c` inside a backgrounded
 * job) must forward the original one, not substitute its own.
 */
export class DaemonParkSignal extends BashError {
  constructor(public readonly output: string, public readonly interp?: unknown) {
    super('daemon job parked in an unconditional loop');
    this.name = 'DaemonParkSignal';
  }
}
