import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, quotef, quoteLocale, quoteShell, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'count', letter: 'c', takesArgument: false },
  { name: 'repeated', letter: 'd', takesArgument: false },
  { name: 'all-repeated', letter: 'D', takesArgument: false, optionalArgument: true },
  { name: 'group', letter: 'G', takesArgument: false, optionalArgument: true },
  { name: 'ignore-case', letter: 'i', takesArgument: false },
  { name: 'unique', letter: 'u', takesArgument: false },
  { name: 'skip-fields', letter: 'f', takesArgument: true },
  { name: 'skip-chars', letter: 's', takesArgument: true },
  { name: 'check-chars', letter: 'w', takesArgument: true },
  { name: 'zero-terminated', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const DELIMIT_CHOICES = ['none', 'prepend', 'separate'] as const;
const GROUP_CHOICES = ['prepend', 'append', 'separate', 'both'] as const;

function choice(value: string, choices: readonly string[]): string | null {
  if (choices.includes(value)) return value;
  const matches = choices.filter((name) => name.startsWith(value));
  return value !== '' && matches.length === 1 ? matches[0] : null;
}

function invalidArgument(program: string, value: string, option: string, choices: readonly string[]): CoreutilsRun {
  const streams = new Streams();
  streams.diagnostic(`${program}: invalid argument ${quoteLocale(value)} for ${quoteLocale(option)}`);
  streams.diagnostic('Valid arguments are:');
  for (const name of choices) streams.diagnostic(`  - ${quoteLocale(name)}`);
  streams.diagnostic(`Try '${program} --help' for more information.`);
  streams.exitCode = 1;
  return streams.result();
}

function keyOf(line: string, skipFields: number, skipChars: number, checkChars: number | null, ignoreCase: boolean): string {
  let rest = line;
  for (let field = 0; field < skipFields; field++) {
    rest = rest.replace(/^[ \t]*[^ \t]*/, '');
  }
  rest = rest.slice(skipChars);
  if (checkChars !== null) rest = rest.slice(0, checkChars);
  return ignoreCase ? rest.toLowerCase() : rest;
}

export function runUniq(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let count = false;
  let repeated = false;
  let unique = false;
  let allRepeated: (typeof DELIMIT_CHOICES)[number] | null = null;
  let group: (typeof GROUP_CHOICES)[number] | null = null;
  let ignoreCase = false;
  let skipFields = 0;
  let skipChars = 0;
  let checkChars: number | null = null;
  let zero = false;
  const operands: string[] = [];
  const failure = (line: string): CoreutilsRun => {
    const streams = new Streams();
    streams.diagnostic(line);
    streams.exitCode = 1;
    return streams.result();
  };
  for (const item of shortOptions(args, 'cdDf:ius:w:z', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('uniq', getoptDiagnostic('uniq', item));
    switch (item.letter) {
      case 'H': return docsResult('uniq', 'help');
      case 'V': return docsResult('uniq', 'version');
      case 'c': count = true; break;
      case 'd': repeated = true; break;
      case 'u': unique = true; break;
      case 'i': ignoreCase = true; break;
      case 'z': zero = true; break;
      case 'D': {
        const given = item.argument;
        if (given === undefined) { allRepeated = 'none'; break; }
        const picked = choice(given, DELIMIT_CHOICES);
        if (picked === null) return invalidArgument('uniq', given, '--all-repeated', DELIMIT_CHOICES);
        allRepeated = picked as (typeof DELIMIT_CHOICES)[number];
        break;
      }
      case 'G': {
        const given = item.argument;
        if (given === undefined) { group = 'separate'; break; }
        const picked = choice(given, GROUP_CHOICES);
        if (picked === null) return invalidArgument('uniq', given, '--group', GROUP_CHOICES);
        group = picked as (typeof GROUP_CHOICES)[number];
        break;
      }
      case 'f': {
        if (!/^\d+$/.test(item.argument ?? '')) return failure(`uniq: ${item.argument}: invalid number of fields to skip`);
        skipFields = Number(item.argument);
        break;
      }
      case 's': {
        if (!/^\d+$/.test(item.argument ?? '')) return failure(`uniq: ${item.argument}: invalid number of bytes to skip`);
        skipChars = Number(item.argument);
        break;
      }
      case 'w': {
        if (!/^\d+$/.test(item.argument ?? '')) return failure(`uniq: ${item.argument}: invalid number of bytes to compare`);
        checkChars = Number(item.argument);
        break;
      }
      default: break;
    }
  }
  if (operands.length > 2) return usageFailure('uniq', `uniq: extra operand ${quoteLocale(operands[2])}`);
  if (group !== null && (count || repeated || allRepeated !== null || unique)) {
    return usageFailure('uniq', 'uniq: --group is mutually exclusive with -c/-d/-D/-u');
  }
  if (allRepeated !== null && count) return usageFailure('uniq', 'uniq: printing all duplicated lines and repeat counts is meaningless');

  const streams = new Streams();
  const [inputName, outputName] = operands;
  const read = inputName === undefined || inputName === '-' ? { kind: 'ok' as const, text: io.stdin ?? '' } : io.read(inputName);
  if (read.kind !== 'ok') {
    const name = inputName as string;
    streams.diagnostic(read.kind === 'directory' ? `uniq: error reading ${quoteShell(name)}: Is a directory`
      : `uniq: ${quotef(name)}: ${read.kind === 'denied' ? 'Permission denied' : 'No such file or directory'}`);
    streams.exitCode = 1;
    return streams.result();
  }
  const terminator = zero ? '\0' : '\n';
  const lines = read.text.split(terminator);
  if (lines[lines.length - 1] === '') lines.pop();
  const groups: Array<{ line: string; count: number; members: string[] }> = [];
  for (const line of lines) {
    const key = keyOf(line, skipFields, skipChars, checkChars, ignoreCase);
    const last = groups[groups.length - 1];
    if (last !== undefined && keyOf(last.line, skipFields, skipChars, checkChars, ignoreCase) === key) {
      last.count++;
      last.members.push(line);
    } else groups.push({ line, count: 1, members: [line] });
  }

  let out = '';
  const emit = (line: string, n: number): void => {
    out += `${count ? `${String(n).padStart(7)} ` : ''}${line}${terminator}`;
  };
  if (group !== null) {
    groups.forEach((entry, index) => {
      if (group === 'prepend' || (group === 'both' && index === 0)) out += terminator;
      for (const member of entry.members) out += member + terminator;
      if (group === 'append' || group === 'both') out += terminator;
      if (group === 'separate' && index < groups.length - 1) out += terminator;
    });
  } else if (allRepeated !== null) {
    let first = true;
    for (const entry of groups) {
      if (entry.count < 2) continue;
      if (allRepeated === 'prepend' || (allRepeated === 'separate' && !first)) out += terminator;
      for (const member of entry.members) out += member + terminator;
      first = false;
    }
  } else {
    for (const entry of groups) {
      if (repeated && !unique && entry.count < 2) continue;
      if (unique && !repeated && entry.count > 1) continue;
      if (unique && repeated) continue;
      emit(entry.line, entry.count);
    }
  }
  if (outputName !== undefined && outputName !== '-') {
    if (io.write?.(outputName, out) !== true) {
      streams.diagnostic(`uniq: ${quotef(outputName)}: No such file or directory`);
      streams.exitCode = 1;
    }
  } else streams.stdout(out);
  return streams.result();
}
