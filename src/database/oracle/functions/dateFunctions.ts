import type { SqlFunctionBundle } from './types';

const DAY_NUMBERS: Record<string, number> = {
  SUNDAY: 0, SUN: 0, MONDAY: 1, MON: 1, TUESDAY: 2, TUE: 2,
  WEDNESDAY: 3, WED: 3, THURSDAY: 4, THU: 4, FRIDAY: 5, FRI: 5,
  SATURDAY: 6, SAT: 6,
};

export const dateFunctions: SqlFunctionBundle = {
  SYSDATE: () => new Date().toISOString().slice(0, 19).replace('T', ' '),

  SYSTIMESTAMP: () => new Date().toISOString(),

  ADD_MONTHS: ([dateArg, monthsArg], ctx) => {
    if (dateArg == null || monthsArg == null) return null;
    const base = ctx.coerceDate(dateArg);
    if (base == null) return null;
    const month = base.getMonth() + Number(monthsArg);
    const day = base.getDate();
    base.setDate(1);
    base.setMonth(month);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    base.setDate(Math.min(day, last));
    return ctx.formatDate(base);
  },

  MONTHS_BETWEEN: ([first, second], ctx) => {
    if (first == null || second == null) return null;
    const a = ctx.coerceDate(first);
    const b = ctx.coerceDate(second);
    if (!a || !b) return null;
    const months = (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth());
    return months + (a.getDate() - b.getDate()) / 31;
  },

  NEXT_DAY: ([dateArg, dayArg], ctx) => {
    if (dateArg == null || dayArg == null) return null;
    const base = ctx.coerceDate(dateArg);
    if (!base) return null;
    const target = DAY_NUMBERS[String(dayArg).toUpperCase().trim()];
    if (target === undefined) return null;
    const delta = ((target - base.getDay() + 7) % 7) || 7;
    base.setDate(base.getDate() + delta);
    return ctx.formatDate(base);
  },

  LAST_DAY: ([dateArg], ctx) => {
    if (dateArg == null) return null;
    const base = ctx.coerceDate(dateArg);
    if (!base) return null;
    return ctx.formatDate(new Date(base.getFullYear(), base.getMonth() + 1, 0));
  },

  EXTRACT: ([fieldArg, dateArg]) => {
    if (dateArg == null) return null;
    const field = String(fieldArg).toUpperCase();
    const d = dateArg instanceof Date ? dateArg : new Date(String(dateArg));
    if (isNaN(d.getTime())) return null;
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
};
