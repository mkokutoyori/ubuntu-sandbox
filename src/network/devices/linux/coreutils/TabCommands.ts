import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { InputQueue, Streams, docsResult, quoteLocale, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

interface TabStops {
  readonly stops: readonly number[];
  readonly extend: { readonly kind: '/' | '+'; readonly step: number } | null;
}

const DEFAULT_TAB = 8;
const MAX_TAB = Number.MAX_SAFE_INTEGER;

function parseTabStops(program: string, spec: string): TabStops | string {
  const tokens = spec.split(/[,\s]+/).filter((token) => token !== '');
  const stops: number[] = [];
  let extend: TabStops['extend'] = null;
  for (const [index, token] of tokens.entries()) {
    let body = token;
    let kind: '/' | '+' | null = null;
    if (body[0] === '/' || body[0] === '+') { kind = body[0] as '/' | '+'; body = body.slice(1); }
    const slash = body.search(/[/+]/);
    if (slash > 0) return `${program}: '${body[slash]}' specifier not at start of number: ${quoteLocale(body.slice(slash))}`;
    const digits = /^\d*/.exec(body)?.[0] ?? '';
    if (digits.length < body.length) return `${program}: tab size contains invalid character(s): ${quoteLocale(body.slice(digits.length))}`;
    if (digits === '') {
      if (kind === null) continue;
      continue;
    }
    const value = Number(digits);
    if (!Number.isSafeInteger(value) || value > MAX_TAB) return `${program}: tab stop is too large ${quoteLocale(token)}`;
    if (value === 0) return `${program}: tab size cannot be 0`;
    if (kind !== null) {
      if (index !== tokens.length - 1) return `${program}: '${kind}' specifier only allowed with the last value`;
      extend = { kind, step: value };
      continue;
    }
    if (stops.length > 0 && value <= stops[stops.length - 1]) return `${program}: tab sizes must be ascending`;
    stops.push(value);
  }
  if (stops.length === 0 && extend === null) return { stops: [], extend: { kind: '/', step: DEFAULT_TAB } };
  if (stops.length === 1 && extend === null) return { stops: [], extend: { kind: '/', step: stops[0] } };
  return { stops, extend };
}

function nextStop(tabs: TabStops, column: number): number | null {
  for (const stop of tabs.stops) if (stop > column) return stop;
  if (tabs.extend === null) return null;
  const last = tabs.stops.length === 0 ? 0 : tabs.stops[tabs.stops.length - 1];
  if (tabs.extend.kind === '/') return (Math.floor(column / tabs.extend.step) + 1) * tabs.extend.step;
  return last + (Math.floor((column - last) / tabs.extend.step) + 1) * tabs.extend.step;
}

function expandLine(line: string, tabs: TabStops, initialOnly: boolean): string {
  let out = '';
  let column = 0;
  let converting = true;
  for (const ch of line) {
    if (ch === '\t') {
      const stop = nextStop(tabs, column);
      if (converting) {
        const width = stop === null ? 1 : stop - column;
        out += ' '.repeat(width);
        column += width;
      } else {
        out += ch;
        column = stop ?? column + 1;
      }
      continue;
    }
    if (ch === '\b') column = Math.max(0, column - 1);
    else column += 1;
    if (initialOnly && ch !== ' ') converting = false;
    out += ch;
  }
  return out;
}

function unexpandLine(line: string, tabs: TabStops, all: boolean): string {
  let out = '';
  let column = 0;
  let runStart: number | null = null;
  let runChars = '';
  let leading = true;
  const flush = (): void => {
    if (runStart === null) return;
    let current = runStart;
    const end = column;
    let emitted = '';
    while (true) {
      const stop = nextStop(tabs, current);
      if (stop === null || stop > end) break;
      const onlyOneSpaceLeft = stop - current === 1 && stop === end;
      if (onlyOneSpaceLeft && !runChars.includes('\t')) break;
      emitted += '\t';
      current = stop;
    }
    out += emitted + ' '.repeat(end - current);
    runStart = null;
    runChars = '';
  };
  for (const ch of line) {
    const eligible = all || leading;
    if ((ch === ' ' || ch === '\t') && eligible) {
      if (runStart === null) runStart = column;
      runChars += ch;
      if (ch === ' ') column += 1;
      else column = nextStop(tabs, column) ?? column + 1;
      continue;
    }
    flush();
    if (ch === ' ' || ch === '\t') {
      out += ch;
      column = ch === ' ' ? column + 1 : nextStop(tabs, column) ?? column + 1;
      continue;
    }
    leading = false;
    if (ch === '\b') column = Math.max(0, column - 1);
    else column += 1;
    out += ch;
  }
  flush();
  return out;
}

const EXPAND_LONG: readonly LongOption[] = [
  { name: 'initial', letter: 'i', takesArgument: false },
  { name: 'tabs', letter: 't', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const UNEXPAND_LONG: readonly LongOption[] = [
  { name: 'all', letter: 'a', takesArgument: false },
  { name: 'first-only', letter: 'f', takesArgument: false },
  { name: 'tabs', letter: 't', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

function runTabTool(program: 'expand' | 'unexpand', args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const operands: string[] = [];
  let spec = '';
  let initialOnly = false;
  let all = false;
  const numeric: string[] = [];
  const optstring = program === 'expand' ? 'it:0123456789,' : 'at:0123456789,';
  for (const item of shortOptions(args, optstring, program === 'expand' ? EXPAND_LONG : UNEXPAND_LONG)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure(program, getoptDiagnostic(program, item));
    switch (item.letter) {
      case 'H': return docsResult(program, 'help');
      case 'V': return docsResult(program, 'version');
      case 'i': initialOnly = true; break;
      case 'a': all = true; break;
      case 'f': all = false; break;
      case 't': spec = item.argument ?? ''; all = true; break;
      default: numeric.push(item.letter);
    }
  }
  if (numeric.length > 0) { spec = numeric.join(''); all = true; }
  const tabs = parseTabStops(program, spec);
  if (typeof tabs === 'string') {
    const failed = new Streams();
    failed.diagnostic(tabs);
    failed.exitCode = 1;
    return failed.result();
  }
  const streams = new Streams();
  const queue = new InputQueue(io);
  const convert = (line: string): string => (program === 'expand' ? expandLine(line, tabs, initialOnly) : unexpandLine(line, tabs, all));
  for (const name of operands.length === 0 ? ['-'] : operands) {
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`${program}: ${quotef(name)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      continue;
    }
    streams.stdout(read.text.split('\n').map(convert).join('\n'));
  }
  return streams.result();
}

export const runExpand = (args: readonly string[], io: CoreutilsIO): CoreutilsRun => runTabTool('expand', args, io);
export const runUnexpand = (args: readonly string[], io: CoreutilsIO): CoreutilsRun => runTabTool('unexpand', args, io);
