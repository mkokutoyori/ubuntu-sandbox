/**
 * Scn — Oracle System Change Number value object.
 *
 * Branded immutable wrapper around a non-negative integer.
 * Built via `Scn.of(raw)` which returns `Result<Scn, RmanError>`.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';

export interface Scn {
  readonly _tag:  'Scn';
  readonly value: number;
}

export const Scn = {
  of(raw: number | string): Result<Scn, RmanError> {
    const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
    if (!Number.isInteger(n) || n < 0) {
      return err({ code: 'SCN_INVALID', message: `Invalid SCN: ${raw}`, raw: String(raw) });
    }
    return ok(Object.freeze({ _tag: 'Scn' as const, value: n }));
  },
  ZERO: Object.freeze({ _tag: 'Scn' as const, value: 0 }) as Scn,
  gt:  (a: Scn, b: Scn): boolean => a.value > b.value,
  gte: (a: Scn, b: Scn): boolean => a.value >= b.value,
  toString: (s: Scn): string => String(s.value),
};
