import { shortOptions, getoptDiagnostic } from '../commands/Getopt';
import { GNU_OPTION_SETS } from '../GnuOptionGuard';

export interface DiffEntryStat {
  readonly type: 'file' | 'directory' | 'other';
  readonly mtimeMs: number;
}

export interface DiffFs {
  readFile(path: string): string | null;
  normalizePath(path: string, cwd: string): string;
  stat(path: string): DiffEntryStat | null;
  list(path: string): string[] | null;
  formatTime(ms: number): string;
}

export interface DiffResult {
  output: string;
  exitCode: number;
}

type Format = 'normal' | 'unified' | 'context';

interface DiffOptions {
  format: Format;
  context: number;
  brief: boolean;
  reportIdentical: boolean;
  ignoreCase: boolean;
  ignoreAllSpace: boolean;
  ignoreSpaceChange: boolean;
  ignoreTrailingSpace: boolean;
  ignoreBlankLines: boolean;
  recursive: boolean;
  newFile: boolean;
  labels: string[];
  excludes: RegExp[];
  optionText: string;
}

interface Op {
  readonly kind: ' ' | '-' | '+';
  readonly text: string;
  readonly aLine: number;
  readonly bLine: number;
}

function splitLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function comparisonKey(line: string, options: DiffOptions): string {
  let key = line;
  if (options.ignoreAllSpace) key = key.replace(/[ \t\r\f\v]+/g, '');
  else if (options.ignoreSpaceChange) key = key.replace(/[ \t\r\f\v]+/g, ' ').replace(/ $/, '');
  else if (options.ignoreTrailingSpace) key = key.replace(/[ \t\r\f\v]+$/, '');
  return options.ignoreCase ? key.toLowerCase() : key;
}

function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

function editScript(a: string[], b: string[], options: DiffOptions): Op[] {
  const keysA = a.map((line) => comparisonKey(line, options));
  const keysB = b.map((line) => comparisonKey(line, options));
  const table = lcsTable(keysA, keysB);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && keysA[i] === keysB[j]) {
      ops.push({ kind: ' ', text: a[i], aLine: i + 1, bLine: j + 1 });
      i++; j++;
    } else if (i < a.length && (j >= b.length || table[i + 1][j] >= table[i][j + 1])) {
      ops.push({ kind: '-', text: a[i], aLine: i + 1, bLine: j + 1 });
      i++;
    } else {
      ops.push({ kind: '+', text: b[j], aLine: i + 1, bLine: j + 1 });
      j++;
    }
  }
  return options.ignoreBlankLines ? dropBlankOnlyChanges(ops) : ops;
}

function dropBlankOnlyChanges(ops: Op[]): Op[] {
  const result: Op[] = [];
  let at = 0;
  while (at < ops.length) {
    if (ops[at].kind === ' ') { result.push(ops[at++]); continue; }
    let end = at;
    while (end < ops.length && ops[end].kind !== ' ') end++;
    const region = ops.slice(at, end);
    if (region.every((op) => op.text.trim() === '')) {
      for (const op of region) if (op.kind === '-') result.push({ ...op, kind: ' ' });
    } else result.push(...region);
    at = end;
  }
  return result;
}

interface Region {
  readonly start: number;
  readonly end: number;
}

function changeRegions(ops: Op[]): Region[] {
  const regions: Region[] = [];
  let at = 0;
  while (at < ops.length) {
    if (ops[at].kind === ' ') { at++; continue; }
    let end = at;
    while (end < ops.length && ops[end].kind !== ' ') end++;
    regions.push({ start: at, end });
    at = end;
  }
  return regions;
}

function hunkGroups(ops: Op[], context: number): Region[] {
  const groups: Region[] = [];
  for (const region of changeRegions(ops)) {
    const last = groups[groups.length - 1];
    const from = Math.max(0, region.start - context);
    const to = Math.min(ops.length, region.end + context);
    if (last !== undefined && from <= last.end) groups[groups.length - 1] = { start: last.start, end: to };
    else groups.push({ start: from, end: to });
  }
  return groups;
}

function normalRange(start: number, count: number): string {
  if (count === 0) return String(start);
  return count === 1 ? String(start + 1) : `${start + 1},${start + count}`;
}

function renderNormal(ops: Op[]): string[] {
  const out: string[] = [];
  for (const region of changeRegions(ops)) {
    const removed = ops.slice(region.start, region.end).filter((op) => op.kind === '-');
    const added = ops.slice(region.start, region.end).filter((op) => op.kind === '+');
    const aStart = ops[region.start].aLine - 1;
    const bStart = ops[region.start].bLine - 1;
    const op = removed.length === 0 ? 'a' : added.length === 0 ? 'd' : 'c';
    out.push(`${normalRange(aStart, removed.length)}${op}${normalRange(bStart, added.length)}`);
    for (const line of removed) out.push(`< ${line.text}`);
    if (removed.length > 0 && added.length > 0) out.push('---');
    for (const line of added) out.push(`> ${line.text}`);
  }
  return out;
}

function unifiedRange(first: number, count: number): string {
  if (count === 1) return String(first);
  return `${count === 0 ? first - 1 : first},${count}`;
}

function sideSpan(slice: Op[], side: 'a' | 'b'): { first: number; count: number; previous: number } {
  const own = slice.filter((op) => op.kind === ' ' || op.kind === (side === 'a' ? '-' : '+'));
  const first = own.length > 0 ? (side === 'a' ? own[0].aLine : own[0].bLine) : (side === 'a' ? slice[0].aLine : slice[0].bLine);
  return { first, count: own.length, previous: first };
}

function renderUnified(ops: Op[], context: number, headers: [string, string]): string[] {
  const out = [`--- ${headers[0]}`, `+++ ${headers[1]}`];
  for (const group of hunkGroups(ops, context)) {
    const slice = ops.slice(group.start, group.end);
    const a = sideSpan(slice, 'a');
    const b = sideSpan(slice, 'b');
    out.push(`@@ -${unifiedRange(a.first, a.count)} +${unifiedRange(b.first, b.count)} @@`);
    for (const op of slice) out.push(`${op.kind}${op.text}`);
  }
  return out;
}

function contextRange(first: number, count: number): string {
  if (count === 0) return String(first - 1);
  return count === 1 ? String(first) : `${first},${first + count - 1}`;
}

function changeMarkers(ops: Op[]): Map<number, string> {
  const markers = new Map<number, string>();
  for (const region of changeRegions(ops)) {
    const kinds = new Set(ops.slice(region.start, region.end).map((op) => op.kind));
    const mixed = kinds.has('-') && kinds.has('+');
    for (let at = region.start; at < region.end; at++) markers.set(at, mixed ? '!' : ops[at].kind);
  }
  return markers;
}

function renderContext(ops: Op[], context: number, headers: [string, string]): string[] {
  const out = [`*** ${headers[0]}`, `--- ${headers[1]}`];
  const markers = changeMarkers(ops);
  for (const group of hunkGroups(ops, context)) {
    const slice = ops.slice(group.start, group.end);
    const a = sideSpan(slice, 'a');
    const b = sideSpan(slice, 'b');
    const marked = (kind: '-' | '+'): boolean => slice.some((op) => op.kind === kind);
    out.push('***************');
    out.push(`*** ${contextRange(a.first, a.count)} ****`);
    if (marked('-')) {
      slice.forEach((op, offset) => {
        if (op.kind !== '+') out.push(op.kind === ' ' ? `  ${op.text}` : `${markers.get(group.start + offset)} ${op.text}`);
      });
    }
    out.push(`--- ${contextRange(b.first, b.count)} ----`);
    if (marked('+')) {
      slice.forEach((op, offset) => {
        if (op.kind !== '-') out.push(op.kind === ' ' ? `  ${op.text}` : `${markers.get(group.start + offset)} ${op.text}`);
      });
    }
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (const c of glob) {
    if (c === '*') source += '.*';
    else if (c === '?') source += '.';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function parse(args: string[]): { options: DiffOptions; operands: string[] } | { error: DiffResult } {
  const set = GNU_OPTION_SETS.diff;
  const options: DiffOptions = {
    format: 'normal', context: 3, brief: false, reportIdentical: false, ignoreCase: false, ignoreAllSpace: false,
    ignoreSpaceChange: false, ignoreTrailingSpace: false, ignoreBlankLines: false, recursive: false, newFile: false,
    labels: [], excludes: [], optionText: '',
  };
  const operands: string[] = [];
  const typed: string[] = [];
  for (const item of shortOptions(args, set.optstring, set.long)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') {
      return { error: { output: `${getoptDiagnostic('diff', item)}\ndiff: Try 'diff --help' for more information.`, exitCode: 2 } };
    }
    const value = item.argument;
    if (/^[0-9]$/.test(item.letter)) { options.format = 'context'; options.context = Number(`${options.context === 3 ? '' : options.context}${item.letter}`); continue; }
    switch (item.letter) {
      case 'u': options.format = 'unified'; if (value !== undefined) options.context = Number(value); break;
      case 'U': options.format = 'unified'; options.context = Number(value); break;
      case 'c': options.format = 'context'; if (value !== undefined) options.context = Number(value); break;
      case 'C': options.format = 'context'; options.context = Number(value); break;
      case 'q': options.brief = true; break;
      case 's': options.reportIdentical = true; break;
      case 'i': options.ignoreCase = true; break;
      case 'w': options.ignoreAllSpace = true; break;
      case 'b': options.ignoreSpaceChange = true; break;
      case 'Z': options.ignoreTrailingSpace = true; break;
      case 'B': options.ignoreBlankLines = true; break;
      case 'r': options.recursive = true; break;
      case 'N': options.newFile = true; break;
      case 'L': options.labels.push(value ?? ''); break;
      case 'x': options.excludes.push(globToRegExp(value ?? '')); break;
      default: break;
    }
  }
  for (const arg of args) if (arg.startsWith('-') && arg !== '-') typed.push(arg);
  options.optionText = typed.filter((arg) => !/^-[LxXSIDFWU]$/.test(arg)).join(' ');
  if (!Number.isFinite(options.context) || options.context < 0) options.context = 3;
  return { options, operands };
}

class Differ {
  readonly lines: string[] = [];
  status = 0;

  constructor(private readonly fs: DiffFs, private readonly cwd: string, private readonly options: DiffOptions) {}

  private trouble(message: string): void {
    this.lines.push(message);
    this.status = 2;
  }

  private mark(): void {
    if (this.status < 1) this.status = 1;
  }

  private header(path: string, mtimeMs: number | null, index: number): string {
    const label = this.options.labels[index];
    if (label !== undefined) return label;
    return mtimeMs === null ? path : `${path}\t${this.fs.formatTime(mtimeMs)}`;
  }

  compareFiles(pathA: string, pathB: string, contentA: string | null, contentB: string | null, announce: boolean): void {
    const a = splitLines(contentA ?? '');
    const b = splitLines(contentB ?? '');
    const ops = editScript(a, b, this.options);
    if (changeRegions(ops).length === 0) {
      if (this.options.reportIdentical) this.lines.push(`Files ${pathA} and ${pathB} are identical`);
      return;
    }
    this.mark();
    if (this.options.brief) { this.lines.push(`Files ${pathA} and ${pathB} differ`); return; }
    if (announce) this.lines.push(`diff ${this.options.optionText ? `${this.options.optionText} ` : ''}${pathA} ${pathB}`.replace(/ +/g, ' '));
    const statA = this.fs.stat(this.fs.normalizePath(pathA, this.cwd));
    const statB = this.fs.stat(this.fs.normalizePath(pathB, this.cwd));
    const headers: [string, string] = [
      this.header(pathA, contentA === null ? null : statA?.mtimeMs ?? null, 0),
      this.header(pathB, contentB === null ? null : statB?.mtimeMs ?? null, 1),
    ];
    if (this.options.format === 'unified') this.lines.push(...renderUnified(ops, this.options.context, headers));
    else if (this.options.format === 'context') this.lines.push(...renderContext(ops, this.options.context, headers));
    else this.lines.push(...renderNormal(ops));
  }

  compare(pathA: string, pathB: string, announce: boolean): void {
    const absA = this.fs.normalizePath(pathA, this.cwd);
    const absB = this.fs.normalizePath(pathB, this.cwd);
    const statA = this.fs.stat(absA);
    const statB = this.fs.stat(absB);
    const missing = (path: string, stat: DiffEntryStat | null): boolean => stat === null && !this.options.newFile && (this.trouble(`diff: ${path}: No such file or directory`), true);
    if (missing(pathA, statA) || missing(pathB, statB)) return;
    if (statA?.type === 'directory' && statB?.type === 'directory') { this.compareDirectories(pathA, pathB); return; }
    if (statA?.type === 'directory' && statB !== null) {
      this.compare(`${pathA.replace(/\/+$/, '')}/${pathB.split('/').pop()}`, pathB, announce);
      return;
    }
    if (statB?.type === 'directory' && statA !== null) {
      this.compare(pathA, `${pathB.replace(/\/+$/, '')}/${pathA.split('/').pop()}`, announce);
      return;
    }
    const contentA = statA === null ? null : this.fs.readFile(absA);
    const contentB = statB === null ? null : this.fs.readFile(absB);
    this.compareFiles(pathA, pathB, contentA, contentB, announce);
  }

  private compareDirectories(dirA: string, dirB: string): void {
    const namesA = this.fs.list(this.fs.normalizePath(dirA, this.cwd)) ?? [];
    const namesB = this.fs.list(this.fs.normalizePath(dirB, this.cwd)) ?? [];
    const names = [...new Set([...namesA, ...namesB])]
      .filter((name) => name !== '.' && name !== '..' && !this.options.excludes.some((pattern) => pattern.test(name)))
      .sort();
    const join = (dir: string, name: string): string => `${dir.replace(/\/+$/, '')}/${name}`;
    for (const name of names) {
      const inA = namesA.includes(name);
      const inB = namesB.includes(name);
      const childA = join(dirA, name);
      const childB = join(dirB, name);
      if (inA && inB) {
        const typeA = this.fs.stat(this.fs.normalizePath(childA, this.cwd))?.type;
        const typeB = this.fs.stat(this.fs.normalizePath(childB, this.cwd))?.type;
        if (typeA === 'directory' && typeB === 'directory') {
          if (this.options.recursive) this.compareDirectories(childA, childB);
          else this.lines.push(`Common subdirectories: ${childA} and ${childB}`);
        } else if (typeA === 'directory' || typeB === 'directory') {
          this.mark();
          this.lines.push(`File ${childA} is a ${typeA === 'directory' ? 'directory' : 'regular file'} while file ${childB} is a ${typeB === 'directory' ? 'directory' : 'regular file'}`);
        } else this.compare(childA, childB, true);
      } else if (this.options.newFile) {
        const present = inA ? childA : childB;
        const type = this.fs.stat(this.fs.normalizePath(present, this.cwd))?.type;
        if (type === 'directory' && this.options.recursive) {
          this.compareDirectories(inA ? childA : childB, inA ? childB : childA);
        } else this.compareFiles(childA, childB, inA ? this.fs.readFile(this.fs.normalizePath(childA, this.cwd)) : '', inB ? this.fs.readFile(this.fs.normalizePath(childB, this.cwd)) : '', true);
      } else {
        this.mark();
        this.lines.push(`Only in ${inA ? dirA.replace(/\/+$/, '') || '/' : dirB.replace(/\/+$/, '') || '/'}: ${name}`);
      }
    }
  }
}

export function cmdDiff(fs: DiffFs, cwd: string, args: string[]): DiffResult {
  const parsed = parse(args);
  if ('error' in parsed) return parsed.error;
  const { options, operands } = parsed;
  if (operands.length < 2) {
    return { output: operands.length === 0 ? "diff: missing operand after 'diff'\ndiff: Try 'diff --help' for more information." : `diff: missing operand after '${operands[0]}'\ndiff: Try 'diff --help' for more information.`, exitCode: 2 };
  }
  if (operands.length > 2) {
    return { output: `diff: extra operand '${operands[2]}'\ndiff: Try 'diff --help' for more information.`, exitCode: 2 };
  }
  const differ = new Differ(fs, cwd, options);
  differ.compare(operands[0], operands[1], false);
  return { output: differ.lines.join('\n'), exitCode: differ.status };
}
