/**
 * Oracle system functions (USER, SYS_CONTEXT, USERENV, SYS_GUID) and the
 * supplied-package functions reachable from SQL (DBMS_RANDOM, DBMS_UTILITY,
 * DBMS_METADATA, DBMS_LOB, DBMS_LOCK, DBMS_STATS stubs, UTL_FILE stubs).
 *
 * Package functions are registered under their bare name and check the
 * call's schema qualifier themselves — an unqualified or mis-qualified call
 * evaluates to NULL, mirroring the engine's historical behaviour.
 */

import type { SqlFunction, SqlFunctionCall } from './types';

/** Guard: run `fn` only when the call is qualified with the given package name. */
const inPackage = (pkg: string, fn: SqlFunction): SqlFunction =>
  (call, ctx) => (call.schema?.toUpperCase() === pkg ? fn(call, ctx) : null);

const dbmsRandomValue = ({ args }: SqlFunctionCall): number => {
  if (args.length >= 2) {
    const low = Number(args[0]);
    const high = Number(args[1]);
    return low + Math.random() * (high - low);
  }
  return Math.random();
};

const dbmsRandomString = ({ args }: SqlFunctionCall): string => {
  const opt = args.length > 0 ? String(args[0]).toUpperCase() : 'U';
  const len = args.length > 1 ? Number(args[1]) : 20;
  let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (opt === 'L') chars = 'abcdefghijklmnopqrstuvwxyz';
  if (opt === 'A' || opt === 'X') chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  if (opt === 'P') chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let result = '';
  for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
};

export const systemFunctions: Record<string, SqlFunction> = {
  USER: (_call, ctx) => ctx.currentUser,

  SYS_GUID: () =>
    'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'.replace(/X/g, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()),

  SYS_CONTEXT: ({ args }, ctx) => {
    const namespace = args[0] != null ? String(args[0]).toUpperCase() : '';
    const param = args[1] != null ? String(args[1]).toUpperCase() : '';
    // USERENV — delegate to the live OracleSession.
    if (namespace === 'USERENV') {
      if (ctx.userenv) {
        const value = ctx.userenv(param);
        return value === undefined ? null : value as string | number | null;
      }
      // Fallback when no session has been attached (engine-direct).
      if (param === 'SESSION_USER' || param === 'CURRENT_USER') return ctx.currentUser;
      if (param === 'CURRENT_SCHEMA') return ctx.currentSchema;
      return null;
    }
    // SYS_SESSION_ROLES / application contexts → unknown, NULL.
    return null;
  },

  // The legacy USERENV(<keyword>) function is functionally
  // equivalent to SYS_CONTEXT('USERENV', <keyword>).
  USERENV: ({ args }, ctx) => {
    const param = args[0] != null ? String(args[0]).toUpperCase() : '';
    if (ctx.userenv) {
      const value = ctx.userenv(param);
      return value === undefined ? null : value as string | number | null;
    }
    return null;
  },

  // DBMS_RANDOM package
  VALUE: inPackage('DBMS_RANDOM', dbmsRandomValue),
  STRING: inPackage('DBMS_RANDOM', dbmsRandomString),
  NORMAL: inPackage('DBMS_RANDOM', () => {
    // Box-Muller transform for normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }),

  // DBMS_LOCK.SLEEP (as function call — returns immediately in simulator)
  SLEEP: inPackage('DBMS_LOCK', () => null),

  // DBMS_UTILITY functions
  GET_TIME: inPackage('DBMS_UTILITY', () => Date.now() % 2147483647),
  FORMAT_ERROR_BACKTRACE: inPackage('DBMS_UTILITY', () => ''),
  FORMAT_ERROR_STACK: inPackage('DBMS_UTILITY', () => ''),

  // DBMS_METADATA.GET_DDL — storage-backed, delegated through the context.
  GET_DDL: inPackage('DBMS_METADATA', ({ args }, ctx) => ctx.getMetadataDDL(args)),

  // DBMS_STATS procedures (as stubs)
  GATHER_TABLE_STATS: inPackage('DBMS_STATS', () => null),
  GATHER_SCHEMA_STATS: inPackage('DBMS_STATS', () => null),

  // DBMS_LOB functions
  GETLENGTH: inPackage('DBMS_LOB', ({ args }) => (args[0] != null ? String(args[0]).length : null)),

  // UTL_FILE stubs
  FOPEN: inPackage('UTL_FILE', () => null),
  FCLOSE: inPackage('UTL_FILE', () => null),
  GET_LINE: inPackage('UTL_FILE', () => null),

  // COUNT(*) and other aggregates return a single value for a column
  // evaluation context. Real aggregation is handled at the query level —
  // here we just return the scalar value.
  COUNT: ({ args, rawArgs }) =>
    (args.length === 0 || (rawArgs[0] && rawArgs[0].type === 'Star') ? 1 : (args[0] != null ? 1 : 0)),
  SUM: ({ args }) => args[0] ?? null,
  AVG: ({ args }) => args[0] ?? null,
  MIN: ({ args }) => args[0] ?? null,
  MAX: ({ args }) => args[0] ?? null,
};
