/**
 * Oracle built-in numeric and NULL-handling functions.
 */

import type { CellValue } from '../../engine/storage/BaseStorage';
import type { SqlFunction } from './types';
import { compareValues } from './valueUtils';

export const numericFunctions: Record<string, SqlFunction> = {
  ABS: ({ args }) => (args[0] != null ? Math.abs(Number(args[0])) : null),
  CEIL: ({ args }) => (args[0] != null ? Math.ceil(Number(args[0])) : null),
  FLOOR: ({ args }) => (args[0] != null ? Math.floor(Number(args[0])) : null),
  ROUND: ({ args }) => (args[0] != null
    ? (args[1] != null ? Number(Number(args[0]).toFixed(Number(args[1]))) : Math.round(Number(args[0])))
    : null),
  MOD: ({ args }) => (args[0] != null && args[1] != null ? Number(args[0]) % Number(args[1]) : null),
  POWER: ({ args }) => (args[0] != null && args[1] != null ? Math.pow(Number(args[0]), Number(args[1])) : null),
  SQRT: ({ args }) => (args[0] != null ? Math.sqrt(Number(args[0])) : null),
  SIGN: ({ args }) => (args[0] != null ? Math.sign(Number(args[0])) : null),
  GREATEST: ({ args }) =>
    args.filter(a => a != null).reduce<CellValue>((a, b) => (compareValues(a, b) >= 0 ? a : b), args[0]),
  LEAST: ({ args }) =>
    args.filter(a => a != null).reduce<CellValue>((a, b) => (compareValues(a, b) <= 0 ? a : b), args[0]),

  // Null handling
  NVL: ({ args }) => args[0] ?? args[1] ?? null,
  NVL2: ({ args }) => (args[0] != null ? (args[1] ?? null) : (args[2] ?? null)),
  COALESCE: ({ args }) => args.find(a => a != null) ?? null,
  NULLIF: ({ args }) => (compareValues(args[0], args[1]) === 0 ? null : args[0]),
  DECODE: ({ args }) => {
    if (args.length < 3) return null;
    const expr = args[0];
    for (let i = 1; i + 1 < args.length; i += 2) {
      if (compareValues(expr, args[i]) === 0) return args[i + 1];
    }
    // Default (odd number of remaining args)
    return args.length % 2 === 0 ? args[args.length - 1] : null;
  },
};
