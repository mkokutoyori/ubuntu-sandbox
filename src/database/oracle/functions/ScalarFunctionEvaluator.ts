/**
 * Oracle scalar SQL function evaluation (UPPER, SUBSTR, NVL, TO_DATE,
 * SYS_CONTEXT, …), extracted from the OracleExecutor god class.
 *
 * The evaluator depends on a narrow {@link ScalarFunctionHost} interface
 * instead of the executor itself (Dependency Inversion): expression
 * recursion, value comparison and date formatting stay with the caller,
 * everything else lives here. Adding a function touches only this module.
 */

import type { FunctionCallExpr, Expression } from '../../engine/parser/ASTNode';
import { OracleError } from '../../engine/types/DatabaseError';
import type { CellValue, StorageRow, ColumnMeta as StorageColMeta } from '../../engine/storage/BaseStorage';
import type { ExecutionContext } from '../../engine/executor/BaseExecutor';

/** Services the evaluator needs from the executing engine. */
export interface ScalarFunctionHost {
  evaluateExpression(expr: Expression, row: StorageRow, columns: StorageColMeta[]): CellValue;
  compareValues(a: CellValue, b: CellValue): number;
  formatOracleDate(d: Date, fmt: string): string;
  parseOracleDate(dateStr: string, fmt: string): string;
  getMetadataDDL(args: CellValue[]): CellValue;
  getContext(): ExecutionContext;
  /** Optional SQL→PL/SQL bridge for stored functions (SELECT pkg.fn(…)). */
  callStoredFunction?(qualifiedName: string, args: CellValue[]): { handled: boolean; value: CellValue };
}

/** Return a mutable Date copy of the value, or null if not a date. */
export function coerceDate(value: unknown): Date | null {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value)) {
    // Accept bare YYYY-MM-DD too.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  }
  const ms = Date.parse(value.replace(' ', 'T'));
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Format a Date the way SYSDATE / TO_CHAR(DATE) renders in SQL*Plus. */
export function formatDate(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class ScalarFunctionEvaluator {
  constructor(private readonly host: ScalarFunctionHost) {}

  evaluate(expr: FunctionCallExpr, row: StorageRow, columns: StorageColMeta[]): CellValue {
    const name = expr.name.toUpperCase();
    const args = expr.args.map(a => this.host.evaluateExpression(a, row, columns));

    switch (name) {
      // String functions
      case 'UPPER': return args[0] != null ? String(args[0]).toUpperCase() : null;
      case 'LOWER': return args[0] != null ? String(args[0]).toLowerCase() : null;
      case 'INITCAP': return args[0] != null ? String(args[0]).replace(/\b\w/g, c => c.toUpperCase()) : null;
      case 'LENGTH': return args[0] != null ? String(args[0]).length : null;
      case 'SUBSTR': {
        if (args[0] == null) return null;
        const str = String(args[0]);
        let start = Number(args[1]);
        const len = args[2] != null ? Number(args[2]) : undefined;
        // Oracle: negative start means count from end
        if (start < 0) {
          start = str.length + start + 1;
        }
        // Oracle: 0 is treated as 1
        if (start === 0) start = 1;
        const jsStart = start - 1; // convert to 0-based
        if (jsStart < 0) return len !== undefined ? str.substring(0, len + jsStart) : '';
        return str.substring(jsStart, len !== undefined ? jsStart + len : undefined);
      }
      case 'INSTR': {
        if (args[0] == null || args[1] == null) return null;
        const str = String(args[0]);
        const search = String(args[1]);
        const startPos = args[2] != null ? Number(args[2]) : 1;
        const occurrence = args[3] != null ? Number(args[3]) : 1;
        if (startPos > 0) {
          let found = 0;
          let pos = startPos - 1;
          while (pos < str.length) {
            const idx = str.indexOf(search, pos);
            if (idx < 0) return 0;
            found++;
            if (found === occurrence) return idx + 1;
            pos = idx + 1;
          }
          return 0;
        } else {
          // Negative startPos: search backwards from the end
          let found = 0;
          let pos = str.length + startPos;
          while (pos >= 0) {
            const idx = str.lastIndexOf(search, pos);
            if (idx < 0) return 0;
            found++;
            if (found === occurrence) return idx + 1;
            pos = idx - 1;
          }
          return 0;
        }
      }
      case 'TRIM': {
        if (args[0] == null) return null;
        const trimStr = String(args[0]);
        // Enhanced TRIM: args = [source, chars, spec] where spec is LEADING/TRAILING/BOTH
        if (args.length >= 3 && args[2] != null) {
          const trimChars = String(args[1] ?? ' ');
          const spec = String(args[2]).toUpperCase();
          const escaped = trimChars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const charClass = `[${escaped}]`;
          if (spec === 'LEADING') return trimStr.replace(new RegExp(`^${charClass}+`), '');
          if (spec === 'TRAILING') return trimStr.replace(new RegExp(`${charClass}+$`), '');
          return trimStr.replace(new RegExp(`^${charClass}+`), '').replace(new RegExp(`${charClass}+$`), '');
        }
        return trimStr.trim();
      }
      case 'LTRIM': {
        if (args[0] == null) return null;
        const str = String(args[0]);
        const chars = args[1] != null ? String(args[1]) : ' ';
        const escaped = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return str.replace(new RegExp(`^[${escaped}]+`), '');
      }
      case 'RTRIM': {
        if (args[0] == null) return null;
        const str = String(args[0]);
        const chars = args[1] != null ? String(args[1]) : ' ';
        const escaped = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return str.replace(new RegExp(`[${escaped}]+$`), '');
      }
      case 'LPAD': {
        if (args[0] == null) return null;
        const str = String(args[0]);
        const len = Number(args[1]);
        const pad = args[2] != null ? String(args[2]) : ' ';
        return str.padStart(len, pad);
      }
      case 'RPAD': {
        if (args[0] == null) return null;
        const str = String(args[0]);
        const len = Number(args[1]);
        const pad = args[2] != null ? String(args[2]) : ' ';
        return str.padEnd(len, pad);
      }
      case 'REPLACE': {
        if (args[0] == null) return null;
        return String(args[0]).replaceAll(String(args[1] ?? ''), String(args[2] ?? ''));
      }
      case 'CONCAT': return (args[0] != null ? String(args[0]) : '') + (args[1] != null ? String(args[1]) : '');
      case 'CHR': return args[0] != null ? String.fromCharCode(Number(args[0])) : null;
      case 'ASCII': return args[0] != null ? String(args[0]).charCodeAt(0) : null;
      case 'REGEXP_REPLACE': {
        if (args[0] == null) return null;
        const src = String(args[0]);
        const pat = String(args[1] ?? '');
        const rep = args[2] != null ? String(args[2]) : '';
        try { return src.replace(new RegExp(pat, 'g'), rep); } catch { return src; }
      }
      case 'REGEXP_SUBSTR': {
        if (args[0] == null) return null;
        const src = String(args[0]);
        const pat = String(args[1] ?? '');
        try { const m = src.match(new RegExp(pat)); return m ? m[0] : null; } catch { return null; }
      }
      case 'REGEXP_INSTR': {
        if (args[0] == null) return null;
        const src = String(args[0]);
        const pat = String(args[1] ?? '');
        try { const m = src.match(new RegExp(pat)); return m && m.index !== undefined ? m.index + 1 : 0; } catch { return 0; }
      }
      case 'REGEXP_COUNT': {
        if (args[0] == null) return null;
        const src = String(args[0]);
        const pat = String(args[1] ?? '');
        try { const matches = src.match(new RegExp(pat, 'g')); return matches ? matches.length : 0; } catch { return 0; }
      }

      // Numeric functions
      case 'ABS': return args[0] != null ? Math.abs(Number(args[0])) : null;
      case 'CEIL': return args[0] != null ? Math.ceil(Number(args[0])) : null;
      case 'FLOOR': return args[0] != null ? Math.floor(Number(args[0])) : null;
      case 'ROUND': return args[0] != null ? (args[1] != null ? Number(Number(args[0]).toFixed(Number(args[1]))) : Math.round(Number(args[0]))) : null;
      case 'TRUNC': {
        if (args[0] == null) return null;
        const asDate = coerceDate(args[0]);
        if (asDate != null) {
          const d = new Date(asDate.getTime());
          const fmt = args[1] != null ? String(args[1]).toUpperCase() : 'DD';
          if (fmt === 'YYYY' || fmt === 'YEAR' || fmt === 'YY' || fmt === 'Y') {
            return formatDate(new Date(d.getFullYear(), 0, 1));
          }
          if (fmt === 'Q') {
            return formatDate(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1));
          }
          if (fmt === 'MM' || fmt === 'MONTH' || fmt === 'MON') {
            return formatDate(new Date(d.getFullYear(), d.getMonth(), 1));
          }
          if (fmt === 'DAY' || fmt === 'D' || fmt === 'DY') {
            // First day of week — Sunday under the default (US) NLS territory.
            return formatDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()));
          }
          if (fmt === 'IW') {
            // ISO week starts Monday.
            const isoDay = (d.getDay() + 6) % 7;
            return formatDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - isoDay));
          }
          if (fmt === 'W') {
            // Same weekday as the first day of the month.
            return formatDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDate() - 1) % 7)));
          }
          if (fmt === 'WW') {
            // Same weekday as January 1st.
            const jan1 = new Date(d.getFullYear(), 0, 1);
            const days = Math.floor((d.getTime() - jan1.getTime()) / 86_400_000);
            return formatDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days % 7)));
          }
          if (fmt === 'HH' || fmt === 'HH12' || fmt === 'HH24') {
            d.setMinutes(0, 0, 0);
            return formatDate(d);
          }
          if (fmt === 'MI') {
            d.setSeconds(0, 0);
            return formatDate(d);
          }
          d.setHours(0, 0, 0, 0);
          return formatDate(d);
        }
        return Math.trunc(Number(args[0]));
      }
      case 'ADD_MONTHS': {
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
      }
      case 'MONTHS_BETWEEN': {
        if (args[0] == null || args[1] == null) return null;
        const a = coerceDate(args[0]);
        const b = coerceDate(args[1]);
        if (!a || !b) return null;
        const months = (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth());
        return months + (a.getDate() - b.getDate()) / 31;
      }
      case 'NEXT_DAY': {
        if (args[0] == null || args[1] == null) return null;
        const base = coerceDate(args[0]);
        if (!base) return null;
        const dayMap: Record<string, number> = {
          SUNDAY: 0, SUN: 0, MONDAY: 1, MON: 1, TUESDAY: 2, TUE: 2,
          WEDNESDAY: 3, WED: 3, THURSDAY: 4, THU: 4, FRIDAY: 5, FRI: 5,
          SATURDAY: 6, SAT: 6,
        };
        const target = dayMap[String(args[1]).toUpperCase().trim()];
        if (target === undefined) return null;
        const delta = ((target - base.getDay() + 7) % 7) || 7;
        base.setDate(base.getDate() + delta);
        return formatDate(base);
      }
      case 'LAST_DAY': {
        if (args[0] == null) return null;
        const base = coerceDate(args[0]);
        if (!base) return null;
        return formatDate(new Date(base.getFullYear(), base.getMonth() + 1, 0));
      }
      case 'MOD': return args[0] != null && args[1] != null ? Number(args[0]) % Number(args[1]) : null;
      case 'POWER': return args[0] != null && args[1] != null ? Math.pow(Number(args[0]), Number(args[1])) : null;
      case 'SQRT': return args[0] != null ? Math.sqrt(Number(args[0])) : null;
      case 'SIGN': return args[0] != null ? Math.sign(Number(args[0])) : null;
      case 'GREATEST': return args.filter(a => a != null).reduce<CellValue>((a, b) => (this.host.compareValues(a, b) >= 0 ? a : b), args[0]);
      case 'LEAST': return args.filter(a => a != null).reduce<CellValue>((a, b) => (this.host.compareValues(a, b) <= 0 ? a : b), args[0]);

      // Null handling
      case 'NVL': return args[0] ?? args[1] ?? null;
      case 'NVL2': return args[0] != null ? (args[1] ?? null) : (args[2] ?? null);
      case 'COALESCE': return args.find(a => a != null) ?? null;
      case 'NULLIF': return this.host.compareValues(args[0], args[1]) === 0 ? null : args[0];
      case 'DECODE': return this.evaluateDecode(args);

      // EXTRACT(field FROM date) — parsed as EXTRACT(fieldLiteral, sourceExpr)
      case 'EXTRACT': {
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
      }

      // Date functions
      case 'SYSDATE': return new Date().toISOString().slice(0, 19).replace('T', ' ');
      case 'SYSTIMESTAMP': return new Date().toISOString();
      case 'TO_CHAR': {
        if (args[0] == null) return null;
        const fmt = args[1] != null ? String(args[1]).toUpperCase() : null;
        if (fmt && (typeof args[0] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(args[0]))) {
          const d = new Date(args[0]);
          if (!isNaN(d.getTime())) {
            return this.host.formatOracleDate(d, fmt);
          }
        }
        return String(args[0]);
      }
      case 'TO_NUMBER': {
        if (args[0] == null) return null;
        const n = Number(args[0]);
        if (isNaN(n)) throw new OracleError(1722, 'invalid number');
        return n;
      }
      case 'TO_DATE': {
        if (args[0] == null) return null;
        const dateStr = String(args[0]);
        const dateFmt = args[1] != null ? String(args[1]).toUpperCase() : 'YYYY-MM-DD';
        return this.host.parseOracleDate(dateStr, dateFmt);
      }

      // System functions
      case 'USER': return this.host.getContext().currentUser;
      case 'SYS_GUID': return 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'.replace(/X/g, () => Math.floor(Math.random() * 16).toString(16).toUpperCase());
      case 'SYS_CONTEXT': {
        const namespace = args[0] != null ? String(args[0]).toUpperCase() : '';
        const param = args[1] != null ? String(args[1]).toUpperCase() : '';
        // USERENV — delegate to the live OracleSession.
        if (namespace === 'USERENV') {
          const session = this.host.getContext().session as { userenv?: (p: string) => unknown } | undefined;
          if (session?.userenv) {
            const value = session.userenv(param);
            return value === undefined ? null : value as string | number | null;
          }
          // Fallback when no session has been attached (engine-direct).
          if (param === 'SESSION_USER' || param === 'CURRENT_USER') return this.host.getContext().currentUser;
          if (param === 'CURRENT_SCHEMA') return this.host.getContext().currentSchema;
          return null;
        }
        // SYS_SESSION_ROLES / application contexts → unknown, NULL.
        return null;
      }
      case 'USERENV': {
        // The legacy USERENV(<keyword>) function is functionally
        // equivalent to SYS_CONTEXT('USERENV', <keyword>).
        const param = args[0] != null ? String(args[0]).toUpperCase() : '';
        const session = this.host.getContext().session as { userenv?: (p: string) => unknown } | undefined;
        if (session?.userenv) {
          const value = session.userenv(param);
          return value === undefined ? null : value as string | number | null;
        }
        return null;
      }

      // DBMS_RANDOM package
      case 'VALUE': {
        if (expr.schema?.toUpperCase() === 'DBMS_RANDOM') {
          if (args.length === 0) return Math.random();
          if (args.length >= 2) {
            const low = Number(args[0]);
            const high = Number(args[1]);
            return low + Math.random() * (high - low);
          }
          return Math.random();
        }
        return null;
      }
      case 'STRING': {
        if (expr.schema?.toUpperCase() === 'DBMS_RANDOM') {
          const opt = args.length > 0 ? String(args[0]).toUpperCase() : 'U';
          const len = args.length > 1 ? Number(args[1]) : 20;
          let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
          if (opt === 'L') chars = 'abcdefghijklmnopqrstuvwxyz';
          if (opt === 'A' || opt === 'X') chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
          if (opt === 'P') chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
          let result = '';
          for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)];
          return result;
        }
        return null;
      }
      case 'NORMAL': {
        if (expr.schema?.toUpperCase() === 'DBMS_RANDOM') {
          // Box-Muller transform for normal distribution
          const u1 = Math.random();
          const u2 = Math.random();
          return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        }
        return null;
      }

      // DBMS_LOCK.SLEEP (as function call — returns immediately in simulator)
      case 'SLEEP': {
        if (expr.schema?.toUpperCase() === 'DBMS_LOCK') return null;
        return null;
      }

      // DBMS_UTILITY functions
      case 'GET_TIME': {
        if (expr.schema?.toUpperCase() === 'DBMS_UTILITY') return Date.now() % 2147483647;
        return null;
      }
      case 'FORMAT_ERROR_BACKTRACE': {
        if (expr.schema?.toUpperCase() === 'DBMS_UTILITY') return '';
        return null;
      }
      case 'FORMAT_ERROR_STACK': {
        if (expr.schema?.toUpperCase() === 'DBMS_UTILITY') return '';
        return null;
      }

      // DBMS_METADATA.GET_DDL
      case 'GET_DDL': {
        if (expr.schema?.toUpperCase() === 'DBMS_METADATA') {
          return this.host.getMetadataDDL(args);
        }
        return null;
      }

      // DBMS_STATS procedures (as stubs)
      case 'GATHER_TABLE_STATS':
      case 'GATHER_SCHEMA_STATS': {
        if (expr.schema?.toUpperCase() === 'DBMS_STATS') return null;
        return null;
      }

      // DBMS_LOB functions
      case 'GETLENGTH': {
        if (expr.schema?.toUpperCase() === 'DBMS_LOB') {
          return args[0] != null ? String(args[0]).length : null;
        }
        return null;
      }

      // UTL_FILE stubs
      case 'FOPEN':
      case 'FCLOSE':
      case 'GET_LINE': {
        if (expr.schema?.toUpperCase() === 'UTL_FILE') return null;
        return null;
      }

      // COUNT(*) and other aggregates return a single value for a column evaluation context
      // Real aggregation is handled at the query level — here we just return the scalar value
      case 'COUNT': return args.length === 0 || (expr.args[0] && expr.args[0].type === 'Star') ? 1 : (args[0] != null ? 1 : 0);
      case 'SUM': case 'AVG': case 'MIN': case 'MAX': return args[0] ?? null;

      default: {
        const schema = expr.schema?.toUpperCase();
        const fullName = schema ? `${schema}.${name}` : name;
        // Not a builtin: try user-defined stored functions (incl. package
        // members) before concluding ORA-00904 like real Oracle.
        const bridged = this.host.callStoredFunction?.(fullName, args);
        if (bridged?.handled) return bridged.value;
        throw new OracleError(904, `"${fullName}": invalid identifier`);
      }
    }
  }

  private evaluateDecode(args: CellValue[]): CellValue {
    if (args.length < 3) return null;
    const expr = args[0];
    for (let i = 1; i + 1 < args.length; i += 2) {
      if (this.host.compareValues(expr, args[i]) === 0) return args[i + 1];
    }
    // Default (odd number of remaining args)
    return args.length % 2 === 0 ? args[args.length - 1] : null;
  }
}
