import type { SqlFunctionBundle } from './types';

export const packageFunctions: SqlFunctionBundle = {
  'DBMS_RANDOM.VALUE': (args) => {
    if (args.length >= 2) {
      const low = Number(args[0]);
      const high = Number(args[1]);
      return low + Math.random() * (high - low);
    }
    return Math.random();
  },

  'DBMS_RANDOM.STRING': (args) => {
    const opt = args.length > 0 ? String(args[0]).toUpperCase() : 'U';
    const len = args.length > 1 ? Number(args[1]) : 20;
    let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (opt === 'L') chars = 'abcdefghijklmnopqrstuvwxyz';
    if (opt === 'A' || opt === 'X') chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    if (opt === 'P') chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let result = '';
    for (let i = 0; i < len; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  },

  'DBMS_RANDOM.NORMAL': () => {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  },

  'DBMS_LOCK.SLEEP': () => null,

  'DBMS_UTILITY.GET_TIME': () => Date.now() % 2147483647,

  'DBMS_UTILITY.FORMAT_ERROR_BACKTRACE': () => '',

  'DBMS_UTILITY.FORMAT_ERROR_STACK': () => '',

  'DBMS_METADATA.GET_DDL': (args, ctx) => ctx.metadataDdl(args),

  'DBMS_STATS.GATHER_TABLE_STATS': () => null,

  'DBMS_STATS.GATHER_SCHEMA_STATS': () => null,

  'DBMS_LOB.GETLENGTH': ([v]) => (v != null ? String(v).length : null),

  // UTL_FILE is intentionally absent: it is a PL/SQL-only package served by
  // UtlFileEngine through the interpreter, and is an invalid identifier in
  // SQL (ORA-00904), matching real Oracle.
};
