import type { CellValue } from '../../engine/storage/BaseStorage';
import type { SqlFunctionBundle, SqlFunctionContext } from './types';

const withNumber = (value: CellValue, fn: (n: number) => CellValue): CellValue =>
  value == null ? null : fn(Number(value));

const truncDate = (d: Date, fmtArg: CellValue, ctx: SqlFunctionContext): string => {
  const fmt = fmtArg != null ? String(fmtArg).toUpperCase() : 'DD';
  if (fmt === 'YYYY' || fmt === 'YEAR' || fmt === 'YY') {
    return ctx.formatDate(new Date(d.getFullYear(), 0, 1));
  }
  if (fmt === 'MM' || fmt === 'MONTH' || fmt === 'MON') {
    return ctx.formatDate(new Date(d.getFullYear(), d.getMonth(), 1));
  }
  if (fmt === 'DAY' || fmt === 'D' || fmt === 'IW') {
    return ctx.formatDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()));
  }
  const copy = new Date(d.getTime());
  copy.setHours(0, 0, 0, 0);
  return ctx.formatDate(copy);
};

export const numericFunctions: SqlFunctionBundle = {
  ABS: ([v]) => withNumber(v, Math.abs),

  CEIL: ([v]) => withNumber(v, Math.ceil),

  FLOOR: ([v]) => withNumber(v, Math.floor),

  ROUND: ([v, digits]) => withNumber(v, n =>
    digits != null ? Number(n.toFixed(Number(digits))) : Math.round(n)),

  TRUNC: ([v, fmtArg], ctx) => {
    if (v == null) return null;
    const asDate = ctx.coerceDate(v);
    if (asDate != null) return truncDate(asDate, fmtArg, ctx);
    return Math.trunc(Number(v));
  },

  MOD: ([a, b]) => {
    if (a == null || b == null) return null;
    const divisor = Number(b);
    return divisor === 0 ? Number(a) : Number(a) % divisor;
  },

  REMAINDER: ([a, b]) => {
    if (a == null || b == null) return null;
    const n = Number(a);
    const divisor = Number(b);
    return divisor === 0 ? null : n - Math.round(n / divisor) * divisor;
  },

  POWER: ([a, b]) => (a != null && b != null ? Math.pow(Number(a), Number(b)) : null),

  SQRT: ([v]) => withNumber(v, Math.sqrt),

  SIGN: ([v]) => withNumber(v, Math.sign),

  GREATEST: (args, ctx) => {
    if (args.length === 0 || args.some(a => a == null)) return null;
    return args.reduce<CellValue>((a, b) => (ctx.compare(a, b) >= 0 ? a : b), args[0]);
  },

  LEAST: (args, ctx) => {
    if (args.length === 0 || args.some(a => a == null)) return null;
    return args.reduce<CellValue>((a, b) => (ctx.compare(a, b) <= 0 ? a : b), args[0]);
  },
};
