import type { SqlFunctionBundle } from './types';

export const nullFunctions: SqlFunctionBundle = {
  NVL: ([a, b]) => a ?? b ?? null,

  NVL2: ([test, ifNotNull, ifNull]) => (test != null ? (ifNotNull ?? null) : (ifNull ?? null)),

  COALESCE: (args) => args.find(a => a != null) ?? null,

  NULLIF: ([a, b], ctx) => (ctx.compare(a, b) === 0 ? null : a),

  DECODE: (args, ctx) => {
    if (args.length < 3) return null;
    const subject = args[0];
    for (let i = 1; i + 1 < args.length; i += 2) {
      if (ctx.compare(subject, args[i]) === 0) return args[i + 1];
    }
    return args.length % 2 === 0 ? args[args.length - 1] : null;
  },
};
