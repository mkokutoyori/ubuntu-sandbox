import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { formatLocalTime } from '../system/SystemInfo';
import { InputQueue, Streams, docsResult, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'pages', letter: 'P', takesArgument: true },
  { name: 'columns', letter: 'C', takesArgument: true },
  { name: 'across', letter: 'a', takesArgument: false },
  { name: 'show-control-chars', letter: 'c', takesArgument: false },
  { name: 'double-space', letter: 'd', takesArgument: false },
  { name: 'date-format', letter: 'D', takesArgument: true },
  { name: 'expand-tabs', letter: 'e', takesArgument: false, optionalArgument: true },
  { name: 'form-feed', letter: 'f', takesArgument: false },
  { name: 'header', letter: 'h', takesArgument: true },
  { name: 'output-tabs', letter: 'i', takesArgument: false, optionalArgument: true },
  { name: 'join-lines', letter: 'J', takesArgument: false },
  { name: 'length', letter: 'l', takesArgument: true },
  { name: 'merge', letter: 'm', takesArgument: false },
  { name: 'number-lines', letter: 'n', takesArgument: false, optionalArgument: true },
  { name: 'first-line-number', letter: 'N', takesArgument: true },
  { name: 'indent', letter: 'o', takesArgument: true },
  { name: 'no-file-warnings', letter: 'r', takesArgument: false },
  { name: 'separator', letter: 's', takesArgument: false, optionalArgument: true },
  { name: 'sep-string', letter: 'S', takesArgument: false, optionalArgument: true },
  { name: 'omit-header', letter: 't', takesArgument: false },
  { name: 'omit-pagination', letter: 'T', takesArgument: false },
  { name: 'show-nonprinting', letter: 'v', takesArgument: false },
  { name: 'width', letter: 'w', takesArgument: true },
  { name: 'page-width', letter: 'W', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const OPTSTRING = '0123456789D:FJN:S::TW:abcde::fh:i::l:mn::o:rs::tvw:';
const DEFAULT_PAGE_LENGTH = 66;
const DEFAULT_PAGE_WIDTH = 72;
const HEADER_LINES = 5;
const TRAILER_LINES = 5;
const DEFAULT_DATE_FORMAT = '%Y-%m-%d %H:%M';
const TAB_WIDTH = 8;
const INT_MAX = 2147483647;
const NUMBER_WIDTH = 5;

export interface PrHost {
  readonly nowMs: number;
  readonly timezone: string | undefined;
  fileMtimeMs(name: string): number | null;
}

export interface PageHeader {
  readonly dateText: string;
  readonly title: string;
  readonly width: number;
}

export function pageHeaderLine(header: PageHeader, page: number): string {
  const pageText = `Page ${page}`;
  const available = Math.max(2, header.width - header.dateText.length - header.title.length - pageText.length);
  const left = Math.floor(available / 2);
  return `${header.dateText}${' '.repeat(left)}${header.title}${' '.repeat(available - left)}${pageText}`;
}

export function paginateLines(body: readonly string[], header: PageHeader, pageLength = DEFAULT_PAGE_LENGTH): string[] {
  const bodyLines = pageLength - HEADER_LINES - TRAILER_LINES;
  const out: string[] = [];
  for (let at = 0, page = 1; at < body.length; at += bodyLines, page++) {
    out.push('', '', pageHeaderLine(header, page), '', '');
    const slice = body.slice(at, at + bodyLines);
    out.push(...slice);
    for (let pad = slice.length; pad < bodyLines; pad++) out.push('');
    for (let trailer = 0; trailer < TRAILER_LINES; trailer++) out.push('');
  }
  return out;
}

interface PrOptions {
  firstPage: number;
  lastPage: number;
  columns: number;
  across: boolean;
  controlChars: boolean;
  nonPrinting: boolean;
  doubleSpace: boolean;
  dateFormat: string;
  expandChar: string | null;
  expandWidth: number;
  formFeed: boolean;
  header: string | null;
  outputTabChar: string;
  outputTabWidth: number;
  joinLines: boolean;
  pageLength: number;
  merge: boolean;
  numbered: boolean;
  numberSeparator: string;
  numberWidth: number;
  firstNumber: number;
  indent: number;
  quiet: boolean;
  separatorChar: string | null;
  separatorString: string | null;
  omitHeader: boolean;
  omitPagination: boolean;
  width: number | null;
  pageWidth: number | null;
}

class Failure extends Error {
  constructor(readonly lines: readonly string[], readonly withTry: boolean) {
    super(lines.join('\n'));
  }
}

function integer(text: string, minimum: number, label: string): number {
  if (!/^[+-]?\d+$/.test(text.trim())) throw new Failure([`pr: ${label}: '${text}'`], false);
  const value = Number(text);
  if (value < minimum || value > INT_MAX) throw new Failure([`pr: ${label}: '${text}': Numerical result out of range`], false);
  return value;
}

function characterAndWidth(option: string, text: string): { character: string | null; width: number | null } {
  let character: string | null = null;
  let rest = text;
  if (rest !== '' && !/^\d/.test(rest)) {
    character = rest[0];
    rest = rest.slice(1);
  }
  if (rest === '') return { character, width: null };
  if (!/^\d+$/.test(rest) || Number(rest) < 1 || Number(rest) > INT_MAX) {
    throw new Failure([`pr: '-${option}' extra characters or invalid number in the argument: '${/^\d/.test(text) ? text : rest}'`], true);
  }
  return { character, width: Number(rest) };
}

function defaults(): PrOptions {
  return {
    firstPage: 1, lastPage: Infinity, columns: 1, across: false, controlChars: false, nonPrinting: false, doubleSpace: false,
    dateFormat: DEFAULT_DATE_FORMAT, expandChar: null, expandWidth: TAB_WIDTH, formFeed: false, header: null,
    outputTabChar: '\t', outputTabWidth: TAB_WIDTH, joinLines: false, pageLength: DEFAULT_PAGE_LENGTH, merge: false,
    numbered: false, numberSeparator: '\t', numberWidth: NUMBER_WIDTH, firstNumber: 1, indent: 0, quiet: false,
    separatorChar: null, separatorString: null, omitHeader: false, omitPagination: false, width: null, pageWidth: null,
  };
}

function pageRange(spec: string): { first: number; last: number } | 'malformed' | 'empty' {
  const match = /^(\d+)(?::(\d+))?$/.exec(spec);
  if (match === null) return 'malformed';
  const first = Number(match[1]);
  const last = match[2] === undefined ? Infinity : Number(match[2]);
  return first < 1 || last < first ? 'empty' : { first, last };
}

function applyPages(range: { first: number; last: number }, options: PrOptions): void {
  options.firstPage = range.first;
  options.lastPage = range.last;
}

function parse(args: readonly string[]): { options: PrOptions; operands: string[] } | CoreutilsRun {
  const options = defaults();
  const operands: string[] = [];
  let digits = '';
  let previousWasDigit = false;
  try {
    for (const item of shortOptions(args, OPTSTRING, LONG_OPTIONS)) {
      if (item.kind === 'operand') {
        previousWasDigit = false;
        if (!item.value.startsWith('+')) { operands.push(item.value); continue; }
        const range = pageRange(item.value.slice(1));
        if (range === 'empty') operands.push(item.value);
        else if (range === 'malformed') throw new Failure([`pr: invalid + argument '${item.value.slice(1)}'`], false);
        else applyPages(range, options);
        continue;
      }
      if (item.kind !== 'option') return usageFailure('pr', getoptDiagnostic('pr', item));
      const value = item.argument;
      if (/^\d$/.test(item.letter)) {
        digits = previousWasDigit ? digits + item.letter : item.letter;
        previousWasDigit = true;
        options.columns = integer(digits, 1, 'invalid number of columns');
        continue;
      }
      previousWasDigit = false;
      switch (item.letter) {
        case 'H': return docsResult('pr', 'help');
        case 'V': return docsResult('pr', 'version');
        case 'P': {
          const range = pageRange(value ?? '');
          if (typeof range === 'string') throw new Failure([`pr: invalid --pages argument '${value ?? ''}'`], false);
          applyPages(range, options);
          break;
        }
        case 'C': options.columns = integer(value ?? '', 1, 'invalid number of columns'); break;
        case 'a': options.across = true; break;
        case 'c': options.controlChars = true; break;
        case 'd': options.doubleSpace = true; break;
        case 'D': options.dateFormat = value ?? ''; break;
        case 'e': {
          const parsed = characterAndWidth('e', value ?? '');
          options.expandChar = parsed.character ?? '\t';
          if (parsed.width !== null) options.expandWidth = parsed.width;
          break;
        }
        case 'i': {
          const parsed = characterAndWidth('i', value ?? '');
          options.outputTabChar = parsed.character ?? '\t';
          if (parsed.width !== null) options.outputTabWidth = parsed.width;
          break;
        }
        case 'f': case 'F': options.formFeed = true; break;
        case 'h': options.header = value ?? ''; break;
        case 'J': options.joinLines = true; break;
        case 'l': options.pageLength = integer(value ?? '', 1, "'-l PAGE_LENGTH' invalid number of lines"); break;
        case 'm': options.merge = true; break;
        case 'n': {
          options.numbered = true;
          const parsed = characterAndWidth('n', value ?? '');
          if (parsed.character !== null) options.numberSeparator = parsed.character;
          if (parsed.width !== null) options.numberWidth = parsed.width;
          break;
        }
        case 'N': options.firstNumber = integer(value ?? '', -INT_MAX, "'-N NUMBER' invalid starting line number"); break;
        case 'o': options.indent = integer(value ?? '', 0, "'-o MARGIN' invalid line offset"); break;
        case 'r': options.quiet = true; break;
        case 's': options.separatorChar = value ?? '\t'; options.separatorString = null; break;
        case 'S': options.separatorString = value ?? ' '; options.separatorChar = null; break;
        case 't': options.omitHeader = true; break;
        case 'T': options.omitPagination = true; options.omitHeader = true; break;
        case 'v': options.nonPrinting = true; break;
        case 'w': options.width = integer(value ?? '', 1, "'-w PAGE_WIDTH' invalid number of characters"); break;
        case 'W': options.pageWidth = integer(value ?? '', 1, "'-W PAGE_WIDTH' invalid number of characters"); break;
        default: break;
      }
    }
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    const streams = new Streams();
    for (const line of error.lines) streams.diagnostic(line);
    if (error.withTry) streams.diagnostic("Try 'pr --help' for more information.");
    streams.exitCode = 1;
    return streams.result();
  }
  return { options, operands };
}

function escapeText(text: string, options: PrOptions): string {
  if (!options.controlChars && !options.nonPrinting) return text;
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  for (const byte of bytes) {
    if (byte === 9 || byte >= 32 && byte < 127) { out += String.fromCharCode(byte); continue; }
    if (options.controlChars && byte < 32) out += `^${String.fromCharCode(byte + 64)}`;
    else if (options.controlChars && byte === 127) out += '^?';
    else out += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return out;
}

function expandInputTabs(text: string, options: PrOptions): string {
  if (options.expandChar === null) return text;
  let out = '';
  for (const ch of text) {
    if (ch === options.expandChar) out += ' '.repeat(options.expandWidth - (out.length % options.expandWidth));
    else out += ch;
  }
  return out;
}

function prepare(line: string, options: PrOptions): string {
  return escapeText(expandInputTabs(line, options), options);
}

function glyphWidth(ch: string, at: number): number {
  if (ch === '\t') return TAB_WIDTH - (at % TAB_WIDTH);
  const code = ch.codePointAt(0) ?? 0;
  return code < 32 || code === 127 ? 0 : 1;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += glyphWidth(ch, width);
  return width;
}

function truncate(text: string, limit: number): string {
  let width = 0;
  let out = '';
  for (const ch of text) {
    const next = width + glyphWidth(ch, width);
    if (next > limit) break;
    out += ch;
    width = next;
  }
  return out;
}

class RowWriter {
  private out = '';
  private position = 0;
  private pending = 0;

  constructor(private readonly tabChar: string, private readonly tabWidth: number) {}

  space(count: number): void {
    this.pending += Math.max(0, count);
  }

  padTo(column: number): void {
    this.space(column - (this.position + this.pending));
  }

  settle(): void {
    let remaining = this.pending;
    let at = this.position;
    while (remaining > 0) {
      const stop = at + (this.tabWidth - (at % this.tabWidth));
      if (remaining > 1 && stop - at <= remaining) {
        this.out += this.tabChar;
        remaining -= stop - at;
        at = stop;
      } else {
        this.out += ' ';
        at++;
        remaining--;
      }
    }
    this.position = at;
    this.pending = 0;
  }

  text(value: string): void {
    this.settle();
    this.out += value;
    this.position += displayWidth(value);
  }

  raw(value: string): void {
    this.out += value;
  }

  literal(value: string, width: number): void {
    this.settle();
    this.out += value;
    this.position += width;
  }

  result(): string {
    return this.out;
  }
}

interface Cell {
  readonly text: string | null;
  readonly number: number | null;
}

interface Layout {
  readonly columnWidth: number | null;
  readonly separator: string;
  readonly padded: boolean;
}

function numberPrefixWidth(options: PrOptions): number {
  return options.numberSeparator === '\t' ? (Math.floor(options.numberWidth / TAB_WIDTH) + 1) * TAB_WIDTH : options.numberWidth + 1;
}

function layoutFor(options: PrOptions, columns: number): Layout | string {
  const join = options.joinLines;
  const separator = options.separatorChar ?? options.separatorString ?? (join ? '\t' : ' ');
  const padded = options.separatorChar === null && !join;
  const multi = columns > 1;
  const width = options.pageWidth ?? options.width ?? DEFAULT_PAGE_WIDTH;
  if (!multi) {
    return { columnWidth: options.pageWidth !== null && !join ? options.pageWidth : null, separator, padded };
  }
  const reserved = options.merge && options.numbered ? numberPrefixWidth(options) : 0;
  const each = Math.floor((width - reserved - separator.length * (columns - 1)) / columns);
  if (each < 1 && !join) return 'pr: page width too narrow';
  return { columnWidth: join ? null : each, separator, padded };
}

function writeColumnText(writer: RowWriter, text: string): void {
  const parts = text.split(/( +)/);
  for (const part of parts) {
    if (part === '') continue;
    if (/^ +$/.test(part)) writer.space(part.length);
    else writer.text(part);
  }
}

function renderRow(cells: readonly Cell[], options: PrOptions, layout: Layout): string {
  const writer = new RowWriter(options.outputTabChar, options.outputTabWidth);
  const multi = cells.length > 1;
  const columnWidth = layout.columnWidth;
  const stride = columnWidth === null ? 0 : columnWidth + layout.separator.length;
  const prefix = numberPrefixWidth(options);
  const origin = options.indent + (options.merge && options.numbered ? prefix : 0);
  if (options.indent > 0) {
    if (multi) { writer.space(options.indent); writer.settle(); } else writer.raw(' '.repeat(options.indent));
  }
  cells.forEach((cell, index) => {
    if (cell.text === null && !options.merge && index > 0) return;
    if (index > 0) {
      if (layout.padded && columnWidth !== null) writer.padTo(origin + index * stride - layout.separator.length);
      if (/^ +$/.test(layout.separator)) writer.space(layout.separator.length);
      else writer.literal(layout.separator, layout.separator.length);
      if (layout.padded && columnWidth !== null) writer.padTo(origin + index * stride);
    }
    let limit = columnWidth;
    const numbered = options.numbered && cell.number !== null && (options.merge ? index === 0 : cell.text !== null);
    if (numbered) {
      const digits = String(cell.number).slice(-options.numberWidth);
      if (!multi && !options.merge) {
        writer.literal(`${digits.padStart(options.numberWidth, ' ')}${options.numberSeparator}`, prefix);
      } else {
        writer.settle();
        writer.space(options.numberWidth - digits.length);
        writer.text(digits);
        if (options.numberSeparator === '\t') writer.space(prefix - options.numberWidth);
        else writer.text(options.numberSeparator);
        writer.settle();
      }
      if (limit !== null && !options.merge) limit = Math.max(1, limit - prefix);
    }
    if (cell.text === null) return;
    const shown = limit === null ? cell.text : truncate(cell.text, Math.max(0, limit));
    if (shown === '') return;
    if (multi) writeColumnText(writer, shown);
    else writer.text(shown);
  });
  if (options.merge && layout.padded) writer.settle();
  return writer.result();
}

interface Source {
  readonly name: string;
  readonly lines: string[];
  readonly mtimeMs: number | null;
}

function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function rowsOfPage(chunk: readonly Cell[], columns: number, bodyRows: number, across: boolean): Cell[][] {
  const blank: Cell = { text: null, number: null };
  if (across) {
    const rows: Cell[][] = [];
    for (let at = 0; at < chunk.length; at += columns) {
      const row = chunk.slice(at, at + columns);
      while (row.length < columns) row.push(blank);
      rows.push(row);
    }
    return rows;
  }
  const full = chunk.length >= columns * bodyRows;
  const base = Math.floor(chunk.length / columns);
  const extra = chunk.length % columns;
  const sizes = Array.from({ length: columns }, (_, c) => (full ? bodyRows : base + (c < extra ? 1 : 0)));
  const starts = sizes.map((_, c) => sizes.slice(0, c).reduce((total, size) => total + size, 0));
  const rows: Cell[][] = [];
  for (let r = 0; r < Math.max(...sizes); r++) {
    rows.push(sizes.map((size, c) => (r < size ? chunk[starts[c] + r] : blank)));
  }
  return rows;
}

function mergedPages(sources: readonly Source[], options: PrOptions, bodyRows: number): Cell[][][] {
  const longest = Math.max(0, ...sources.map((source) => source.lines.length));
  const pages: Cell[][][] = [];
  for (let at = 0; at < longest; at += bodyRows) {
    const rows: Cell[][] = [];
    for (let r = at; r < Math.min(longest, at + bodyRows); r++) {
      rows.push(sources.map((source, index) => ({
        text: r < source.lines.length ? prepare(source.lines[r], options) : null,
        number: index === 0 ? options.firstNumber + r : null,
      })));
    }
    pages.push(rows);
  }
  return pages;
}

function singlePages(source: Source, options: PrOptions, bodyRows: number): Cell[][][] {
  const cells: Cell[] = source.lines.map((line, index) => ({ text: prepare(line, options), number: options.firstNumber + index }));
  const perPage = options.columns * bodyRows;
  const pages: Cell[][][] = [];
  for (let at = 0; at < cells.length; at += perPage) {
    pages.push(rowsOfPage(cells.slice(at, at + perPage), options.columns, bodyRows, options.across));
  }
  return pages;
}

function emitPages(
  pages: readonly Cell[][][], options: PrOptions, layout: Layout, header: PageHeader | null, out: string[], notes: string[],
): void {
  const total = pages.length;
  if (options.firstPage > total && total > 0) {
    notes.push(`pr: starting page number ${options.firstPage} exceeds page count ${total}`);
    return;
  }
  pages.forEach((rows, pageIndex) => {
    const pageNumber = pageIndex + 1;
    if (pageNumber < options.firstPage || pageNumber > options.lastPage) return;
    if (header !== null) out.push('', '', pageHeaderLine(header, pageNumber), '', '');
    let written = 0;
    rows.forEach((row, rowIndex) => {
      out.push(renderRow(row, options, layout));
      written++;
      const lastOfColumns = options.columns > 1 && header === null && rowIndex === rows.length - 1;
      if (options.doubleSpace && !lastOfColumns) { out.push(''); written++; }
    });
    if (header === null) return;
    if (options.formFeed) {
      out.push('\f');
      return;
    }
    const bodyLines = options.doubleSpace ? Math.max(1, Math.floor((options.pageLength - HEADER_LINES - TRAILER_LINES) / 2)) * 2 : options.pageLength - HEADER_LINES - TRAILER_LINES;
    for (let pad = written; pad < bodyLines; pad++) out.push('');
    for (let trailer = 0; trailer < TRAILER_LINES; trailer++) out.push('');
  });
}

export function runPr(args: readonly string[], io: CoreutilsIO, host: PrHost): CoreutilsRun {
  const parsed = parse(args);
  if (!('options' in parsed)) return parsed;
  const { options } = parsed;
  const streams = new Streams();
  const fail = (message: string): CoreutilsRun => {
    streams.diagnostic(message);
    streams.exitCode = 1;
    return streams.result();
  };
  if (options.merge && options.across) return fail('pr: cannot specify both printing across and printing in parallel');
  const names = parsed.operands.length === 0 ? ['-'] : parsed.operands;
  if (options.merge && options.columns > 1) return fail('pr: cannot specify number of columns when printing in parallel');
  const queue = new InputQueue(io);
  const standardInputCount = names.filter((name) => name === '-').length;
  let standardInputSlot = 0;
  const load = (name: string): Source | null => {
    if (options.merge && name === '-' && standardInputCount > 1) {
      const slot = standardInputSlot++;
      return { name, lines: splitLines(io.stdin ?? '').filter((_, index) => index % standardInputCount === slot), mtimeMs: null };
    }
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      if (!options.quiet) streams.diagnostic(`pr: ${quotef(name)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      return null;
    }
    return { name, lines: splitLines(read.text), mtimeMs: name === '-' ? null : host.fileMtimeMs(name) };
  };
  const extremities = !options.omitHeader && !options.omitPagination && options.pageLength > HEADER_LINES + TRAILER_LINES;
  const rowsPerPage = options.omitPagination
    ? Number.MAX_SAFE_INTEGER
    : extremities ? options.pageLength - HEADER_LINES - TRAILER_LINES : options.pageLength;
  const bodyRows = options.doubleSpace && rowsPerPage !== Number.MAX_SAFE_INTEGER ? Math.max(1, Math.floor(rowsPerPage / 2)) : rowsPerPage;
  const dateOf = (ms: number | null): string => formatLocalTime(options.dateFormat, ms ?? host.nowMs, host.timezone);
  const headerWidth = options.pageWidth ?? options.width ?? DEFAULT_PAGE_WIDTH;
  const flush = (out: string[], notes: string[]): void => {
    for (const note of notes) streams.diagnostic(note);
    streams.stdout(out.map((line) => (line === '\f' ? line : `${line}\n`)).join(''));
  };
  if (options.merge) {
    const sources = names.map(load).filter((source): source is Source => source !== null);
    const layout = layoutFor(options, sources.length);
    if (typeof layout === 'string') return fail(layout);
    const header = extremities ? { dateText: dateOf(null), title: options.header ?? '', width: headerWidth } : null;
    const out: string[] = [];
    const notes: string[] = [];
    if (sources.length > 0) emitPages(mergedPages(sources, options, bodyRows), options, layout, header, out, notes);
    flush(out, notes);
    return streams.result();
  }
  const layout = layoutFor(options, options.columns);
  if (typeof layout === 'string') return fail(layout);
  for (const name of names) {
    const source = load(name);
    if (source === null) continue;
    const header = extremities
      ? { dateText: dateOf(source.mtimeMs), title: options.header ?? (source.name === '-' ? '' : source.name), width: headerWidth }
      : null;
    const out: string[] = [];
    const notes: string[] = [];
    emitPages(singlePages(source, options, bodyRows), options, layout, header, out, notes);
    flush(out, notes);
  }
  return streams.result();
}
