/**
 * SQL scalar function registry — Open/Closed dispatcher for Oracle built-ins.
 *
 * Replaces the former 400-line switch in OracleExecutor.evaluateFunction.
 * Adding a function is purely additive: implement it in one of the group
 * modules (or register it here) — no dispatcher edit needed.
 *
 * Unknown names resolve to `undefined`; the executor raises ORA-00904, the
 * same way real Oracle reports unknown functions as invalid identifiers.
 */

import type { SqlFunction } from './types';
import { stringFunctions } from './stringFunctions';
import { numericFunctions } from './numericFunctions';
import { dateFunctions } from './dateFunctions';
import { systemFunctions } from './systemFunctions';

const registry = new Map<string, SqlFunction>();

function registerAll(group: Record<string, SqlFunction>): void {
  for (const [name, fn] of Object.entries(group)) {
    registry.set(name.toUpperCase(), fn);
  }
}

registerAll(stringFunctions);
registerAll(numericFunctions);
registerAll(dateFunctions);
registerAll(systemFunctions);

export function findSqlFunction(name: string): SqlFunction | undefined {
  return registry.get(name.toUpperCase());
}
