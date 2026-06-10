/**
 * Oracle built-in string functions (UPPER, SUBSTR, INSTR, TRIM, REGEXP_*…).
 *
 * Faithful Oracle quirks preserved: SUBSTR's negative/zero start positions,
 * INSTR's backwards search with negative positions, TRIM's
 * LEADING/TRAILING/BOTH specs.
 */

import type { SqlFunction } from './types';

const escapeForCharClass = (chars: string): string =>
  chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const stringFunctions: Record<string, SqlFunction> = {
  UPPER: ({ args }) => (args[0] != null ? String(args[0]).toUpperCase() : null),
  LOWER: ({ args }) => (args[0] != null ? String(args[0]).toLowerCase() : null),
  INITCAP: ({ args }) => (args[0] != null ? String(args[0]).replace(/\b\w/g, c => c.toUpperCase()) : null),
  LENGTH: ({ args }) => (args[0] != null ? String(args[0]).length : null),

  SUBSTR: ({ args }) => {
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
  },

  INSTR: ({ args }) => {
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
    }
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
  },

  TRIM: ({ args }) => {
    if (args[0] == null) return null;
    const trimStr = String(args[0]);
    // Enhanced TRIM: args = [source, chars, spec] where spec is LEADING/TRAILING/BOTH
    if (args.length >= 3 && args[2] != null) {
      const charClass = `[${escapeForCharClass(String(args[1] ?? ' '))}]`;
      const spec = String(args[2]).toUpperCase();
      if (spec === 'LEADING') return trimStr.replace(new RegExp(`^${charClass}+`), '');
      if (spec === 'TRAILING') return trimStr.replace(new RegExp(`${charClass}+$`), '');
      return trimStr.replace(new RegExp(`^${charClass}+`), '').replace(new RegExp(`${charClass}+$`), '');
    }
    return trimStr.trim();
  },

  LTRIM: ({ args }) => {
    if (args[0] == null) return null;
    const escaped = escapeForCharClass(args[1] != null ? String(args[1]) : ' ');
    return String(args[0]).replace(new RegExp(`^[${escaped}]+`), '');
  },

  RTRIM: ({ args }) => {
    if (args[0] == null) return null;
    const escaped = escapeForCharClass(args[1] != null ? String(args[1]) : ' ');
    return String(args[0]).replace(new RegExp(`[${escaped}]+$`), '');
  },

  LPAD: ({ args }) => {
    if (args[0] == null) return null;
    return String(args[0]).padStart(Number(args[1]), args[2] != null ? String(args[2]) : ' ');
  },

  RPAD: ({ args }) => {
    if (args[0] == null) return null;
    return String(args[0]).padEnd(Number(args[1]), args[2] != null ? String(args[2]) : ' ');
  },

  REPLACE: ({ args }) => {
    if (args[0] == null) return null;
    return String(args[0]).replaceAll(String(args[1] ?? ''), String(args[2] ?? ''));
  },

  CONCAT: ({ args }) =>
    (args[0] != null ? String(args[0]) : '') + (args[1] != null ? String(args[1]) : ''),

  CHR: ({ args }) => (args[0] != null ? String.fromCharCode(Number(args[0])) : null),
  ASCII: ({ args }) => (args[0] != null ? String(args[0]).charCodeAt(0) : null),

  REGEXP_REPLACE: ({ args }) => {
    if (args[0] == null) return null;
    const src = String(args[0]);
    const pat = String(args[1] ?? '');
    const rep = args[2] != null ? String(args[2]) : '';
    try { return src.replace(new RegExp(pat, 'g'), rep); } catch { return src; }
  },

  REGEXP_SUBSTR: ({ args }) => {
    if (args[0] == null) return null;
    try { const m = String(args[0]).match(new RegExp(String(args[1] ?? ''))); return m ? m[0] : null; } catch { return null; }
  },

  REGEXP_INSTR: ({ args }) => {
    if (args[0] == null) return null;
    try {
      const m = String(args[0]).match(new RegExp(String(args[1] ?? '')));
      return m && m.index !== undefined ? m.index + 1 : 0;
    } catch { return 0; }
  },

  REGEXP_COUNT: ({ args }) => {
    if (args[0] == null) return null;
    try {
      const matches = String(args[0]).match(new RegExp(String(args[1] ?? ''), 'g'));
      return matches ? matches.length : 0;
    } catch { return 0; }
  },
};
