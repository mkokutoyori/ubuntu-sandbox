export interface DiffLine {
  readonly text: string;
  readonly noEol: boolean;
}

export interface DiffOp {
  readonly kind: ' ' | '-' | '+';
  readonly text: string;
  readonly noEol: boolean;
  readonly aLine: number;
  readonly bLine: number;
}

export interface DiffRegion {
  readonly start: number;
  readonly end: number;
}

const NO_NEWLINE = '\\ No newline at end of file';

export function withMarker(prefix: string, op: DiffOp): string[] {
  return op.noEol ? [`${prefix}${op.text}`, NO_NEWLINE] : [`${prefix}${op.text}`];
}

function expandTabs(text: string, tabSize: number): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\t') out += ' '.repeat(tabSize - (out.length % tabSize));
    else out += ch;
  }
  return out;
}

export interface SideBySideOptions {
  readonly width: number;
  readonly leftColumn: boolean;
  readonly suppressCommon: boolean;
  readonly expandTabs: boolean;
  readonly tabSize: number;
}

function padTo(text: string, column: number, target: number, tabSize: number, useTabs: boolean): { text: string; column: number } {
  let out = text;
  let at = column;
  if (useTabs) {
    while (Math.floor(at / tabSize) * tabSize + tabSize <= target) {
      out += '\t';
      at = Math.floor(at / tabSize) * tabSize + tabSize;
    }
  }
  while (at < target) { out += ' '; at += 1; }
  return { text: out, column: at };
}

function visibleColumn(text: string, tabSize: number): number {
  let column = 0;
  for (const ch of text) column = ch === '\t' ? column + tabSize - (column % tabSize) : column + 1;
  return column;
}

function clip(text: string, limit: number, tabSize: number): string {
  let out = '';
  let column = 0;
  for (const ch of text) {
    const next = ch === '\t' ? column + tabSize - (column % tabSize) : column + 1;
    if (next > limit) break;
    out += ch;
    column = next;
  }
  return out;
}

export function renderSideBySide(ops: DiffOp[], options: SideBySideOptions): string[] {
  const { width, tabSize } = options;
  const half = Math.max(0, Math.floor((width - 3) / 2));
  const roundedTab = Math.ceil(half / tabSize) * tabSize;
  const marker = options.expandTabs ? half + 1 : Math.min(half + 1, roundedTab - 2);
  const rightStart = options.expandTabs ? half + 4 : roundedTab;
  const limit = half;
  const out: string[] = [];
  const line = (left: string | null, gutter: string, right: string | null): string => {
    const leftText = left === null ? '' : clip(options.expandTabs ? expandTabs(left, tabSize) : left, limit, tabSize);
    const column = visibleColumn(leftText, tabSize);
    const padded = padTo(leftText, column, marker, tabSize, !options.expandTabs);
    let result = padded.text + gutter;
    if (right === null) return result.replace(/[ \t]+$/, (trailing) => (gutter === ' ' ? '' : trailing));
    result += options.expandTabs ? '  ' : '\t';
    return result + clip(options.expandTabs ? expandTabs(right, tabSize) : right, limit, tabSize);
  };
  const commonLine = (text: string): string => {
    const shown = clip(options.expandTabs ? expandTabs(text, tabSize) : text, limit, tabSize);
    const padded = padTo(shown, visibleColumn(shown, tabSize), rightStart, tabSize, !options.expandTabs);
    return padded.text + shown;
  };
  let at = 0;
  while (at < ops.length) {
    const op = ops[at];
    if (op.kind === ' ') {
      if (!options.suppressCommon) out.push(options.leftColumn ? line(op.text, '(', null) : commonLine(op.text));
      at++;
      continue;
    }
    let end = at;
    while (end < ops.length && ops[end].kind !== ' ') end++;
    const removed = ops.slice(at, end).filter((entry) => entry.kind === '-');
    const added = ops.slice(at, end).filter((entry) => entry.kind === '+');
    const rows = Math.max(removed.length, added.length);
    for (let row = 0; row < rows; row++) {
      const left = removed[row]?.text ?? null;
      const right = added[row]?.text ?? null;
      if (left !== null && right !== null) out.push(line(left, '|', right));
      else if (left !== null) out.push(line(left, '<', null));
      else out.push(line(null, '>', right));
    }
    at = end;
  }
  return out;
}

export function renderEd(ops: DiffOp[], regions: readonly DiffRegion[], rcs: boolean): string[] {
  const out: string[] = [];
  const hunks = regions.map((region) => {
    const slice = ops.slice(region.start, region.end);
    return {
      removed: slice.filter((op) => op.kind === '-'),
      added: slice.filter((op) => op.kind === '+'),
      aStart: ops[region.start].aLine,
      bStart: ops[region.start].bLine,
    };
  });
  const ordered = rcs ? hunks : [...hunks].reverse();
  for (const hunk of ordered) {
    const { removed, added, aStart } = hunk;
    if (rcs) {
      if (removed.length > 0) out.push(`d${aStart} ${removed.length}`);
      if (added.length > 0) {
        out.push(`a${removed.length > 0 ? aStart + removed.length - 1 : aStart - 1} ${added.length}`);
        for (const op of added) out.push(op.text);
      }
      continue;
    }
    const range = removed.length <= 1 ? `${aStart}` : `${aStart},${aStart + removed.length - 1}`;
    if (added.length === 0) out.push(`${range}d`);
    else if (removed.length === 0) { out.push(`${aStart - 1}a`); for (const op of added) out.push(op.text); out.push('.'); }
    else { out.push(`${range}c`); for (const op of added) out.push(op.text); out.push('.'); }
  }
  return out;
}

export interface GroupFormats {
  oldGroup: string | null;
  newGroup: string | null;
  unchangedGroup: string | null;
  changedGroup: string | null;
  oldLine: string;
  newLine: string;
  unchangedLine: string;
}

export function defaultFormats(): GroupFormats {
  return { oldGroup: null, newGroup: null, unchangedGroup: null, changedGroup: null, oldLine: '%L', newLine: '%L', unchangedLine: '%L' };
}

export function ifdefFormats(name: string): GroupFormats {
  return {
    oldGroup: `#ifndef ${name}\n%<#endif /* ! ${name} */\n`,
    newGroup: `#ifdef ${name}\n%>#endif /* ${name} */\n`,
    changedGroup: `#ifndef ${name}\n%<#else /* ${name} */\n%>#endif /* ${name} */\n`,
    unchangedGroup: null,
    oldLine: '%L', newLine: '%L', unchangedLine: '%L',
  };
}

function formatNumber(spec: string, value: number): string {
  const match = /^([-+ #0]*)(\d*)([doxX])$/.exec(spec);
  if (match === null) return String(value);
  const base = match[3] === 'o' ? 8 : match[3] === 'd' ? 10 : 16;
  let digits = value.toString(base);
  if (match[3] === 'X') digits = digits.toUpperCase();
  const width = match[2] === '' ? 0 : Number(match[2]);
  const left = match[1].includes('-');
  const pad = match[1].includes('0') && !left ? '0' : ' ';
  return left ? digits.padEnd(width, ' ') : digits.padStart(width, pad);
}

function expandFormat(format: string, line: DiffOp | null, groups: { old: string; new: string; same: string }, numbers: Record<string, number>): string {
  let out = '';
  for (let at = 0; at < format.length; at++) {
    const ch = format[at];
    if (ch !== '%') { out += ch; continue; }
    const rest = format.slice(at + 1);
    if (rest.startsWith('%')) { out += '%'; at++; continue; }
    if (rest.startsWith('<')) { out += groups.old; at++; continue; }
    if (rest.startsWith('>')) { out += groups.new; at++; continue; }
    if (rest.startsWith('=')) { out += groups.same; at++; continue; }
    if (rest.startsWith('L') && line !== null) { out += `${line.text}\n`; at++; continue; }
    if (rest.startsWith('l') && line !== null) { out += line.text; at++; continue; }
    const quoted = /^c'(\\[0-7]{1,3}|\\[\\']|[^'\\])'/.exec(rest);
    if (quoted !== null) {
      const body = quoted[1];
      out += body.startsWith('\\') ? (/^\\[0-7]/.test(body) ? String.fromCharCode(parseInt(body.slice(1), 8)) : body[1]) : body;
      at += quoted[0].length;
      continue;
    }
    const numeric = /^([-+ #0]*\d*)([doxX])([flnFLNeE])/.exec(rest);
    if (numeric !== null) {
      const key = numeric[3];
      out += formatNumber(`${numeric[1]}${numeric[2]}`, numbers[key] ?? 0);
      at += numeric[0].length;
      continue;
    }
    out += ch;
  }
  return out;
}

export function renderGroupFormat(ops: DiffOp[], formats: GroupFormats): string {
  let out = '';
  const lineOf = (format: string, op: DiffOp): string => expandFormat(format, op, { old: '', new: '', same: '' }, { n: op.kind === '+' ? op.bLine : op.aLine });
  let at = 0;
  while (at < ops.length) {
    if (ops[at].kind === ' ') {
      let end = at;
      while (end < ops.length && ops[end].kind === ' ') end++;
      const run = ops.slice(at, end);
      const same = run.map((op) => lineOf(formats.unchangedLine, op)).join('');
      out += formats.unchangedGroup === null ? same : expandFormat(formats.unchangedGroup, null, { old: '', new: '', same }, groupNumbers(run, null));
      at = end;
      continue;
    }
    let end = at;
    while (end < ops.length && ops[end].kind !== ' ') end++;
    const removed = ops.slice(at, end).filter((op) => op.kind === '-');
    const added = ops.slice(at, end).filter((op) => op.kind === '+');
    const oldText = removed.map((op) => lineOf(formats.oldLine, op)).join('');
    const newText = added.map((op) => lineOf(formats.newLine, op)).join('');
    const numbers = groupNumbers(removed, added, ops[at]);
    const groups = { old: oldText, new: newText, same: '' };
    const both = removed.length > 0 && added.length > 0;
    const expandOr = (template: string | null, fallback: string): string => (template === null ? fallback : expandFormat(template, null, groups, numbers));
    if (both) {
      out += formats.changedGroup !== null
        ? expandFormat(formats.changedGroup, null, groups, numbers)
        : expandOr(formats.oldGroup, oldText) + expandOr(formats.newGroup, newText);
    } else if (removed.length > 0) out += expandOr(formats.oldGroup, oldText);
    else out += expandOr(formats.newGroup, newText);
    at = end;
  }
  return out;
}

function groupNumbers(first: DiffOp[], second: DiffOp[] | null, anchor?: DiffOp): Record<string, number> {
  const base = anchor ?? first[0];
  const aStart = base?.aLine ?? 0;
  const bStart = base?.bLine ?? 0;
  const removed = first.length;
  const added = second === null ? first.length : second.length;
  return { f: aStart, l: aStart + removed - 1, n: removed, e: aStart - 1, F: bStart, L: bStart + added - 1, N: added, E: bStart - 1 };
}
