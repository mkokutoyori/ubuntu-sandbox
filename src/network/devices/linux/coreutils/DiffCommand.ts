import { shortOptions, getoptDiagnostic, type LongOption } from '../commands/Getopt';
import { paginateLines } from './PrCommand';
import { defaultFormats, ifdefFormats, renderEd, renderGroupFormat, renderSideBySide, withMarker, type DiffLine, type DiffOp, type GroupFormats } from './DiffFormats';
import { docsResult, quoteLocale } from './CoreutilsKit';

export interface DiffEntryStat {
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly mtimeMs: number;
}

export interface DiffFs {
  readFile(path: string): string | null;
  normalizePath(path: string, cwd: string): string;
  stat(path: string): DiffEntryStat | null;
  lstat(path: string): DiffEntryStat | null;
  linkTarget(path: string): string | null;
  now(): number;
  list(path: string): string[] | null;
  formatTime(ms: number): string;
}

export interface DiffResult {
  output: string;
  exitCode: number;
}

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'normal', letter: '', takesArgument: false },
  { name: 'brief', letter: 'q', takesArgument: false },
  { name: 'report-identical-files', letter: 's', takesArgument: false },
  { name: 'context', letter: 'c', takesArgument: false, optionalArgument: true },
  { name: 'unified', letter: 'u', takesArgument: false, optionalArgument: true },
  { name: 'ed', letter: 'e', takesArgument: false },
  { name: 'rcs', letter: 'n', takesArgument: false },
  { name: 'side-by-side', letter: 'y', takesArgument: false },
  { name: 'width', letter: 'W', takesArgument: true },
  { name: 'left-column', letter: '', takesArgument: false },
  { name: 'suppress-common-lines', letter: '', takesArgument: false },
  { name: 'show-c-function', letter: 'p', takesArgument: false },
  { name: 'show-function-line', letter: 'F', takesArgument: true },
  { name: 'label', letter: 'L', takesArgument: true },
  { name: 'expand-tabs', letter: 't', takesArgument: false },
  { name: 'initial-tab', letter: 'T', takesArgument: false },
  { name: 'tabsize', letter: '', takesArgument: true },
  { name: 'suppress-blank-empty', letter: '', takesArgument: false },
  { name: 'paginate', letter: 'l', takesArgument: false },
  { name: 'recursive', letter: 'r', takesArgument: false },
  { name: 'no-dereference', letter: '', takesArgument: false },
  { name: 'new-file', letter: 'N', takesArgument: false },
  { name: 'unidirectional-new-file', letter: '', takesArgument: false },
  { name: 'ignore-file-name-case', letter: '', takesArgument: false },
  { name: 'no-ignore-file-name-case', letter: '', takesArgument: false },
  { name: 'exclude', letter: 'x', takesArgument: true },
  { name: 'exclude-from', letter: 'X', takesArgument: true },
  { name: 'starting-file', letter: 'S', takesArgument: true },
  { name: 'from-file', letter: '', takesArgument: true },
  { name: 'to-file', letter: '', takesArgument: true },
  { name: 'ignore-case', letter: 'i', takesArgument: false },
  { name: 'ignore-tab-expansion', letter: 'E', takesArgument: false },
  { name: 'ignore-trailing-space', letter: 'Z', takesArgument: false },
  { name: 'ignore-space-change', letter: 'b', takesArgument: false },
  { name: 'ignore-all-space', letter: 'w', takesArgument: false },
  { name: 'ignore-blank-lines', letter: 'B', takesArgument: false },
  { name: 'ignore-matching-lines', letter: 'I', takesArgument: true },
  { name: 'text', letter: 'a', takesArgument: false },
  { name: 'strip-trailing-cr', letter: '', takesArgument: false },
  { name: 'ifdef', letter: 'D', takesArgument: true },
  { name: 'line-format', letter: '', takesArgument: true },
  { name: 'old-line-format', letter: '', takesArgument: true },
  { name: 'new-line-format', letter: '', takesArgument: true },
  { name: 'unchanged-line-format', letter: '', takesArgument: true },
  { name: 'old-group-format', letter: '', takesArgument: true },
  { name: 'new-group-format', letter: '', takesArgument: true },
  { name: 'unchanged-group-format', letter: '', takesArgument: true },
  { name: 'changed-group-format', letter: '', takesArgument: true },
  { name: 'minimal', letter: 'd', takesArgument: false },
  { name: 'horizon-lines', letter: '', takesArgument: true },
  { name: 'speed-large-files', letter: '', takesArgument: false },
  { name: 'color', letter: '', takesArgument: false, optionalArgument: true },
  { name: 'palette', letter: '', takesArgument: true },
  { name: 'help', letter: '', takesArgument: false },
  { name: 'version', letter: 'v', takesArgument: false },
];

const OPTSTRING = 'abBcC:dD:eEfF:hiI:lL:nNpqrsS:tTuU:vwW:x:X:yZ0123456789';

type Format = 'normal' | 'unified' | 'context' | 'ed' | 'rcs' | 'side' | 'groups';

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
  text: boolean;
  stripCr: boolean;
  initialTab: boolean;
  showFunction: RegExp | null;
  width: number;
  leftColumn: boolean;
  suppressCommon: boolean;
  expandTabs: boolean;
  tabSize: number;
  noDereference: boolean;
  fromFile: string | null;
  toFile: string | null;
  formats: GroupFormats;
  paginate: boolean;
}

type Op = DiffOp;

function splitLines(content: string, stripCr: boolean): DiffLine[] {
  if (content === '') return [];
  const raw = content.split('\n');
  const endsWithNewline = raw[raw.length - 1] === '';
  if (endsWithNewline) raw.pop();
  return raw.map((text, index) => ({
    text: stripCr ? text.replace(/\r$/, '') : text,
    noEol: !endsWithNewline && index === raw.length - 1,
  }));
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

function editScript(a: DiffLine[], b: DiffLine[], options: DiffOptions): Op[] {
  const keyOf = (line: DiffLine): string => `${comparisonKey(line.text, options)}${line.noEol ? '\u0000noeol' : ''}`;
  const keysA = a.map(keyOf);
  const keysB = b.map(keyOf);
  const table = lcsTable(keysA, keysB);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && keysA[i] === keysB[j]) {
      ops.push({ kind: ' ', text: a[i].text, noEol: a[i].noEol, aLine: i + 1, bLine: j + 1 });
      i++; j++;
    } else if (i < a.length && (j >= b.length || table[i + 1][j] >= table[i][j + 1])) {
      ops.push({ kind: '-', text: a[i].text, noEol: a[i].noEol, aLine: i + 1, bLine: j + 1 });
      i++;
    } else {
      ops.push({ kind: '+', text: b[j].text, noEol: b[j].noEol, aLine: i + 1, bLine: j + 1 });
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

function renderNormal(ops: Op[], tab: boolean): string[] {
  const out: string[] = [];
  for (const region of changeRegions(ops)) {
    const removed = ops.slice(region.start, region.end).filter((op) => op.kind === '-');
    const added = ops.slice(region.start, region.end).filter((op) => op.kind === '+');
    const aStart = ops[region.start].aLine - 1;
    const bStart = ops[region.start].bLine - 1;
    const op = removed.length === 0 ? 'a' : added.length === 0 ? 'd' : 'c';
    out.push(`${normalRange(aStart, removed.length)}${op}${normalRange(bStart, added.length)}`);
    for (const line of removed) out.push(...withMarker(`<${tab ? '\t' : ' '}`, line));
    if (removed.length > 0 && added.length > 0) out.push('---');
    for (const line of added) out.push(...withMarker(`>${tab ? '\t' : ' '}`, line));
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

function functionHeader(ops: Op[], group: Region, lines: DiffLine[], pattern: RegExp | null): string {
  if (pattern === null) return '';
  const first = ops[group.start];
  for (let index = first.aLine - 2; index >= 0; index--) {
    if (pattern.test(lines[index].text)) return ` ${lines[index].text.replace(/\s+$/, '').slice(0, 40)}`;
  }
  return '';
}

function renderUnified(ops: Op[], context: number, headers: [string, string], options: DiffOptions, lines: DiffLine[]): string[] {
  const out = [`--- ${headers[0]}`, `+++ ${headers[1]}`];
  for (const group of hunkGroups(ops, context)) {
    const slice = ops.slice(group.start, group.end);
    const a = sideSpan(slice, 'a');
    const b = sideSpan(slice, 'b');
    out.push(`@@ -${unifiedRange(a.first, a.count)} +${unifiedRange(b.first, b.count)} @@${functionHeader(ops, group, lines, options.showFunction)}`);
    for (const op of slice) {
      if (options.initialTab) out.push(...withMarker(op.kind === ' ' ? '\t' : `${op.kind}\t`, op));
      else out.push(...withMarker(op.kind, op));
    }
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

function renderContext(ops: Op[], context: number, headers: [string, string], options: DiffOptions, lines: DiffLine[]): string[] {
  const out = [`*** ${headers[0]}`, `--- ${headers[1]}`];
  const markers = changeMarkers(ops);
  const second = options.initialTab ? '\t' : ' ';
  for (const group of hunkGroups(ops, context)) {
    const slice = ops.slice(group.start, group.end);
    const a = sideSpan(slice, 'a');
    const b = sideSpan(slice, 'b');
    const marked = (kind: '-' | '+'): boolean => slice.some((op) => op.kind === kind);
    out.push(`***************${functionHeader(ops, group, lines, options.showFunction)}`);
    out.push(`*** ${contextRange(a.first, a.count)} ****`);
    if (marked('-')) {
      slice.forEach((op, offset) => {
        if (op.kind !== '+') out.push(...withMarker(op.kind === ' ' ? ` ${second}` : `${markers.get(group.start + offset)}${second}`, op));
      });
    }
    out.push(`--- ${contextRange(b.first, b.count)} ----`);
    if (marked('+')) {
      slice.forEach((op, offset) => {
        if (op.kind !== '-') out.push(...withMarker(op.kind === ' ' ? ` ${second}` : `${markers.get(group.start + offset)}${second}`, op));
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
  const options: DiffOptions = {
    format: 'normal', context: 3, brief: false, reportIdentical: false, ignoreCase: false, ignoreAllSpace: false,
    ignoreSpaceChange: false, ignoreTrailingSpace: false, ignoreBlankLines: false, recursive: false, newFile: false,
    labels: [], excludes: [], optionText: '', text: false, stripCr: false, initialTab: false, showFunction: null, width: 130,
    leftColumn: false, suppressCommon: false, expandTabs: false, tabSize: 8, noDereference: false, fromFile: null, toFile: null,
    formats: defaultFormats(), paginate: false,
  };
  const operands: string[] = [];
  const typed: string[] = [];
  let previousWasDigit = false;
  let functionOption = false;
  for (const item of shortOptions(args, OPTSTRING, LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') {
      return { error: { output: `${getoptDiagnostic('diff', item)}\ndiff: Try 'diff --help' for more information.\n`, exitCode: 2 } };
    }
    const value = item.argument;
    if (item.letter === '' && item.long !== undefined) {
      const text = value ?? '';
      const formats = options.formats;
      switch (item.long) {
        case 'left-column': options.leftColumn = true; break;
        case 'suppress-common-lines': options.suppressCommon = true; break;
        case 'strip-trailing-cr': options.stripCr = true; break;
        case 'tabsize': options.tabSize = Math.max(1, Number(text) || 8); break;
        case 'no-dereference': options.noDereference = true; break;
        case 'from-file': options.fromFile = text; break;
        case 'to-file': options.toFile = text; break;
        case 'normal': options.format = 'normal'; break;
        case 'line-format': formats.oldLine = text; formats.newLine = text; formats.unchangedLine = text; options.format = 'groups'; break;
        case 'old-line-format': formats.oldLine = text; options.format = 'groups'; break;
        case 'new-line-format': formats.newLine = text; options.format = 'groups'; break;
        case 'unchanged-line-format': formats.unchangedLine = text; options.format = 'groups'; break;
        case 'old-group-format': formats.oldGroup = text; options.format = 'groups'; break;
        case 'new-group-format': formats.newGroup = text; options.format = 'groups'; break;
        case 'unchanged-group-format': formats.unchangedGroup = text; options.format = 'groups'; break;
        case 'changed-group-format': formats.changedGroup = text; options.format = 'groups'; break;
        default: break;
      }
      continue;
    }
    if (/^[0-9]$/.test(item.letter)) {
      options.context = Number(`${previousWasDigit ? options.context : ''}${item.letter}`);
      previousWasDigit = true;
      continue;
    }
    previousWasDigit = false;
    switch (item.letter) {
      case 'u': options.format = 'unified'; break;
      case 'U': options.format = 'unified'; options.context = Number(value); break;
      case 'c': options.format = 'context'; break;
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
      case 'e': options.format = 'ed'; break;
      case 'n': options.format = 'rcs'; break;
      case 'y': options.format = 'side'; break;
      case 'W': options.width = Number(value); break;
      case 'a': options.text = true; break;
      case 'T': options.initialTab = true; break;
      case 't': options.expandTabs = true; break;
      case 'l': options.paginate = true; break;
      case 'p': functionOption = true; options.showFunction ??= /^[A-Za-z_$]/; break;
      case 'F': options.showFunction = new RegExp(value ?? ''); break;
      case 'D': options.format = 'groups'; options.formats = ifdefFormats(value ?? ''); break;
      default: break;
    }
  }
  for (const arg of args) if (arg.startsWith('-') && arg !== '-') typed.push(arg);
  options.optionText = typed.filter((arg) => !/^-[LxXSIDFWU]$/.test(arg)).join(' ');
  if (functionOption && options.format === 'normal') options.format = 'context';
  if (!Number.isFinite(options.context) || options.context < 0) options.context = 3;
  return { options, operands };
}

class Differ {
  readonly lines: string[] = [];
  status = 0;
  unterminated = false;

  constructor(private readonly fs: DiffFs, private readonly cwd: string, private readonly options: DiffOptions) {}

  private trouble(message: string): void {
    this.lines.push(message);
    this.status = 2;
  }

  text(): string {
    return this.lines.length === 0 ? '' : this.lines.join('\n') + (this.unterminated ? '' : '\n');
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
    const { options } = this;
    const rawA = contentA ?? '';
    const rawB = contentB ?? '';
    const binary = !options.text && (rawA.includes('\0') || rawB.includes('\0'));
    const a = splitLines(rawA, options.stripCr);
    const b = splitLines(rawB, options.stripCr);
    const ops = editScript(a, b, options);
    const regions = changeRegions(ops);
    const identical = binary ? rawA === rawB : regions.length === 0;
    if (identical) {
      if (options.reportIdentical) this.lines.push(`Files ${pathA} and ${pathB} are identical`);
      return;
    }
    this.mark();
    if (options.brief) { this.lines.push(`Files ${pathA} and ${pathB} differ`); return; }
    if (binary) { this.lines.push(`Binary files ${pathA} and ${pathB} differ`); return; }
    const body: string[] = [];
    if (announce) body.push(`diff ${options.optionText ? `${options.optionText} ` : ''}${pathA} ${pathB}`.replace(/ +/g, ' '));
    const statA = this.fs.stat(this.fs.normalizePath(pathA, this.cwd));
    const statB = this.fs.stat(this.fs.normalizePath(pathB, this.cwd));
    const headers: [string, string] = [
      this.header(pathA, contentA === null ? null : statA?.mtimeMs ?? null, 0),
      this.header(pathB, contentB === null ? null : statB?.mtimeMs ?? null, 1),
    ];
    switch (options.format) {
      case 'unified': body.push(...renderUnified(ops, options.context, headers, options, a)); break;
      case 'context': body.push(...renderContext(ops, options.context, headers, options, a)); break;
      case 'ed': body.push(...renderEd(ops, regions, false)); break;
      case 'rcs': body.push(...renderEd(ops, regions, true)); break;
      case 'side': body.push(...renderSideBySide(ops, {
        width: options.width, leftColumn: options.leftColumn, suppressCommon: options.suppressCommon,
        expandTabs: options.expandTabs, tabSize: options.tabSize,
      })); break;
      case 'groups': {
        const text = renderGroupFormat(ops, options.formats);
        if (text !== '') {
          body.push(text.endsWith('\n') ? text.slice(0, -1) : text);
          this.unterminated = !text.endsWith('\n');
        }
        break;
      }
      default: body.push(...renderNormal(ops, options.initialTab));
    }
    this.lines.push(...(options.paginate ? this.paginate(body, `diff ${options.optionText ? `${options.optionText} ` : ''}${pathA} ${pathB}`.replace(/ +/g, ' ')) : body));
  }

  private paginate(body: string[], title: string): string[] {
    const dateText = new Date(this.fs.now()).toISOString().slice(0, 16).replace('T', ' ');
    return paginateLines(body, { dateText, title, width: 72 });
  }

  compare(pathA: string, pathB: string, announce: boolean): void {
    const absA = this.fs.normalizePath(pathA, this.cwd);
    const absB = this.fs.normalizePath(pathB, this.cwd);
    if (absA === absB) {
      if (this.options.reportIdentical) this.lines.push(`Files ${pathA} and ${pathB} are identical`);
      return;
    }
    if (this.options.noDereference) {
      const linkA = this.fs.lstat(absA);
      const linkB = this.fs.lstat(absB);
      const describe = (type: string | undefined): string => (type === 'symlink' ? 'a symbolic link' : type === 'directory' ? 'a directory' : 'a regular file');
      if (linkA !== null && linkB !== null && (linkA.type === 'symlink') !== (linkB.type === 'symlink')) {
        this.mark();
        this.lines.push(`File ${pathA} is ${describe(linkA.type)} while file ${pathB} is ${describe(linkB.type)}`);
        return;
      }
      if (linkA?.type === 'symlink' && linkB?.type === 'symlink') {
        if (this.fs.linkTarget(absA) !== this.fs.linkTarget(absB)) { this.mark(); this.lines.push(`Symbolic links ${pathA} and ${pathB} differ`); }
        return;
      }
    }
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
  if (args.includes('--version') || args.includes('-v')) return { output: docsResult('diff', 'version').stdout, exitCode: 0 };
  if (args.includes('--help')) return { output: docsResult('diff', 'help').stdout, exitCode: 0 };
  const parsed = parse(args);
  if ('error' in parsed) return parsed.error;
  const { options, operands } = parsed;
  const trouble = (message: string): DiffResult => ({ output: `${message}\ndiff: Try 'diff --help' for more information.\n`, exitCode: 2 });
  const anchored = options.fromFile ?? options.toFile;
  if (anchored !== null) {
    if (operands.length === 0) return trouble(`diff: missing operand after ${quoteLocale('diff')}`);
    const differ = new Differ(fs, cwd, options);
    for (const operand of operands) {
      if (options.fromFile !== null) differ.compare(options.fromFile, operand, false);
      else differ.compare(operand, options.toFile as string, false);
    }
    return { output: differ.text(), exitCode: differ.status };
  }
  if (operands.length < 2) {
    return trouble(operands.length === 0 ? `diff: missing operand after ${quoteLocale('diff')}` : `diff: missing operand after ${quoteLocale(operands[0])}`);
  }
  if (operands.length > 2) return trouble(`diff: extra operand ${quoteLocale(operands[2])}`);
  const differ = new Differ(fs, cwd, options);
  differ.compare(operands[0], operands[1], false);
  return { output: differ.text(), exitCode: differ.status };
}
