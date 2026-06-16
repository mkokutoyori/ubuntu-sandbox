/**
 * Pure value utilities shared by the SQL function registry and the
 * executor (Oracle 3-way comparison and implicit string→Date conversion).
 *
 * Date *formatting/parsing* lives in the single `dateSupport` module — it
 * is not duplicated here. This file keeps only the comparison-specific
 * implicit conversion (`implicitToDate`, which applies the DD-MON-RR NLS
 * default and RR century logic) and `compareValues`.
 */

import type { CellValue } from '../../engine/storage/BaseStorage';

const MONTHS_SHORT_INDEX: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** Try to parse a value as a Date for implicit conversion (DD-MON-YYYY, DD-MON-RR, ISO, etc.) */
export function implicitToDate(val: CellValue): Date | null {
  if (val instanceof Date) return val;
  if (val == null) return null;
  const s = String(val).trim();
  // Try DD-MON-YYYY or DD-MON-YY (Oracle default NLS_DATE_FORMAT)
  const oraMatch = s.match(/^(\d{1,2})[-/]([A-Za-z]{3})[-/](\d{2,4})(?:\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?$/);
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
 * string→number conversions, BINARY string collation otherwise
 * (NLS_SORT=BINARY, the default — byte order, not locale-aware).
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

  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
