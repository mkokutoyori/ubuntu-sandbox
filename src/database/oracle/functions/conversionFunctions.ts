import { OracleError } from '../../engine/types/DatabaseError';
import type { SqlFunctionBundle } from './types';

export const conversionFunctions: SqlFunctionBundle = {
  TO_CHAR: ([value, fmtArg], ctx) => {
    if (value == null) return null;
    const fmt = fmtArg != null ? String(fmtArg).toUpperCase() : null;
    if (fmt && typeof value === 'string') {
      const d = ctx.coerceDate(value);
      if (d !== null) return ctx.formatDateWithPattern(d, fmt);
    }
    return String(value);
  },

  TO_NUMBER: ([value]) => {
    if (value == null) return null;
    const n = Number(value);
    if (isNaN(n)) throw new OracleError(1722, 'invalid number');
    return n;
  },

  TO_DATE: ([value, fmtArg], ctx) => {
    if (value == null) return null;
    const fmt = fmtArg != null ? String(fmtArg).toUpperCase() : 'YYYY-MM-DD';
    return ctx.parseDateWithPattern(String(value), fmt);
  },
};
