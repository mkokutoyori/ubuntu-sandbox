import type { CellValue } from '../../engine/storage/BaseStorage';
import type { SqlFunctionBundle } from './types';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const withText = (value: CellValue, fn: (text: string) => CellValue): CellValue =>
  value == null ? null : fn(String(value));

const padTo = (str: string, targetLength: number, padText: string, left: boolean): CellValue => {
  if (!Number.isFinite(targetLength) || targetLength <= 0) return null;
  if (str.length >= targetLength) return str.substring(0, targetLength);
  if (padText.length === 0) return str;
  let fill = '';
  while (fill.length < targetLength - str.length) fill += padText;
  fill = fill.substring(0, targetLength - str.length);
  return left ? fill + str : str + fill;
};

export const stringFunctions: SqlFunctionBundle = {
  UPPER: ([v]) => withText(v, t => t.toUpperCase()),

  LOWER: ([v]) => withText(v, t => t.toLowerCase()),

  INITCAP: ([v]) => withText(v, t =>
    t.toLowerCase().replace(/[a-z0-9]+/g, w => w.charAt(0).toUpperCase() + w.slice(1))),

  LENGTH: ([v]) => withText(v, t => t.length),

  SUBSTR: ([v, startArg, lenArg]) => withText(v, str => {
    let start = Number(startArg);
    const len = lenArg != null ? Number(lenArg) : undefined;
    if (start < 0) start = str.length + start + 1;
    if (start === 0) start = 1;
    const jsStart = start - 1;
    if (jsStart < 0) return len !== undefined ? str.substring(0, len + jsStart) : '';
    return str.substring(jsStart, len !== undefined ? jsStart + len : undefined);
  }),

  INSTR: ([source, searchArg, startArg, occurrenceArg]) => {
    if (source == null || searchArg == null) return null;
    const str = String(source);
    const search = String(searchArg);
    const startPos = startArg != null ? Number(startArg) : 1;
    const occurrence = occurrenceArg != null ? Number(occurrenceArg) : 1;
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

  TRIM: (args) => {
    if (args[0] == null) return null;
    const trimStr = String(args[0]);
    if (args.length >= 3 && args[2] != null) {
      const trimChars = String(args[1] ?? ' ');
      const spec = String(args[2]).toUpperCase();
      const charClass = `[${escapeRegExp(trimChars)}]`;
      if (spec === 'LEADING') return trimStr.replace(new RegExp(`^${charClass}+`), '');
      if (spec === 'TRAILING') return trimStr.replace(new RegExp(`${charClass}+$`), '');
      return trimStr
        .replace(new RegExp(`^${charClass}+`), '')
        .replace(new RegExp(`${charClass}+$`), '');
    }
    return trimStr.trim();
  },

  LTRIM: ([v, charsArg]) => withText(v, str => {
    const chars = charsArg != null ? String(charsArg) : ' ';
    return str.replace(new RegExp(`^[${escapeRegExp(chars)}]+`), '');
  }),

  RTRIM: ([v, charsArg]) => withText(v, str => {
    const chars = charsArg != null ? String(charsArg) : ' ';
    return str.replace(new RegExp(`[${escapeRegExp(chars)}]+$`), '');
  }),

  LPAD: ([v, lenArg, padArg]) => withText(v, str =>
    padTo(str, Number(lenArg), padArg != null ? String(padArg) : ' ', true)),

  RPAD: ([v, lenArg, padArg]) => withText(v, str =>
    padTo(str, Number(lenArg), padArg != null ? String(padArg) : ' ', false)),

  REPLACE: ([v, search, replacement]) => withText(v, str =>
    str.replaceAll(String(search ?? ''), String(replacement ?? ''))),

  CONCAT: ([a, b]) => (a != null ? String(a) : '') + (b != null ? String(b) : ''),

  CHR: ([v]) => (v != null ? String.fromCharCode(Number(v)) : null),

  ASCII: ([v]) => withText(v, t => (t.length ? t.charCodeAt(0) : null)),

  REGEXP_REPLACE: ([v, patArg, repArg]) => withText(v, src => {
    const pat = String(patArg ?? '');
    const rep = repArg != null ? String(repArg) : '';
    try { return src.replace(new RegExp(pat, 'g'), rep); } catch { return src; }
  }),

  REGEXP_SUBSTR: ([v, patArg]) => withText(v, src => {
    try {
      const m = src.match(new RegExp(String(patArg ?? '')));
      return m ? m[0] : null;
    } catch { return null; }
  }),

  REGEXP_INSTR: ([v, patArg]) => withText(v, src => {
    try {
      const m = src.match(new RegExp(String(patArg ?? '')));
      return m && m.index !== undefined ? m.index + 1 : 0;
    } catch { return 0; }
  }),

  REGEXP_COUNT: ([v, patArg]) => withText(v, src => {
    try {
      const matches = src.match(new RegExp(String(patArg ?? ''), 'g'));
      return matches ? matches.length : 0;
    } catch { return 0; }
  }),
};
