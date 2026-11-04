import { formatPrintf } from '@/bash/runtime/Printf';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { posixToJsSource } from '../regex/PosixRegex';
import { PosixRegexError } from '../regex/PosixEre';
import { InputQueue, Streams, docsResult, quoteLocale, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'digits', letter: 'n', takesArgument: true },
  { name: 'quiet', letter: 'q', takesArgument: false },
  { name: 'silent', letter: 's', takesArgument: false },
  { name: 'keep-files', letter: 'k', takesArgument: false },
  { name: 'elide-empty-files', letter: 'z', takesArgument: false },
  { name: 'prefix', letter: 'f', takesArgument: true },
  { name: 'suffix-format', letter: 'b', takesArgument: true },
  { name: 'suppress-matched', letter: 'M', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const INT_MAX = 2147483647;
const INTMAX_MAX = 9223372036854775807n;

interface Control {
  regexp: RegExp | null;
  ignore: boolean;
  offset: number;
  repeat: number;
  repeatForever: boolean;
  linesRequired: number;
  argument: string;
}

class Disappeared extends Error {}

class Fatal extends Error {
  constructor(readonly keepOutputs: boolean) {
    super('fatal');
  }
}

function quoteAlways(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function validateSuffix(format: string): string | null {
  let percent = false;
  for (let at = 0; at < format.length; at++) {
    if (format[at] !== '%') continue;
    at++;
    if (format[at] === '%') continue;
    if (percent) return 'too many % conversion specifications in suffix';
    percent = true;
    let flags = 0;
    while ('-0\'#'.includes(format[at] ?? 'x')) {
      if (format[at] === '\'') flags |= 1;
      if (format[at] === '#') flags |= 2;
      at++;
    }
    while (/\d/.test(format[at] ?? '')) at++;
    if (format[at] === '.') { at++; while (/\d/.test(format[at] ?? '')) at++; }
    const conversion = format[at];
    let compatible = 1;
    if (conversion === undefined) return 'missing conversion specifier in suffix';
    if ('di'.includes(conversion) || conversion === 'u') compatible = 1;
    else if ('oxX'.includes(conversion)) compatible = 2;
    else return /[ -~]/.test(conversion) ? `invalid conversion specifier in suffix: ${conversion}` : `invalid conversion specifier in suffix: \\${conversion.charCodeAt(0).toString(8).padStart(3, '0')}`;
    if (flags & ~compatible) return `invalid flags in conversion specification: %${flags & ~compatible & 2 ? '#' : '\''}${conversion}`;
  }
  return percent ? null : 'missing % conversion specification in suffix';
}

export function runCsplit(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let prefix = 'xx';
  let suffix: string | null = null;
  let digits = 2;
  let keepFiles = false;
  let quiet = false;
  let elideEmpty = false;
  let suppressMatched = false;
  const operands: string[] = [];
  const streams = new Streams();
  const fatalExit = (line: string): CoreutilsRun => {
    streams.diagnostic(line);
    streams.exitCode = 1;
    return streams.result();
  };
  for (const item of shortOptions(args, 'f:b:kn:sqz', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('csplit', getoptDiagnostic('csplit', item));
    const value = item.argument ?? '';
    switch (item.letter) {
      case 'H': return docsResult('csplit', 'help');
      case 'V': return docsResult('csplit', 'version');
      case 'f': prefix = value; break;
      case 'b': suffix = value; break;
      case 'k': keepFiles = true; break;
      case 'n':
        if (!/^\d+$/.test(value) || Number(value) > INT_MAX) return fatalExit(`csplit: invalid number: ${quoteLocale(value)}`);
        digits = Number(value);
        break;
      case 's': case 'q': quiet = true; break;
      case 'z': elideEmpty = true; break;
      case 'M': suppressMatched = true; break;
      default: break;
    }
  }
  if (operands.length < 2) {
    return usageFailure('csplit', operands.length === 0 ? 'csplit: missing operand' : `csplit: missing operand after ${quoteLocale(operands[operands.length - 1])}`);
  }
  if (suffix !== null) {
    const problem = validateSuffix(suffix);
    if (problem !== null) return fatalExit(`csplit: ${problem}`);
  }
  const inputName = operands[0];
  const patterns = operands.slice(1);
  const read = new InputQueue(io).read(inputName);
  if (read.kind !== 'ok') return fatalExit(`csplit: cannot open ${quoteAlways(inputName)} for reading: ${readFailureText(read)}`);

  const controls: Control[] = [];
  let lastValue = 0n;
  try {
    for (let index = 0; index < patterns.length; index++) {
      const text = patterns[index];
      const control: Control = { regexp: null, ignore: false, offset: 0, repeat: 0, repeatForever: false, linesRequired: 0, argument: text };
      if (text.startsWith('/') || text.startsWith('%')) {
        const delimiter = text[0];
        const closing = text.lastIndexOf(delimiter);
        if (closing <= 0) throw new Error(`csplit: ${text}: closing delimiter '${delimiter}' missing`);
        control.ignore = delimiter === '%';
        try {
          control.regexp = new RegExp(posixToJsSource(text.slice(1, closing), { extended: false }), 'u');
        } catch (error) {
          if (error instanceof PosixRegexError) throw new Error(`csplit: ${quoteLocale(text)}: invalid regular expression: ${error.message}`);
          throw error;
        }
        const rest = text.slice(closing + 1);
        if (rest !== '') {
          if (!/^[+-]?\d+$/.test(rest) || BigInt(rest) > INTMAX_MAX || BigInt(rest) < -INTMAX_MAX) throw new Error(`csplit: ${quoteLocale(text)}: integer expected after delimiter`);
          control.offset = Number(rest);
        }
      } else {
        if (!/^\s*\+?\d+$/.test(text) || BigInt(text.trim().replace(/^\+/, '')) > INTMAX_MAX) throw new Error(`csplit: ${quoteLocale(text)}: invalid pattern`);
        const value = BigInt(text.trim().replace(/^\+/, ''));
        if (value === 0n) throw new Error(`csplit: ${text}: line number must be greater than zero`);
        if (value < lastValue) throw new Error(`csplit: line number ${quoteLocale(text)} is smaller than preceding line number, ${lastValue}`);
        if (value === lastValue) streams.diagnostic(`csplit: warning: line number ${quoteLocale(text)} is the same as preceding line number`);
        lastValue = value;
        control.linesRequired = Number(value);
      }
      controls.push(control);
      const next = patterns[index + 1];
      if (next !== undefined && next.startsWith('{')) {
        index++;
        if (!next.endsWith('}')) throw new Error(`csplit: ${quoteLocale(next)}: '}' is required in repeat count`);
        const inner = next.slice(1, -1);
        if (inner === '*') control.repeatForever = true;
        else if (/^\+?\d+$/.test(inner) && BigInt(inner.replace(/^\+/, '')) <= INTMAX_MAX) control.repeat = Number(inner.replace(/^\+/, ''));
        else throw new Error(`csplit: ${quoteLocale(next.slice(0, -1))}}: integer required between '{' and '}'`);
      }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return fatalExit(error.message);
  }

  const content = read.text;
  const lines: string[] = [];
  for (let at = 0; at < content.length;) {
    const end = content.indexOf('\n', at);
    if (end < 0) { lines.push(content.slice(at)); break; }
    lines.push(content.slice(at, end + 1));
    at = end + 1;
  }
  let firstAvailable = 1;
  let current = 0;
  let filesCreated = 0;
  let outputName: string | null = null;
  let outputText = '';
  let outputOpen = false;
  let pendingStdout = '';
  const createdNames: string[] = [];
  const findLine = (n: number): string | null => (firstAvailable <= lines.length && n >= 1 && n <= lines.length ? lines[n - 1] : null);
  const firstLineInBuffer = (): number => {
    if (firstAvailable > lines.length) throw new Disappeared();
    return firstAvailable;
  };
  const removeLine = (): string | null => {
    if (firstAvailable > lines.length) return null;
    if (current < firstAvailable) current = firstAvailable;
    return lines[firstAvailable++ - 1];
  };
  const noMoreLines = (): boolean => findLine(current + 1) === null;
  const nameOf = (number: number): string => {
    if (suffix !== null) return prefix + formatPrintf(suffix, [String(number)]).output;
    return prefix + String(number).padStart(digits, '0');
  };
  const flushStdout = (): void => {
    streams.stdout(pendingStdout);
    pendingStdout = '';
  };
  const errorLine = (message: string): void => {
    flushStdout();
    streams.diagnostic(message);
  };
  const closeOutput = (): void => {
    if (!outputOpen) return;
    const bytes = Buffer.byteLength(outputText, 'utf8');
    io.write?.(outputName as string, outputText);
    if (bytes === 0 && elideEmpty) {
      createdNames.pop();
      filesCreated--;
    } else if (!quiet) {
      pendingStdout += `${bytes}\n`;
    }
    outputOpen = false;
  };
  const cleanupFatal = (): never => {
    closeOutput();
    if (!keepFiles) filesCreated = 0;
    throw new Fatal(keepFiles);
  };
  const createOutput = (): void => {
    outputName = nameOf(filesCreated);
    outputText = '';
    if (io.write === undefined || !io.write(outputName, '')) {
      errorLine(`csplit: ${quotef(outputName)}: No such file or directory`);
      cleanupFatal();
    }
    createdNames.push(outputName);
    filesCreated++;
    outputOpen = true;
  };
  const save = (line: string): void => { outputText += line; };
  const dumpRest = (): void => {
    for (let line = removeLine(); line !== null; line = removeLine()) save(line);
  };
  const lineOutOfRange = (control: Control, repetition: number): never => {
    streams.diagnostic(`csplit: ${quoteLocale(String(control.linesRequired))}: line number out of range${repetition > 0 ? ` on repetition ${repetition}` : ''}`);
    return cleanupFatal();
  };
  const matchLine = (line: string, control: Control): boolean => (control.regexp as RegExp).test(line.endsWith('\n') ? line.slice(0, -1) : line);
  const writeToFile = (lastLine: number, ignore: boolean, control: Control): void => {
    const first = firstLineInBuffer();
    if (first > lastLine) { errorLine(`csplit: ${quoteLocale(control.argument)}: line number out of range`); cleanupFatal(); }
    for (let count = lastLine - first; count > 0; count--) {
      const line = removeLine();
      if (line === null) { errorLine(`csplit: ${quoteLocale(control.argument)}: line number out of range`); cleanupFatal(); }
      if (!ignore) save(line as string);
    }
  };
  const processLineCount = (control: Control, repetition: number): void => {
    const lastToSave = control.linesRequired * (repetition + 1);
    createOutput();
    if (noMoreLines() && suppressMatched) lineOutOfRange(control, repetition);
    let lineNumber = firstLineInBuffer();
    while (lineNumber++ < lastToSave) {
      const line = removeLine();
      if (line === null) lineOutOfRange(control, repetition);
      save(line as string);
    }
    closeOutput();
    if (suppressMatched) removeLine();
    if (noMoreLines() && !suppressMatched) lineOutOfRange(control, repetition);
  };
  const regexpFailure = (control: Control, repetition: number, ignore: boolean): never => {
    streams.diagnostic(`csplit: ${quoteLocale(control.argument)}: match not found${repetition > 0 ? ` on repetition ${repetition}` : ''}`);
    if (!ignore) { dumpRest(); closeOutput(); }
    return cleanupFatal();
  };
  class Finished extends Error {}
  const processRegexp = (control: Control, repetition: number): void => {
    const ignore = control.ignore;
    if (!ignore) createOutput();
    for (;;) {
      const line = findLine(++current);
      if (line === null) {
        if (control.repeatForever) {
          if (!ignore) { dumpRest(); closeOutput(); }
          throw new Finished();
        }
        regexpFailure(control, repetition, ignore);
      }
      if (matchLine(line as string, control)) break;
      if (control.offset >= 0) {
        const removed = removeLine();
        if (!ignore && removed !== null) save(removed);
      }
    }
    const breakLine = current + control.offset;
    writeToFile(breakLine, ignore, control);
    if (!ignore) closeOutput();
    if (control.offset > 0) current = breakLine;
    if (suppressMatched) removeLine();
  };
  try {
    for (const control of controls) {
      for (let repetition = 0; control.repeatForever || repetition <= control.repeat; repetition++) {
        if (control.regexp !== null) processRegexp(control, repetition);
        else processLineCount(control, repetition);
      }
    }
    createOutput();
    dumpRest();
    closeOutput();
  } catch (error) {
    if (error instanceof Disappeared) {
      flushStdout();
      streams.diagnostic('csplit: input disappeared');
      streams.exitCode = 1;
      return streams.result();
    }
    if (!(error instanceof Fatal) && !(error instanceof Finished)) throw error;
    if (error instanceof Fatal) {
      flushStdout();
      if (!error.keepOutputs) for (const name of createdNames) io.remove?.(name);
      streams.exitCode = 1;
      return streams.result();
    }
  }
  flushStdout();
  return streams.result();
}
