import { NON_SINGLE_CELL_RANGES } from './VimCharWidth';

export const EDGE_MARK_COL = -2;

export interface ListSpec {
  readonly eol: string | null;
  readonly tab: readonly [string, string, string | null] | null;
  readonly space: string | null;
  readonly lead: string | null;
  readonly trail: string | null;
  readonly nbsp: string | null;
  readonly extends: string | null;
  readonly precedes: string | null;
  readonly multispace: readonly string[] | null;
  readonly leadmultispace: readonly string[] | null;
}

export type CellStyle = 'text' | 'special';

export interface Cell {
  readonly ch: string;
  readonly style: CellStyle;
  readonly col: number;
  readonly first: boolean;
}

export interface CellOptions {
  readonly tabstop: number;
  readonly list: boolean;
  readonly listchars: ListSpec;
  readonly wrapWidth: number | null;
}

const NO_LIST: ListSpec = {
  eol: null, tab: null, space: null, lead: null, trail: null, nbsp: null,
  extends: null, precedes: null, multispace: null, leadmultispace: null,
};

export function parseListChars(spec: string): ListSpec {
  const found: Record<string, string> = {};
  for (const item of spec.split(',')) {
    const separator = item.indexOf(':');
    if (separator > 0) found[item.slice(0, separator)] = item.slice(separator + 1);
  }
  const tab = found.tab === undefined ? null : [...found.tab];
  return {
    ...NO_LIST,
    eol: found.eol ?? null,
    tab: tab === null ? null : [tab[0], tab[1], tab[2] ?? null],
    space: found.space ?? null,
    lead: found.lead ?? null,
    trail: found.trail ?? null,
    nbsp: found.nbsp ?? null,
    extends: found.extends ?? null,
    precedes: found.precedes ?? null,
    multispace: found.multispace === undefined ? null : [...found.multispace],
    leadmultispace: found.leadmultispace === undefined ? null : [...found.leadmultispace],
  };
}

export function codePointWidth(code: number): number {
  if (code < 0x20 || code === 0x7f) return 2;
  if (code < 0x80) return 1;
  const table = NON_SINGLE_CELL_RANGES;
  let low = 0;
  let high = table.length / 3 - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const base = mid * 3;
    if (code < table[base]) high = mid - 1;
    else if (code > table[base + 1]) low = mid + 1;
    else return table[base + 2];
  }
  return 1;
}

function hexForm(code: number): string {
  const digits = code.toString(16);
  return `<${digits.length < 2 ? `0${digits}` : digits}>`;
}

function glyphOf(code: number, text: string): string[] {
  if (code < 0x20) return ['^', String.fromCharCode(code + 64)];
  if (code === 0x7f) return ['^', '?'];
  const width = codePointWidth(code);
  if (width >= 4) return [...hexForm(code)];
  return [text];
}

export function expandLine(text: string, options: CellOptions): Cell[] {
  const cells: Cell[] = [];
  const spec = options.list ? options.listchars : NO_LIST;
  let lastNonSpace = -1;
  let firstNonSpace = text.length;
  if (options.list) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== ' ' && text[i] !== '\t') { firstNonSpace = i; break; }
    }
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] !== ' ' && text[i] !== '\t') { lastNonSpace = i; break; }
    }
  }
  let runStart = -1;
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i)!;
    const length = code > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + length);
    const width = codePointWidth(code);
    const vcol = cells.length;
    const filler = options.wrapWidth !== null && code >= 0x80 && width === 2 && vcol % options.wrapWidth === options.wrapWidth - 1;
    if (filler) cells.push({ ch: '>', style: 'special', col: EDGE_MARK_COL, first: false });
    if (width === 0 && cells.length > 0) {
      const previous = cells[cells.length - 1];
      cells[cells.length - 1] = { ...previous, ch: previous.ch + ch };
      i += length;
      continue;
    }
    if (ch === '\t') {
      const span = options.tabstop - (cells.length % options.tabstop);
      if (options.list && spec.tab === null) {
        cells.push({ ch: '^', style: 'special', col: i, first: true }, { ch: 'I', style: 'special', col: i, first: false });
      } else if (options.list && spec.tab !== null) {
        for (let k = 0; k < span; k++) {
          let shown = spec.tab[1];
          if (k === 0 && span > 1) shown = spec.tab[0];
          else if (k === span - 1 && spec.tab[2] !== null) shown = spec.tab[2];
          else if (span === 1) shown = spec.tab[2] ?? spec.tab[0];
          cells.push({ ch: shown, style: 'special', col: i, first: k === 0 });
        }
      } else {
        for (let k = 0; k < span; k++) cells.push({ ch: ' ', style: 'text', col: i, first: k === 0 });
      }
    } else if (code < 0x20 || code === 0x7f || width >= 4) {
      glyphOf(code, ch).forEach((piece, k) => cells.push({ ch: piece, style: 'special', col: i, first: k === 0 }));
    } else if (width === 2) {
      cells.push({ ch, style: 'text', col: i, first: true }, { ch: '', style: 'text', col: i, first: false });
    } else {
      let shown = ch;
      let style: CellStyle = 'text';
      if (options.list) {
        const leading = i < firstNonSpace;
        const trailing = i > lastNonSpace;
        if (ch === ' ' && spec.nbsp !== null) { shown = spec.nbsp; style = 'special'; }
        else if (ch === ' ') {
          if (runStart < 0) runStart = i;
          const offset = i - runStart;
          const next = text[i + 1];
          const runLength = next === ' ' || (i > 0 && text[i - 1] === ' ') ? 2 : 1;
          if (trailing && spec.trail !== null) { shown = spec.trail; style = 'special'; }
          else if (leading && spec.leadmultispace !== null && runLength > 1) { shown = spec.leadmultispace[offset % spec.leadmultispace.length]; style = 'special'; }
          else if (leading && spec.lead !== null) { shown = spec.lead; style = 'special'; }
          else if (spec.multispace !== null && runLength > 1) { shown = spec.multispace[offset % spec.multispace.length]; style = 'special'; }
          else if (spec.space !== null) { shown = spec.space; style = 'special'; }
        }
      }
      if (ch !== ' ') runStart = -1;
      cells.push({ ch: shown, style, col: i, first: true });
    }
    i += length;
  }
  return cells;
}
