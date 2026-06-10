/**
 * Pure value/date utilities shared by the SQL function registry and the
 * executor (comparison, implicit conversions, NLS-style date formatting).
 *
 * Oracle implicit-conversion rules implemented here:
 *  - NULLs sort last in ascending order.
 *  - String→Date conversion accepts the default NLS formats (DD-MON-RR,
 *    DD-MON-YYYY) and ISO datetimes; RR century logic applies (<50 → 20xx).
 *  - Number/string comparisons coerce the string when it is numeric.
 */

import type { CellValue } from '../../engine/storage/BaseStorage';

const MONTHS_LONG = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'] as const;
const DAYS_LONG = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
const MONTHS_SHORT_INDEX: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Render a Date through an Oracle TO_CHAR format mask (YYYY, MON, HH24, …). */
export function formatOracleDate(d: Date, fmt: string): string {
  const monthsShort = MONTHS_LONG.map(m => m.slice(0, 3));
  const daysShort = DAYS_LONG.map(day => day.slice(0, 3));
  let result = fmt;
  // Order matters: longest tokens first to avoid partial replacement
  result = result.replace(/YYYY/g, String(d.getFullYear()));
  result = result.replace(/YY/g, String(d.getFullYear()).slice(-2));
  result = result.replace(/MONTH/g, MONTHS_LONG[d.getMonth()]);
  result = result.replace(/MON/g, monthsShort[d.getMonth()]);
  result = result.replace(/MM/g, pad(d.getMonth() + 1));
  result = result.replace(/DD/g, pad(d.getDate()));
  result = result.replace(/DAY/g, DAYS_LONG[d.getDay()]);
  result = result.replace(/DY/g, daysShort[d.getDay()]);
  result = result.replace(/HH24/g, pad(d.getHours()));
  result = result.replace(/HH/g, pad(d.getHours() % 12 || 12));
  result = result.replace(/MI/g, pad(d.getMinutes()));
  result = result.replace(/SS/g, pad(d.getSeconds()));
  return result;
}

/** Parse a TO_DATE input through an Oracle format mask into the canonical datetime string. */
export function parseOracleDate(dateStr: string, fmt: string): string {
  // Try ISO format first
  const isoDate = new Date(dateStr);
  if (!isNaN(isoDate.getTime())) {
    return isoDate.toISOString().slice(0, 19).replace('T', ' ');
  }
  // Simple format-aware parsing for common Oracle formats
  let year = 2000, month = 1, day = 1, hour = 0, min = 0, sec = 0;
  const parts = dateStr.split(/[\s/\-:.,]+/);
  const fmtParts = fmt.toUpperCase().split(/[\s/\-:.,]+/);
  for (let i = 0; i < fmtParts.length && i < parts.length; i++) {
    const v = parseInt(parts[i], 10);
    if (isNaN(v) && fmtParts[i] === 'MON') {
      const idx = MONTHS_SHORT_INDEX[parts[i].toUpperCase().slice(0, 3)];
      if (idx !== undefined) month = idx + 1;
      continue;
    }
    if (isNaN(v)) continue;
    switch (fmtParts[i]) {
      case 'YYYY': year = v; break;
      case 'YY': year = 2000 + v; break;
      case 'MM': month = v; break;
      case 'DD': day = v; break;
      case 'HH24': case 'HH': hour = v; break;
      case 'MI': min = v; break;
      case 'SS': sec = v; break;
    }
  }
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(min)}:${pad(sec)}`;
}

/** Try to parse a value as a Date for implicit conversion (DD-MON-YYYY, DD-MON-RR, ISO, etc.) */
export function implicitToDate(val: CellValue): Date | null {
  if (val instanceof Date) return val;
  if (val == null) return null;
  const s = String(val).trim();
  // Try DD-MON-YYYY or DD-MON-YY (Oracle default NLS_DATE_FORMAT)
  const oraMatch = s.match(/^(\d{1,2})[\-/]([A-Za-z]{3})[\-/](\d{2,4})(?:\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?$/);
  if (oraMatch) {
    const mon = MONTHS_SHORT_INDEX[oraMatch[2].toUpperCase()];
    if (mon !== undefined) {
      let yr = parseInt(oraMatch[3], 10);
      if (yr < 100) yr += yr < 50 ? 2000 : 1900; // RR logic
      const d = new Date(yr, mon, parseInt(oraMatch[1], 10),
        oraMatch[4] ? parseInt(oraMatch[4], 10) : 0,
        oraMatch[5] ? parseInt(oraMatch[5], 10) : 0,
        oraMatch[6] ? parseInt(oraMatch[6], 10) : 0);
      if (!isNaN(d.getTime())) return d;
    }
  }
  // Try ISO / JS-parseable format
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  return null;
}

/**
 * Oracle 3-way comparison: NULLs last in ASC, implicit string→Date and
 * string→number conversions, string collation otherwise.
 */
export function compareValues(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;  // Oracle: NULLs sort last in ASC
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;

  // Date comparison: implicit string→Date conversion (Oracle NLS_DATE_FORMAT behavior)
  const aIsDate = a instanceof Date;
  const bIsDate = b instanceof Date;
  if (aIsDate || bIsDate) {
    const da = aIsDate ? (a as Date) : implicitToDate(a);
    const db = bIsDate ? (b as Date) : implicitToDate(b);
    if (da && db) return da.getTime() - db.getTime();
  }

  // Number vs string: implicit conversion
  if (typeof a === 'number' && typeof b === 'string') {
    const n = Number(b);
    if (!isNaN(n)) return a - n;
  }
  if (typeof a === 'string' && typeof b === 'number') {
    const n = Number(a);
    if (!isNaN(n)) return n - b;
  }

  return String(a).localeCompare(String(b));
}
