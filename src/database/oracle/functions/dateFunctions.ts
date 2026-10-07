import {
  addMonths, extractField, lastDay, monthsBetween, newTime, nextDay,
} from './dateArithmetic';
import type { SqlFunctionBundle } from './types';

export const dateFunctions: SqlFunctionBundle = {
  SYSDATE: (_args, ctx) => ctx.clockText().sysdate,

  SYSTIMESTAMP: (_args, ctx) => ctx.clockText().systimestamp,

  ADD_MONTHS: ([dateArg, monthsArg], ctx) => {
    if (dateArg == null || monthsArg == null) return null;
    const base = ctx.coerceDate(dateArg);
    return base === null ? null : ctx.formatDate(addMonths(base, Number(monthsArg)));
  },

  MONTHS_BETWEEN: ([first, second], ctx) => {
    if (first == null || second == null) return null;
    const a = ctx.coerceDate(first);
    const b = ctx.coerceDate(second);
    return a && b ? monthsBetween(a, b) : null;
  },

  NEXT_DAY: ([dateArg, dayArg], ctx) => {
    if (dateArg == null || dayArg == null) return null;
    const base = ctx.coerceDate(dateArg);
    const next = base ? nextDay(base, String(dayArg)) : null;
    return next ? ctx.formatDate(next) : null;
  },

  LAST_DAY: ([dateArg], ctx) => {
    if (dateArg == null) return null;
    const base = ctx.coerceDate(dateArg);
    return base ? ctx.formatDate(lastDay(base)) : null;
  },

  NEW_TIME: ([dateArg, fromZone, toZone], ctx) => {
    if (dateArg == null || fromZone == null || toZone == null) return null;
    const base = ctx.coerceDate(dateArg);
    return base ? ctx.formatDate(newTime(base, String(fromZone), String(toZone))) : null;
  },

  EXTRACT: ([fieldArg, dateArg], ctx) => {
    if (dateArg == null) return null;
    const d = ctx.coerceDate(dateArg);
    return d === null ? null : extractField(d, String(fieldArg));
  },
};
