import type { CellValue } from '../../engine/storage/BaseStorage';
import { truncateDate } from './dateArithmetic';
import type { SqlFunctionBundle } from './types';

const withNumber = (value: CellValue, fn: (n: number) => CellValue): CellValue =>
  value == null ? null : fn(Number(value));

export const numericFunctions: SqlFunctionBundle = {
  ABS: ([v]) => withNumber(v, Math.abs),

  CEIL: ([v]) => withNumber(v, Math.ceil),

  FLOOR: ([v]) => withNumber(v, Math.floor),

  ROUND: ([v, digits]) => withNumber(v, n =>
    digits != null ? Number(n.toFixed(Number(digits))) : Math.round(n)),

  TRUNC: ([v, fmtArg], ctx) => {
    if (v == null) return null;
    const asDate = ctx.coerceDate(v);
    if (asDate != null) return ctx.formatDate(truncateDate(asDate, fmtArg != null ? String(fmtArg) : null));
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
