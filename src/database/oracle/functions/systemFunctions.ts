import type { SqlFunctionBundle } from './types';

export const systemFunctions: SqlFunctionBundle = {
  USER: (_args, ctx) => ctx.currentUser,

  SYS_GUID: () => 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    .replace(/X/g, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()),

  SYS_CONTEXT: (args, ctx) => {
    const namespace = args[0] != null ? String(args[0]).toUpperCase() : '';
    const param = args[1] != null ? String(args[1]).toUpperCase() : '';
    if (namespace !== 'USERENV') return null;
    const fromSession = ctx.userenv(param);
    if (fromSession !== undefined) return fromSession;
    if (param === 'SESSION_USER' || param === 'CURRENT_USER') return ctx.currentUser;
    if (param === 'CURRENT_SCHEMA') return ctx.currentSchema;
    return null;
  },

  USERENV: (args, ctx) => {
    const param = args[0] != null ? String(args[0]).toUpperCase() : '';
    const value = ctx.userenv(param);
    return value === undefined ? null : value;
  },
};
