/**
 * Oracle built-in date/time and conversion functions (TRUNC, ADD_MONTHS,
 * TO_CHAR, TO_DATE, EXTRACT, …).
 *
 * Faithful Oracle quirks preserved: ADD_MONTHS clamps to the last day of the
 * target month; MONTHS_BETWEEN uses the 31-day fraction rule; TO_NUMBER
 * raises ORA-01722 on bad input.
 */

import { OracleError } from '../../engine/types/DatabaseError';
import type { SqlFunction } from './types';
import { coerceDate, formatDate, formatOracleDate, parseOracleDate } from './valueUtils';

const DAY_NAME_TO_INDEX: Record<string, number> = {
  SUNDAY: 0, SUN: 0, MONDAY: 1, MON: 1, TUESDAY: 2, TUE: 2,
  WEDNESDAY: 3, WED: 3, THURSDAY: 4, THU: 4, FRIDAY: 5, FRI: 5,
  SATURDAY: 6, SAT: 6,
};

export const dateFunctions: Record<string, SqlFunction> = {
  // TRUNC doubles as numeric truncation when the argument is not a date.
  TRUNC: ({ args }) => {
    if (args[0] == null) return null;
    const asDate = coerceDate(args[0]);
    if (asDate != null) {
      const d = new Date(asDate.getTime());
      const fmt = args[1] != null ? String(args[1]).toUpperCase() : 'DD';
      if (fmt === 'YYYY' || fmt === 'YEAR' || fmt === 'YY') {
        return formatDate(new Date(d.getFullYear(), 0, 1));
      }
      if (fmt === 'MM' || fmt === 'MONTH' || fmt === 'MON') {
        return formatDate(new Date(d.getFullYear(), d.getMonth(), 1));
      }
      if (fmt === 'DAY' || fmt === 'D' || fmt === 'IW') {
        const day = d.getDay();
        return formatDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - day));
      }
      d.setHours(0, 0, 0, 0);
      return formatDate(d);
    }
    return Math.trunc(Number(args[0]));
  },

  ADD_MONTHS: ({ args }) => {
    if (args[0] == null || args[1] == null) return null;
    const base = coerceDate(args[0]);
    if (base == null) return null;
    const month = base.getMonth() + Number(args[1]);
    const day = base.getDate();
    base.setDate(1);
    base.setMonth(month);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    base.setDate(Math.min(day, last));
    return formatDate(base);
  },

  MONTHS_BETWEEN: ({ args }) => {
    if (args[0] == null || args[1] == null) return null;
    const a = coerceDate(args[0]);
    const b = coerceDate(args[1]);
    if (!a || !b) return null;
    const months = (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth());
    return months + (a.getDate() - b.getDate()) / 31;
  },

  NEXT_DAY: ({ args }) => {
    if (args[0] == null || args[1] == null) return null;
    const base = coerceDate(args[0]);
    if (!base) return null;
    const target = DAY_NAME_TO_INDEX[String(args[1]).toUpperCase().trim()];
    if (target === undefined) return null;
    const delta = ((target - base.getDay() + 7) % 7) || 7;
    base.setDate(base.getDate() + delta);
    return formatDate(base);
  },

  LAST_DAY: ({ args }) => {
    if (args[0] == null) return null;
    const base = coerceDate(args[0]);
    if (!base) return null;
    return formatDate(new Date(base.getFullYear(), base.getMonth() + 1, 0));
  },

  // EXTRACT(field FROM date) — parsed as EXTRACT(fieldLiteral, sourceExpr)
  EXTRACT: ({ args }) => {
    if (args.length < 2 || args[1] == null) return null;
    const field = String(args[0]).toUpperCase();
    const dateVal = args[1];
    let d: Date;
    if (dateVal instanceof Date) {
      d = dateVal;
    } else {
      d = new Date(String(dateVal));
      if (isNaN(d.getTime())) return null;
    }
    switch (field) {
      case 'YEAR': return d.getFullYear();
      case 'MONTH': return d.getMonth() + 1;
      case 'DAY': return d.getDate();
      case 'HOUR': return d.getHours();
      case 'MINUTE': return d.getMinutes();
      case 'SECOND': return d.getSeconds();
      default: return null;
    }
  },

  SYSDATE: () => new Date().toISOString().slice(0, 19).replace('T', ' '),
  SYSTIMESTAMP: () => new Date().toISOString(),

  TO_CHAR: ({ args }) => {
    if (args[0] == null) return null;
    const fmt = args[1] != null ? String(args[1]).toUpperCase() : null;
    if (fmt && (typeof args[0] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(args[0]))) {
      const d = new Date(args[0]);
      if (!isNaN(d.getTime())) {
        return formatOracleDate(d, fmt);
      }
    }
    return String(args[0]);
  },

  TO_NUMBER: ({ args }) => {
    if (args[0] == null) return null;
    const n = Number(args[0]);
    if (isNaN(n)) throw new OracleError(1722, 'invalid number');
    return n;
  },

  TO_DATE: ({ args }) => {
    if (args[0] == null) return null;
    const dateFmt = args[1] != null ? String(args[1]).toUpperCase() : 'YYYY-MM-DD';
    return parseOracleDate(String(args[0]), dateFmt);
  },
};
