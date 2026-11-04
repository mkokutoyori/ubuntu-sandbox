import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { InputQueue, Streams, docsResult, fromBytes, quoteLocale, quotef, readFailureText, toBytes, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'crown-margin', letter: 'c', takesArgument: false },
  { name: 'prefix', letter: 'p', takesArgument: true },
  { name: 'split-only', letter: 's', takesArgument: false },
  { name: 'tagged-paragraph', letter: 't', takesArgument: false },
  { name: 'uniform-spacing', letter: 'u', takesArgument: false },
  { name: 'width', letter: 'w', takesArgument: true },
  { name: 'goal', letter: 'g', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const WIDTH = 75;
const LEEWAY = 7;
const DEFAULT_INDENT = 3;
const TAB_WIDTH = 8;
const MAX_WIDTH_LIMIT = 2500;
const EOF = -1;
const NEWLINE = 10;

const sqr = (n: number): number => n * n;
const shortCost = (n: number): number => sqr(n * 10);
const raggedCost = (n: number): number => shortCost(n) / 2;
const LINE_COST = sqr(70);
const widowCost = (n: number): number => Math.trunc(sqr(200) / (n + 2));
const orphanCost = (n: number): number => Math.trunc(sqr(150) / (n + 2));
const SENTENCE_BONUS = sqr(50);
const NOBREAK_COST = sqr(600);
const PAREN_BONUS = sqr(40);
const PUNCT_BONUS = sqr(40);
const MAX_COST = Number.MAX_SAFE_INTEGER;

const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13);
const isOpen = (c: number): boolean => "(['`\"".includes(String.fromCharCode(c));
const isClose = (c: number): boolean => ")]'\"".includes(String.fromCharCode(c));
const isPeriod = (c: number): boolean => '.?!'.includes(String.fromCharCode(c));
const isPunct = (c: number): boolean => c > 32 && c < 127 && !/[A-Za-z0-9]/.test(String.fromCharCode(c));

interface Word {
  text: string;
  length: number;
  space: number;
  paren: boolean;
  period: boolean;
  punct: boolean;
  final: boolean;
  lineLength: number;
  bestCost: number;
  nextBreak: number;
}

interface FmtOptions {
  crown: boolean;
  tagged: boolean;
  split: boolean;
  uniform: boolean;
  prefix: string;
  prefixLeadSpace: number;
  prefixFullLength: number;
  prefixLength: number;
  maxWidth: number;
  goalWidth: number;
}

class Formatter {
  private data = '';
  private at = 0;
  private out = '';
  private inColumn = 0;
  private outColumn = 0;
  private tabs = false;
  private prefixIndent = 0;
  private firstIndent = 0;
  private otherIndent = 0;
  private nextChar = EOF;
  private nextPrefixIndent = 0;
  private lastLineLength = 0;
  private words: Word[] = [];
  private limit = 0;

  constructor(private readonly options: FmtOptions) {}

  format(text: string): string {
    this.data = text;
    this.at = 0;
    this.out = '';
    this.tabs = false;
    this.otherIndent = 0;
    this.nextChar = this.getPrefix();
    while (this.getParagraph()) {
      this.formatParagraph();
      this.putParagraph(this.words.length);
    }
    return this.out;
  }

  private getc(): number {
    return this.at < this.data.length ? this.data.charCodeAt(this.at++) : EOF;
  }

  private putChar(code: number): void { this.out += String.fromCharCode(code); }

  private setOtherIndent(sameParagraph: boolean): void {
    const { split, crown, tagged } = this.options;
    if (split) this.otherIndent = this.firstIndent;
    else if (crown) this.otherIndent = sameParagraph ? this.inColumn : this.firstIndent;
    else if (tagged) {
      if (sameParagraph && this.inColumn !== this.firstIndent) this.otherIndent = this.inColumn;
      else if (this.otherIndent === this.firstIndent) this.otherIndent = this.firstIndent === 0 ? DEFAULT_INDENT : 0;
    } else this.otherIndent = this.firstIndent;
  }

  private getParagraph(): boolean {
    this.lastLineLength = 0;
    let c = this.nextChar;
    while (c === NEWLINE || c === EOF || this.nextPrefixIndent < this.options.prefixLeadSpace
      || this.inColumn < this.nextPrefixIndent + this.options.prefixFullLength) {
      c = this.copyRest(c);
      if (c === EOF) { this.nextChar = EOF; return false; }
      this.putChar(NEWLINE);
      c = this.getPrefix();
    }
    this.prefixIndent = this.nextPrefixIndent;
    this.firstIndent = this.inColumn;
    this.words = [];
    c = this.getLine(c);
    this.setOtherIndent(this.samePara(c));
    const { split, crown, tagged } = this.options;
    if (split) {
      // single line paragraph
    } else if (crown) {
      if (this.samePara(c)) {
        do { c = this.getLine(c); } while (this.samePara(c) && this.inColumn === this.otherIndent);
      }
    } else if (tagged) {
      if (this.samePara(c) && this.inColumn !== this.firstIndent) {
        do { c = this.getLine(c); } while (this.samePara(c) && this.inColumn === this.otherIndent);
      }
    } else {
      while (this.samePara(c) && this.inColumn === this.otherIndent) c = this.getLine(c);
    }
    const last = this.words[this.words.length - 1];
    last.period = true;
    last.final = true;
    this.nextChar = c;
    return true;
  }

  private copyRest(first: number): number {
    let c = first;
    this.outColumn = 0;
    const { prefix, prefixLength } = this.options;
    if (this.inColumn > this.nextPrefixIndent || (c !== NEWLINE && c !== EOF)) {
      this.putSpace(this.nextPrefixIndent);
      for (let index = 0; this.outColumn !== this.inColumn && index < prefix.length; index++, this.outColumn++) this.putChar(prefix.charCodeAt(index));
      if (c !== EOF && c !== NEWLINE) this.putSpace(this.inColumn - this.outColumn);
      if (c === EOF && this.inColumn >= this.nextPrefixIndent + prefixLength) this.putChar(NEWLINE);
    }
    while (c !== NEWLINE && c !== EOF) {
      this.putChar(c);
      c = this.getc();
    }
    return c;
  }

  private samePara(c: number): boolean {
    return this.nextPrefixIndent === this.prefixIndent
      && this.inColumn >= this.nextPrefixIndent + this.options.prefixFullLength
      && c !== NEWLINE && c !== EOF;
  }

  private getLine(first: number): number {
    let c = first;
    do {
      let text = '';
      do {
        text += String.fromCharCode(c);
        c = this.getc();
      } while (c !== EOF && !isSpace(c));
      const word: Word = {
        text, length: text.length, space: 0, paren: false, period: false, punct: false, final: false, lineLength: 0, bestCost: 0, nextBreak: 0,
      };
      this.inColumn += word.length;
      this.checkPunctuation(word);
      const start = this.inColumn;
      c = this.getSpace(c);
      word.space = this.inColumn - start;
      word.final = c === EOF || (word.period && (c === NEWLINE || word.space > 1));
      if (c === NEWLINE || c === EOF || this.options.uniform) word.space = word.final ? 2 : 1;
      this.words.push(word);
    } while (c !== NEWLINE && c !== EOF);
    return this.getPrefix();
  }

  private getPrefix(): number {
    this.inColumn = 0;
    let c = this.getSpace(this.getc());
    const { prefix, prefixLength, prefixLeadSpace } = this.options;
    if (prefixLength === 0) {
      this.nextPrefixIndent = prefixLeadSpace < this.inColumn ? prefixLeadSpace : this.inColumn;
    } else {
      this.nextPrefixIndent = this.inColumn;
      for (let index = 0; index < prefix.length; index++) {
        if (c !== prefix.charCodeAt(index)) return c;
        this.inColumn += 1;
        c = this.getc();
      }
      c = this.getSpace(c);
    }
    return c;
  }

  private getSpace(first: number): number {
    let c = first;
    while (true) {
      if (c === 32) this.inColumn += 1;
      else if (c === 9) {
        this.tabs = true;
        this.inColumn = (Math.floor(this.inColumn / TAB_WIDTH) + 1) * TAB_WIDTH;
      } else return c;
      c = this.getc();
    }
  }

  private checkPunctuation(word: Word): void {
    const text = word.text;
    let finish = text.length - 1;
    word.paren = isOpen(text.charCodeAt(0));
    word.punct = isPunct(text.charCodeAt(finish));
    while (finish > 0 && isClose(text.charCodeAt(finish))) finish -= 1;
    word.period = isPeriod(text.charCodeAt(finish));
  }

  private baseCost(index: number): number {
    const words = this.words;
    const word = words[index];
    let cost = LINE_COST;
    if (index > 0) {
      const previous = words[index - 1];
      if (previous.period) cost += previous.final ? -SENTENCE_BONUS : NOBREAK_COST;
      else if (previous.punct) cost -= PUNCT_BONUS;
      else if (index > 1 && words[index - 2].final) cost += widowCost(previous.length);
    }
    if (word.paren) cost -= PAREN_BONUS;
    else if (word.final) cost += orphanCost(word.length);
    return cost;
  }

  private lineCost(next: number, length: number): number {
    if (next === this.limit) return 0;
    let cost = shortCost(this.options.goalWidth - length);
    if (this.words[next].nextBreak !== this.limit) cost += raggedCost(length - this.words[next].lineLength);
    return cost;
  }

  private formatParagraph(): void {
    const words = this.words;
    const limit = words.length;
    this.limit = limit;
    const sentinel: Word = { text: '', length: this.options.maxWidth, space: 0, paren: false, period: false, punct: false, final: false, lineLength: 0, bestCost: 0, nextBreak: 0 };
    words.push(sentinel);
    for (let start = limit - 1; start >= 0; start--) {
      let best = MAX_COST;
      let length = start === 0 ? this.firstIndent : this.otherIndent;
      let w = start;
      length += words[w].length;
      do {
        w++;
        let cost = this.lineCost(w, length) + words[w].bestCost;
        if (start === 0 && this.lastLineLength > 0) cost += raggedCost(length - this.lastLineLength);
        if (cost < best) {
          best = cost;
          words[start].nextBreak = w;
          words[start].lineLength = length;
        }
        if (w === limit) break;
        length += words[w - 1].space + words[w].length;
      } while (length < this.options.maxWidth);
      words[start].bestCost = best + this.baseCost(start);
    }
    words.pop();
  }

  private putParagraph(finish: number): void {
    this.putLine(0, this.firstIndent);
    for (let w = this.words[0].nextBreak; w !== finish; w = this.words[w].nextBreak) this.putLine(w, this.otherIndent);
  }

  private putLine(start: number, indent: number): void {
    this.outColumn = 0;
    this.putSpace(this.prefixIndent);
    this.out += this.options.prefix;
    this.outColumn += this.options.prefixLength;
    this.putSpace(indent - this.outColumn);
    const end = this.words[start].nextBreak - 1;
    let w = start;
    for (; w !== end; w++) {
      this.putWord(this.words[w]);
      this.putSpace(this.words[w].space);
    }
    this.putWord(this.words[w]);
    this.lastLineLength = this.outColumn;
    this.putChar(NEWLINE);
  }

  private putWord(word: Word): void {
    this.out += word.text;
    this.outColumn += word.length;
  }

  private putSpace(space: number): void {
    const spaceTarget = this.outColumn + space;
    if (this.tabs) {
      const tabTarget = Math.floor(spaceTarget / TAB_WIDTH) * TAB_WIDTH;
      if (this.outColumn + 1 < tabTarget) {
        while (this.outColumn < tabTarget) {
          this.out += '\t';
          this.outColumn = (Math.floor(this.outColumn / TAB_WIDTH) + 1) * TAB_WIDTH;
        }
      }
    }
    while (this.outColumn < spaceTarget) {
      this.out += ' ';
      this.outColumn += 1;
    }
  }
}

function parseWidth(text: string, max: number): number | string {
  if (!/^\+?\d+$/.test(text)) return `fmt: invalid width: ${quoteLocale(text)}`;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > max) return `fmt: invalid width: ${quoteLocale(text)}: Numerical result out of range`;
  return value;
}

export function runFmt(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const streams = new Streams();
  const options: FmtOptions = {
    crown: false, tagged: false, split: false, uniform: false, prefix: '', prefixLeadSpace: 0, prefixFullLength: 0,
    prefixLength: 0, maxWidth: WIDTH, goalWidth: 0,
  };
  let widthOption: string | null = null;
  let goalOption: string | null = null;
  const operands: string[] = [];
  let rest = [...args];
  if (rest.length > 0 && /^-\d/.test(rest[0])) { widthOption = rest[0].slice(1); rest = rest.slice(1); }
  for (const item of shortOptions(rest, 'cstuw:p:g:0123456789', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('fmt', getoptDiagnostic('fmt', item));
    const value = item.argument ?? '';
    switch (item.letter) {
      case 'H': return docsResult('fmt', 'help');
      case 'V': return docsResult('fmt', 'version');
      case 'c': options.crown = true; break;
      case 's': options.split = true; break;
      case 't': options.tagged = true; break;
      case 'u': options.uniform = true; break;
      case 'w': widthOption = value; break;
      case 'g': goalOption = value; break;
      case 'p': {
        let lead = 0;
        while (value[lead] === ' ') lead++;
        const body = value.slice(lead);
        options.prefixLeadSpace = lead;
        options.prefixFullLength = body.length;
        options.prefix = body.replace(/ +$/, '');
        options.prefixLength = options.prefix.length;
        break;
      }
      default:
        if (/^\d$/.test(item.letter)) {
          streams.diagnostic(`fmt: invalid option -- ${item.letter}; -WIDTH is recognized only when it is the first\noption; use -w N instead`);
          streams.diagnostic("Try 'fmt --help' for more information.");
          streams.exitCode = 1;
          return streams.result();
        }
    }
  }
  const fail = (message: string): CoreutilsRun => {
    const failed = new Streams();
    failed.diagnostic(message);
    failed.exitCode = 1;
    return failed.result();
  };
  if (widthOption !== null) {
    const parsed = parseWidth(widthOption, MAX_WIDTH_LIMIT);
    if (typeof parsed === 'string') return fail(parsed);
    options.maxWidth = parsed;
  }
  if (goalOption !== null) {
    const parsed = parseWidth(goalOption, options.maxWidth);
    if (typeof parsed === 'string') return fail(parsed);
    options.goalWidth = parsed;
    if (widthOption === null) options.maxWidth = parsed + 10;
  } else {
    options.goalWidth = Math.trunc((options.maxWidth * (2 * (100 - LEEWAY) + 1)) / 200);
  }
  const queue = new InputQueue(io);
  for (const name of operands.length === 0 ? ['-'] : operands) {
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`fmt: cannot open ${quotef(name)} for reading: ${readFailureText(read)}`);
      streams.exitCode = 1;
      continue;
    }
    const raw = Array.from(toBytes(read.text), (byte) => String.fromCharCode(byte)).join('');
    const formatted = new Formatter(options).format(raw);
    streams.stdout(fromBytes(Buffer.from(formatted, 'latin1')));
  }
  return streams.result();
}
