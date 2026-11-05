import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { compilePosix } from '../regex/PosixRegex';
import { Streams, docsResult, quotef, quoteLocale, readFailureText, usageFailure, InputQueue, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'auto-reference', letter: 'A', takesArgument: false },
  { name: 'break-file', letter: 'b', takesArgument: true },
  { name: 'flag-truncation', letter: 'F', takesArgument: true },
  { name: 'ignore-case', letter: 'f', takesArgument: false },
  { name: 'gap-size', letter: 'g', takesArgument: true },
  { name: 'ignore-file', letter: 'i', takesArgument: true },
  { name: 'macro-name', letter: 'M', takesArgument: true },
  { name: 'only-file', letter: 'o', takesArgument: true },
  { name: 'references', letter: 'r', takesArgument: false },
  { name: 'right-side-refs', letter: 'R', takesArgument: false },
  { name: 'format', letter: 'U', takesArgument: true },
  { name: 'sentence-regexp', letter: 'S', takesArgument: true },
  { name: 'traditional', letter: 'G', takesArgument: false },
  { name: 'typeset-mode', letter: 't', takesArgument: false },
  { name: 'width', letter: 'w', takesArgument: true },
  { name: 'word-regexp', letter: 'W', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

type Format = 'dumb' | 'roff' | 'tex';

interface Occurrence {
  readonly key: string;
  readonly keyStart: number;
  readonly left: number;
  readonly right: number;
  readonly reference: number;
  readonly fileIndex: number;
}

interface Span { start: number; end: number }

const byteString = (text: string): string => Array.from(fileTextToBytes(text), (byte) => String.fromCharCode(byte)).join('');
const isSpace = (character: string | undefined): boolean => character !== undefined && ' \t\n\v\f\r'.includes(character);
const isAlpha = (character: string | undefined): boolean => character !== undefined && /^[A-Za-z]$/.test(character);
const fold = (text: string): string => text.toUpperCase();

class UserFailure extends Error {}

function unescapeString(source: string): string {
  let out = '';
  let at = 0;
  while (at < source.length) {
    if (source[at] !== '\\') { out += source[at++]; continue; }
    at++;
    const escape = source[at];
    switch (escape) {
      case 'x': {
        at++;
        let digits = '';
        while (digits.length < 3 && /[0-9A-Fa-f]/.test(source[at] ?? '')) digits += source[at++];
        out += digits === '' ? '\\x' : String.fromCharCode(parseInt(digits, 16) & 0xff);
        break;
      }
      case '0': {
        at++;
        let digits = '';
        while (digits.length < 3 && /[0-7]/.test(source[at] ?? '')) digits += source[at++];
        out += String.fromCharCode(digits === '' ? 0 : parseInt(digits, 8) & 0xff);
        break;
      }
      case 'a': out += '\x07'; at++; break;
      case 'b': out += '\b'; at++; break;
      case 'c': at = source.length; break;
      case 'f': out += '\f'; at++; break;
      case 'n': out += '\n'; at++; break;
      case 'r': out += '\r'; at++; break;
      case 't': out += '\t'; at++; break;
      case 'v': out += '\v'; at++; break;
      case undefined: break;
      default: out += `\\${escape}`; at++;
    }
  }
  return out;
}

function emacsToBasic(pattern: string): string {
  let out = '';
  let at = 0;
  while (at < pattern.length) {
    const character = pattern[at];
    if (character === '[') {
      let end = at + 1;
      if (pattern[end] === '^') end++;
      if (pattern[end] === ']') end++;
      while (end < pattern.length && pattern[end] !== ']') {
        if (pattern[end] === '[' && ':.='.includes(pattern[end + 1] ?? '')) {
          const close = pattern.indexOf(`${pattern[end + 1]}]`, end + 2);
          end = close === -1 ? end + 1 : close + 2;
        } else end++;
      }
      out += pattern.slice(at, end + 1);
      at = end + 1;
    } else if (character === '\\' && at + 1 < pattern.length) {
      const next = pattern[at + 1];
      out += next === '+' || next === '?' ? next : next === '{' || next === '}' ? next : `\\${next}`;
      at += 2;
    } else if (character === '+' || character === '?') {
      out += `\\${character}`;
      at++;
    } else {
      out += character;
      at++;
    }
  }
  return out;
}

function parseCount(text: string): number | null {
  const match = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.exec(text);
  if (match === null) return null;
  const digits = match[2];
  const magnitude = /^0[xX]/.test(digits) ? parseInt(digits, 16) : digits.length > 1 && digits[0] === '0' ? parseInt(digits, 8) : parseInt(digits, 10);
  return match[1] === '-' ? -magnitude : magnitude;
}

function wordTable(text: string, caseless: boolean): string[] {
  const words: string[] = [];
  for (const line of text.split('\n')) if (line !== '') words.push(line);
  const key = caseless ? fold : (word: string): string => word;
  return words.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

class PtxRun {
  gnuExtensions = true;
  autoReference = false;
  inputReference = false;
  rightReference = false;
  lineWidth = 72;
  gapSize = 3;
  truncationString: string | null = '/';
  macroName = 'xx';
  format: Format | null = null;
  ignoreCase = false;
  breakFile: string | null = null;
  ignoreFile: string | null = null;
  onlyFile: string | null = null;
  contextRegex: string | null = null;
  wordRegex: string | null = null;
  readonly out: string[] = [];

  private contextPattern: RegExp | null = null;
  private wordSearch: RegExp | null = null;
  private wordMatch: RegExp | null = null;
  private wordFastmap: boolean[] = [];
  private ignoreTable: string[] = [];
  private onlyTable: string[] = [];
  private maximumWordLength = 0;
  private referenceMaxWidth = 0;
  private totalLineCount = 0;
  private buffers: string[] = [];
  private names: (string | null)[] = [];
  private fileLineCounts: number[] = [];
  private occurrences: Occurrence[] = [];
  private editedFlag = new Set<string>();
  private halfLineWidth = 0;
  private beforeMaxWidth = 0;
  private keyafterMaxWidth = 0;
  private truncationLength = 0;

  private compile(source: string, global: boolean): RegExp {
    try {
      return compilePosix(emacsToBasic(source), { ignoreCase: this.ignoreCase, multiline: true, global, extended: false });
    } catch (error) {
      throw new UserFailure(`${(error as Error).message} (for regexp ${quoteLocale(source)})`);
    }
  }

  private sticky(source: string): RegExp {
    const base = this.compile(source, false);
    return new RegExp(base.source, `${base.flags.replace('g', '')}y`);
  }

  private skipSomething(buffer: string, cursor: number, limit: number): number {
    if (this.wordMatch !== null) {
      this.wordMatch.lastIndex = cursor;
      const found = this.wordMatch.exec(buffer.slice(0, limit));
      return cursor + (found === null ? 1 : found[0].length);
    }
    if (this.wordFastmap[buffer.charCodeAt(cursor)] === true) {
      while (cursor < limit && this.wordFastmap[buffer.charCodeAt(cursor)] === true) cursor++;
      return cursor;
    }
    return cursor + 1;
  }

  private skipWhite(buffer: string, cursor: number, limit: number): number {
    while (cursor < limit && isSpace(buffer[cursor])) cursor++;
    return cursor;
  }

  private skipWhiteBackwards(buffer: string, cursor: number, start: number): number {
    while (cursor > start && isSpace(buffer[cursor - 1])) cursor--;
    return cursor;
  }

  private skipNonWhite(buffer: string, cursor: number, limit: number): number {
    while (cursor < limit && !isSpace(buffer[cursor])) cursor++;
    return cursor;
  }

  private initialiseRegex(): void {
    if (this.contextRegex !== null) {
      if (this.contextRegex === '') this.contextRegex = null;
    } else if (this.gnuExtensions && !this.inputReference) {
      this.contextRegex = '[.?!][]"\')}]*\\($\\|\t\\|  \\)[ \t\n]*';
    } else {
      this.contextRegex = '\n';
    }
    if (this.contextRegex !== null) this.contextPattern = this.compile(this.contextRegex, true);
    if (this.wordRegex !== null) {
      this.wordSearch = this.compile(this.wordRegex, true);
      this.wordMatch = this.sticky(this.wordRegex);
    } else if (this.breakFile === null) {
      this.wordFastmap = [];
      for (let code = 0; code < 256; code++) {
        this.wordFastmap[code] = this.gnuExtensions ? isAlpha(String.fromCharCode(code)) : !(code === 32 || code === 9 || code === 10);
      }
    }
  }

  private readText(queue: InputQueue, name: string | null): string {
    const usingStdin = name === null || name === '' || name === '-';
    const read = queue.read(usingStdin ? '-' : name);
    if (read.kind !== 'ok') throw new UserFailure(`${quotef(usingStdin ? '-' : name)}: ${readFailureText(read)}`);
    return byteString(read.text);
  }

  private compareKeys(first: string, second: string): number {
    const a = this.ignoreCase ? fold(first) : first;
    const b = this.ignoreCase ? fold(second) : second;
    const length = Math.min(a.length, b.length);
    for (let at = 0; at < length; at++) {
      const difference = a.charCodeAt(at) - b.charCodeAt(at);
      if (difference !== 0) return difference;
    }
    return a.length - b.length;
  }

  private inTable(table: string[], word: string): boolean {
    return table.some((entry) => this.compareKeys(word, entry) === 0);
  }

  private findOccurrences(fileIndex: number): void {
    const buffer = this.buffers[fileIndex];
    const end = buffer.length;
    let lineStart = 0;
    let lineScan = 0;
    let referenceLength = 0;
    if (this.inputReference) {
      lineScan = this.skipNonWhite(buffer, lineScan, end);
      referenceLength = lineScan - lineStart;
      lineScan = this.skipWhite(buffer, lineScan, end);
    }
    let nextContextStart = 0;
    for (let cursor = 0; cursor < end; cursor = nextContextStart) {
      let contextStart = cursor;
      nextContextStart = end;
      if (this.contextPattern !== null) {
        this.contextPattern.lastIndex = cursor;
        const found = this.contextPattern.exec(buffer);
        if (found !== null) {
          if (found[0].length === 0 && found.index === cursor) {
            throw new UserFailure(`error: regular expression has a match of length zero: ${quoteLocale(this.contextRegex ?? '')}`);
          }
          nextContextStart = found.index + found[0].length;
        }
      }
      const contextEnd = this.skipWhiteBackwards(buffer, nextContextStart, contextStart);
      for (;;) {
        let wordStart: number;
        let wordEnd: number;
        if (this.wordSearch !== null) {
          this.wordSearch.lastIndex = cursor;
          const found = this.wordSearch.exec(buffer.slice(0, contextEnd));
          if (found === null) break;
          wordStart = found.index;
          wordEnd = found.index + found[0].length;
        } else {
          let scan = cursor;
          while (scan < contextEnd && this.wordFastmap[buffer.charCodeAt(scan)] !== true) scan++;
          if (scan === contextEnd) break;
          wordStart = scan;
          while (scan < contextEnd && this.wordFastmap[buffer.charCodeAt(scan)] === true) scan++;
          wordEnd = scan;
        }
        cursor = wordStart;
        if (wordEnd === wordStart) { cursor++; continue; }
        const key = buffer.slice(wordStart, wordEnd);
        cursor += key.length;
        if (key.length > this.maximumWordLength) this.maximumWordLength = key.length;
        if (this.inputReference) {
          while (lineScan < wordStart) {
            if (buffer[lineScan] === '\n') {
              this.totalLineCount++;
              lineScan++;
              lineStart = lineScan;
              lineScan = this.skipNonWhite(buffer, lineScan, end);
              referenceLength = lineScan - lineStart;
            } else lineScan++;
          }
          if (lineScan > wordStart) continue;
        }
        if (this.ignoreFile !== null && this.inTable(this.ignoreTable, key)) continue;
        if (this.onlyFile !== null && !this.inTable(this.onlyTable, key)) continue;
        let reference = 0;
        if (this.autoReference) {
          while (lineScan < wordStart) {
            if (buffer[lineScan] === '\n') {
              this.totalLineCount++;
              lineScan++;
              lineStart = lineScan;
              lineScan = this.skipNonWhite(buffer, lineScan, end);
            } else lineScan++;
          }
          reference = this.totalLineCount;
        } else if (this.inputReference) {
          reference = lineStart - wordStart;
          if (referenceLength > this.referenceMaxWidth) this.referenceMaxWidth = referenceLength;
        }
        if (this.inputReference && lineStart === contextStart) {
          contextStart = this.skipNonWhite(buffer, contextStart, contextEnd);
          contextStart = this.skipWhite(buffer, contextStart, contextEnd);
        }
        this.occurrences.push({ key, keyStart: wordStart, left: contextStart - wordStart, right: contextEnd - wordStart, reference, fileIndex });
      }
    }
  }

  private fixOutputParameters(): void {
    if (this.autoReference) {
      this.referenceMaxWidth = 0;
      for (let index = 0; index < this.names.length; index++) {
        let ordinal = this.fileLineCounts[index] + 1;
        if (index > 0) ordinal -= this.fileLineCounts[index - 1];
        const width = String(ordinal).length + (this.names[index] === null ? 0 : (this.names[index] as string).length);
        if (width > this.referenceMaxWidth) this.referenceMaxWidth = width;
      }
      this.referenceMaxWidth++;
    }
    if ((this.autoReference || this.inputReference) && !this.rightReference) this.lineWidth -= this.referenceMaxWidth + this.gapSize;
    if (this.lineWidth < 0) this.lineWidth = 0;
    this.halfLineWidth = Math.trunc(this.lineWidth / 2);
    this.beforeMaxWidth = this.halfLineWidth - this.gapSize;
    this.keyafterMaxWidth = this.halfLineWidth;
    if (this.truncationString !== null && this.truncationString !== '') this.truncationLength = this.truncationString.length;
    else this.truncationString = null;
    if (this.gnuExtensions) {
      this.beforeMaxWidth -= 2 * this.truncationLength;
      if (this.beforeMaxWidth < 0) this.beforeMaxWidth = 0;
      this.keyafterMaxWidth -= 2 * this.truncationLength;
    } else {
      this.keyafterMaxWidth -= 2 * this.truncationLength + 1;
    }
    this.editedFlag = new Set([' ', '\t', '\n', '\v', '\f', '\r']);
    if (this.format === 'roff') this.editedFlag.add('"');
    if (this.format === 'tex') for (const character of '$%&#_{}\\') this.editedFlag.add(character);
  }

  private printField(buffer: string, span: Span): string {
    let text = '';
    for (let at = span.start; at < span.end; at++) {
      const character = buffer[at];
      if (!this.editedFlag.has(character)) { text += character; continue; }
      switch (character) {
        case '"': text += '""'; break;
        case '$': case '%': case '&': case '#': case '_': text += `\\${character}`; break;
        case '{': case '}': text += `$\\${character}$`; break;
        case '\\': text += '\\backslash{}'; break;
        default: text += ' ';
      }
    }
    return text;
  }

  private spaces(count: number): string {
    return count > 0 ? ' '.repeat(count) : '';
  }

  private emit(occurrence: Occurrence): void {
    const buffer = this.buffers[occurrence.fileIndex];
    const truncation = this.truncationString ?? '';
    const bufferEnd = buffer.length;
    const keyafter: Span = { start: occurrence.keyStart, end: occurrence.keyStart + occurrence.key.length };
    const leftContextStart = keyafter.start + occurrence.left;
    const rightContextEnd = keyafter.start + occurrence.right;
    let cursor = keyafter.end;
    while (cursor < rightContextEnd && cursor <= keyafter.start + this.keyafterMaxWidth) {
      keyafter.end = cursor;
      cursor = this.skipSomething(buffer, cursor, rightContextEnd);
    }
    if (cursor <= keyafter.start + this.keyafterMaxWidth) keyafter.end = cursor;
    let keyafterTruncation = this.truncationString !== null && keyafter.end < rightContextEnd;
    keyafter.end = this.skipWhiteBackwards(buffer, keyafter.end, keyafter.start);

    let leftFieldStart: number;
    if (-occurrence.left > this.halfLineWidth + this.maximumWordLength) {
      leftFieldStart = this.skipSomething(buffer, keyafter.start - (this.halfLineWidth + this.maximumWordLength), keyafter.start);
    } else {
      leftFieldStart = keyafter.start + occurrence.left;
    }

    const before: Span = { start: leftFieldStart, end: this.skipWhiteBackwards(buffer, keyafter.start, leftFieldStart) };
    while (before.start + this.beforeMaxWidth < before.end) before.start = this.skipSomething(buffer, before.start, before.end);
    let beforeTruncation = false;
    if (this.truncationString !== null) {
      const probe = this.skipWhiteBackwards(buffer, before.start, 0);
      beforeTruncation = probe > leftContextStart;
    }
    before.start = this.skipWhite(buffer, before.start, bufferEnd);

    let tail: Span = { start: 0, end: 0 };
    let tailTruncation = false;
    const tailMaxWidth = this.beforeMaxWidth - (before.end - before.start) - this.gapSize;
    if (tailMaxWidth > 0) {
      tail.start = this.skipWhite(buffer, keyafter.end, bufferEnd);
      tail.end = tail.start;
      cursor = tail.end;
      while (cursor < rightContextEnd && cursor < tail.start + tailMaxWidth) {
        tail.end = cursor;
        cursor = this.skipSomething(buffer, cursor, rightContextEnd);
      }
      if (cursor < tail.start + tailMaxWidth) tail.end = cursor;
      if (tail.end > tail.start) {
        keyafterTruncation = false;
        tailTruncation = this.truncationString !== null && tail.end < rightContextEnd;
      } else tailTruncation = false;
      tail.end = this.skipWhiteBackwards(buffer, tail.end, tail.start);
    } else tail = { start: 0, end: 0 };

    let head: Span = { start: 0, end: 0 };
    let headTruncation = false;
    const headMaxWidth = this.keyafterMaxWidth - (keyafter.end - keyafter.start) - this.gapSize;
    if (headMaxWidth > 0) {
      head.end = this.skipWhiteBackwards(buffer, before.start, 0);
      head.start = leftFieldStart;
      while (head.start + headMaxWidth < head.end) head.start = this.skipSomething(buffer, head.start, head.end);
      if (head.end > head.start) {
        beforeTruncation = false;
        headTruncation = this.truncationString !== null && head.start > leftContextStart;
      } else headTruncation = false;
      head.start = this.skipWhite(buffer, head.start, head.end);
    } else head = { start: 0, end: 0 };

    let reference: Span = { start: 0, end: 0 };
    let referenceText = '';
    if (this.autoReference) {
      const name = this.names[occurrence.fileIndex] ?? '';
      let ordinal = occurrence.reference + 1;
      if (occurrence.fileIndex > 0) ordinal -= this.fileLineCounts[occurrence.fileIndex - 1];
      referenceText = `${name}:${ordinal}`;
    } else if (this.inputReference) {
      reference = { start: keyafter.start + occurrence.reference, end: keyafter.start + occurrence.reference };
      reference.end = this.skipNonWhite(buffer, reference.end, rightContextEnd);
      referenceText = this.printField(buffer, reference);
    }
    const hasReference = this.autoReference || this.inputReference;
    const field = (span: Span): string => this.printField(buffer, span);
    const referenceWidth = this.autoReference ? referenceText.length : reference.end - reference.start;
    const referenceField = this.autoReference ? referenceText : referenceText;

    if (this.format === 'roff') {
      let line = `.${this.macroName} "${field(tail)}${tailTruncation ? truncation : ''}"`;
      line += ` "${beforeTruncation ? truncation : ''}${field(before)}"`;
      line += ` "${field(keyafter)}${keyafterTruncation ? truncation : ''}"`;
      line += ` "${headTruncation ? truncation : ''}${field(head)}"`;
      if (hasReference) line += ` "${referenceField}"`;
      this.out.push(`${line}\n`);
      return;
    }
    if (this.format === 'tex') {
      let at = keyafter.start;
      at = this.skipSomething(buffer, at, keyafter.end);
      const key: Span = { start: keyafter.start, end: at };
      const after: Span = { start: at, end: keyafter.end };
      let line = `\\${this.macroName} {${field(tail)}}{${field(before)}}{${field(key)}}{${field(after)}}{${field(head)}}`;
      if (hasReference) line += `{${referenceField}}`;
      this.out.push(`${line}\n`);
      return;
    }
    let line = '';
    if (!this.rightReference) {
      if (this.autoReference) line += `${referenceField}:${this.spaces(this.referenceMaxWidth + this.gapSize - referenceWidth - 1)}`;
      else line += `${referenceField}${this.spaces(this.referenceMaxWidth + this.gapSize - referenceWidth)}`;
    }
    const beforeMark = beforeTruncation ? this.truncationLength : 0;
    if (tail.start < tail.end) {
      line += field(tail) + (tailTruncation ? truncation : '');
      line += this.spaces(this.halfLineWidth - this.gapSize - (before.end - before.start) - beforeMark - (tail.end - tail.start) - (tailTruncation ? this.truncationLength : 0));
    } else {
      line += this.spaces(this.halfLineWidth - this.gapSize - (before.end - before.start) - beforeMark);
    }
    line += (beforeTruncation ? truncation : '') + field(before) + this.spaces(this.gapSize);
    line += field(keyafter) + (keyafterTruncation ? truncation : '');
    const keyafterMark = keyafterTruncation ? this.truncationLength : 0;
    if (head.start < head.end) {
      line += this.spaces(this.halfLineWidth - (keyafter.end - keyafter.start) - keyafterMark - (head.end - head.start) - (headTruncation ? this.truncationLength : 0));
      line += (headTruncation ? truncation : '') + field(head);
    } else if (hasReference && this.rightReference) {
      line += this.spaces(this.halfLineWidth - (keyafter.end - keyafter.start) - keyafterMark);
    }
    if (hasReference && this.rightReference) line += this.spaces(this.gapSize) + referenceField;
    this.out.push(`${line}\n`);
  }

  run(files: (string | null)[], io: CoreutilsIO): string {
    const queue = new InputQueue(io);
    this.initialiseRegex();
    if (this.breakFile !== null) {
      const contents = this.readText(queue, this.breakFile);
      this.wordFastmap = Array.from({ length: 256 }, () => true);
      for (const character of contents) this.wordFastmap[character.charCodeAt(0) & 0xff] = false;
      if (!this.gnuExtensions) { this.wordFastmap[32] = false; this.wordFastmap[9] = false; this.wordFastmap[10] = false; }
    }
    if (this.ignoreFile !== null) {
      this.ignoreTable = wordTable(this.readText(queue, this.ignoreFile), this.ignoreCase);
      if (this.ignoreTable.length === 0) this.ignoreFile = null;
    }
    if (this.onlyFile !== null) {
      this.onlyTable = wordTable(this.readText(queue, this.onlyFile), this.ignoreCase);
      if (this.onlyTable.length === 0) this.onlyFile = null;
    }
    this.names = files;
    files.forEach((name, index) => {
      this.buffers[index] = this.readText(queue, name);
      this.findOccurrences(index);
      this.totalLineCount++;
      this.fileLineCounts[index] = this.totalLineCount;
    });
    this.occurrences.sort((first, second) => this.compareKeys(first.key, second.key) || first.fileIndex - second.fileIndex || first.keyStart - second.keyStart);
    this.fixOutputParameters();
    for (const occurrence of this.occurrences) this.emit(occurrence);
    return this.out.join('');
  }
}

export function runPtx(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const streams = new Streams();
  const failure = (line: string): CoreutilsRun => {
    streams.diagnostic(`ptx: ${line}`);
    streams.exitCode = 1;
    return streams.result();
  };
  const state = new PtxRun();
  const operands: string[] = [];
  for (const item of shortOptions(args, 'AF:GM:ORS:TW:b:i:fg:o:trw:', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('ptx', getoptDiagnostic('ptx', item).replace(/\nTry .*$/s, ''));
    const argument = byteString(item.argument ?? '');
    switch (item.letter) {
      case 'H': return docsResult('ptx', 'help');
      case 'V': return docsResult('ptx', 'version');
      case 'G': state.gnuExtensions = false; break;
      case 'b': state.breakFile = argument; break;
      case 'f': state.ignoreCase = true; break;
      case 'g': {
        const value = parseCount(argument);
        if (value === null || value <= 0) return failure(`invalid gap width: ${quoteLocale(argument)}`);
        state.gapSize = value;
        break;
      }
      case 'i': state.ignoreFile = argument; break;
      case 'o': state.onlyFile = argument; break;
      case 'r': state.inputReference = true; break;
      case 't': break;
      case 'w': {
        const value = parseCount(argument);
        if (value === null || value <= 0) return failure(`invalid line width: ${quoteLocale(argument)}`);
        state.lineWidth = value;
        break;
      }
      case 'A': state.autoReference = true; break;
      case 'F': state.truncationString = unescapeString(argument); break;
      case 'M': state.macroName = argument; break;
      case 'O': state.format = 'roff'; break;
      case 'R': state.rightReference = true; break;
      case 'S': state.contextRegex = unescapeString(argument); break;
      case 'T': state.format = 'tex'; break;
      case 'W': {
        const pattern = unescapeString(argument);
        state.wordRegex = pattern === '' ? null : pattern;
        break;
      }
      case 'U': {
        const choices = ['roff', 'tex'].filter((name) => name.startsWith(argument));
        if (argument === '' || choices.length !== 1) {
          streams.diagnostic(`ptx: ${choices.length > 1 ? 'ambiguous' : 'invalid'} argument ${quoteLocale(argument)} for ${quoteLocale('--format')}`);
          streams.diagnostic('Valid arguments are:\n  - ‘roff’\n  - ‘tex’');
          streams.diagnostic("Try 'ptx --help' for more information.");
          streams.exitCode = 1;
          return streams.result();
        }
        state.format = choices[0] as Format;
        break;
      }
      default: break;
    }
  }
  let files: (string | null)[];
  let outputName: string | null = null;
  const stdinName = (name: string): string | null => (name === '' || name === '-' ? null : name);
  if (operands.length === 0) files = [null];
  else if (state.gnuExtensions) files = operands.map(stdinName);
  else {
    files = [stdinName(operands[0])];
    if (operands.length > 1) outputName = operands[1];
    if (operands.length > 2) {
      streams.diagnostic(`ptx: extra operand ${quoteLocale(operands[2])}`);
      streams.diagnostic("Try 'ptx --help' for more information.");
      streams.exitCode = 1;
      return streams.result();
    }
  }
  if (state.format === null) state.format = state.gnuExtensions ? 'dumb' : 'roff';
  try {
    const raw = state.run(files, io);
    const text = bytesToFileText(Uint8Array.from(raw, (character) => character.charCodeAt(0) & 0xff));
    if (outputName !== null) {
      if (io.write === undefined || !io.write(outputName, text)) return failure(`${quotef(outputName)}: No such file or directory`);
    } else streams.stdout(text);
  } catch (error) {
    if (error instanceof UserFailure) return failure(error.message);
    throw error;
  }
  return streams.result();
}
