import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { InputQueue, Streams, docsResult, quoteLocale, quotef, readFailureText, toBytes, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'echo', letter: 'e', takesArgument: false },
  { name: 'input-range', letter: 'i', takesArgument: true },
  { name: 'head-count', letter: 'n', takesArgument: true },
  { name: 'output', letter: 'o', takesArgument: true },
  { name: 'random-source', letter: 'R', takesArgument: true },
  { name: 'repeat', letter: 'r', takesArgument: false },
  { name: 'zero-terminated', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const REPEAT_WITHOUT_COUNT_LIMIT = 10000;

export interface RandomBytes {
  next(): number | null;
}

export function generatorFromBytes(bytes: Uint8Array): RandomBytes {
  let at = 0;
  return { next: () => (at < bytes.length ? bytes[at++] : null) };
}

export function generatorFromMath(): RandomBytes {
  return { next: () => Math.floor(Math.random() * 256) };
}

class SourceExhausted extends Error {}

class UniformSource {
  private num = 0n;
  private max = 0n;

  constructor(private readonly bytes: RandomBytes) {}

  below(count: number): number {
    if (count <= 1) return 0;
    const choices = BigInt(count);
    const top = choices - 1n;
    for (;;) {
      while (this.max < top) {
        const byte = this.bytes.next();
        if (byte === null) throw new SourceExhausted();
        this.num = this.num * 256n + BigInt(byte);
        this.max = this.max * 256n + 255n;
      }
      const blocks = (this.max + 1n) / choices;
      if (this.num < blocks * choices) {
        const result = this.num % choices;
        this.num /= choices;
        this.max = blocks - 1n;
        return Number(result);
      }
      this.num -= blocks * choices;
      this.max -= blocks * choices;
    }
  }
}

function parseCount(text: string): bigint | null {
  return /^\d+$/.test(text) ? BigInt(text) : null;
}

export function runShuf(args: readonly string[], io: CoreutilsIO, fallback: RandomBytes): CoreutilsRun {
  let echo = false;
  let inputRange: [bigint, bigint] | null = null;
  let headLines: bigint | null = null;
  let outfile: string | null = null;
  let randomSource: string | null = null;
  let repeat = false;
  let eol = '\n';
  const operands: string[] = [];
  const streams = new Streams();
  const fail = (line: string): CoreutilsRun => {
    streams.diagnostic(line);
    streams.exitCode = 1;
    return streams.result();
  };
  for (const item of shortOptions(args, 'ei:n:o:rz', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('shuf', getoptDiagnostic('shuf', item));
    const value = item.argument ?? '';
    switch (item.letter) {
      case 'H': return docsResult('shuf', 'help');
      case 'V': return docsResult('shuf', 'version');
      case 'e': echo = true; break;
      case 'i': {
        if (inputRange !== null) return fail('shuf: multiple -i options specified');
        const match = /^(\d+)-(\d+)$/.exec(value);
        if (match === null) return fail(`shuf: invalid input range: ${quoteLocale(value)}`);
        const low = BigInt(match[1]);
        const high = BigInt(match[2]);
        if (low > high + 1n) return fail(`shuf: invalid input range: ${quoteLocale(value)}`);
        inputRange = [low, high];
        break;
      }
      case 'n': {
        const count = parseCount(value);
        if (count === null) return fail(`shuf: invalid line count: ${quoteLocale(value)}`);
        headLines = headLines === null || count < headLines ? count : headLines;
        break;
      }
      case 'o':
        if (outfile !== null && outfile !== value) return fail('shuf: multiple output files specified');
        outfile = value;
        break;
      case 'R':
        if (randomSource !== null && randomSource !== value) return fail('shuf: multiple random sources specified');
        randomSource = value;
        break;
      case 'r': repeat = true; break;
      case 'z': eol = '\0'; break;
      default: break;
    }
  }
  if (echo && inputRange !== null) return usageFailure('shuf', 'shuf: cannot combine -e and -i options');
  if (inputRange !== null ? operands.length > 0 : !echo && operands.length > 1) {
    return usageFailure('shuf', `shuf: extra operand ${quoteLocale(operands[inputRange !== null ? 0 : 1])}`);
  }
  let items: string[] | null = null;
  let low = 0n;
  let total = 0;
  if (headLines === 0n) {
    items = [];
  } else if (echo) {
    items = operands;
  } else if (inputRange !== null) {
    low = inputRange[0];
    total = Number(inputRange[1] - inputRange[0] + 1n);
  } else {
    const name = operands[0] ?? '-';
    const read = new InputQueue(io).read(name);
    if (read.kind !== 'ok') return fail(`shuf: ${quotef(name)}: ${readFailureText(read)}`);
    const lines = read.text === '' ? [] : read.text.split(eol);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    items = lines;
  }
  if (items !== null) total = items.length;
  const limit = headLines === null ? Infinity : headLines > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(headLines);
  let source = new UniformSource(fallback);
  if (randomSource !== null) {
    const read = new InputQueue(io).read(randomSource);
    if (read.kind !== 'ok') return fail(`shuf: ${quotef(randomSource)}: ${readFailureText(read)}`);
    source = new UniformSource(generatorFromBytes(toBytes(read.text)));
  }
  const label = (index: number): string => (items !== null ? items[index] : String(low + BigInt(index)));
  const picked: string[] = [];
  try {
    if (repeat) {
      if (limit !== 0 && total === 0) return fail('shuf: no lines to repeat');
      const wanted = limit === Infinity ? REPEAT_WITHOUT_COUNT_LIMIT : limit;
      for (let at = 0; at < wanted; at++) picked.push(label(source.below(total)));
    } else {
      const order = Array.from({ length: total }, (_, index) => index);
      const wanted = Math.min(total, limit);
      for (let at = 0; at < wanted; at++) {
        const swap = at + source.below(total - at);
        [order[at], order[swap]] = [order[swap], order[at]];
        picked.push(label(order[at]));
      }
    }
  } catch (error) {
    if (!(error instanceof SourceExhausted)) throw error;
    return fail(`shuf: ${quotef(randomSource ?? 'getrandom')}: end of file`);
  }
  const text = picked.map((line) => `${line}${eol}`).join('');
  if (outfile !== null) {
    if (io.write === undefined || !io.write(outfile, text)) return fail(`shuf: ${quotef(outfile)}: No such file or directory`);
    return streams.result();
  }
  streams.stdout(text);
  return streams.result();
}
