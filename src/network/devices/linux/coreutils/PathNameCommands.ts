import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, quoteLocale, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const BASENAME_LONG: readonly LongOption[] = [
  { name: 'multiple', letter: 'a', takesArgument: false },
  { name: 'suffix', letter: 's', takesArgument: true },
  { name: 'zero', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const DIRNAME_LONG: readonly LongOption[] = [
  { name: 'zero', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export function baseName(path: string, suffix = ''): string {
  const stripped = path.replace(/\/+$/, '');
  if (stripped === '') return path === '' ? '' : '/';
  const base = stripped.slice(stripped.lastIndexOf('/') + 1);
  return suffix !== '' && base !== suffix && base.endsWith(suffix) ? base.slice(0, base.length - suffix.length) : base;
}

export function dirName(path: string): string {
  if (path === '') return '.';
  const stripped = path.replace(/\/+$/, '');
  if (stripped === '') return '/';
  const cut = stripped.lastIndexOf('/');
  if (cut < 0) return '.';
  const directory = stripped.slice(0, cut).replace(/\/+$/, '');
  return directory === '' ? '/' : directory;
}

export function runBasename(args: readonly string[]): CoreutilsRun {
  let multiple = false;
  let suffix = '';
  let terminator = '\n';
  const operands: string[] = [];
  for (const item of shortOptions(args, 'as:z', BASENAME_LONG)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('basename', getoptDiagnostic('basename', item));
    switch (item.letter) {
      case 'H': return docsResult('basename', 'help');
      case 'V': return docsResult('basename', 'version');
      case 'a': multiple = true; break;
      case 's': multiple = true; suffix = item.argument ?? ''; break;
      case 'z': terminator = '\0'; break;
      default: break;
    }
  }
  if (operands.length === 0) return usageFailure('basename', 'basename: missing operand');
  if (!multiple && operands.length > 2) return usageFailure('basename', `basename: extra operand ${quoteLocale(operands[2])}`);
  const streams = new Streams();
  if (!multiple) streams.stdout(`${baseName(operands[0], operands[1] ?? '')}${terminator}`);
  else for (const operand of operands) streams.stdout(`${baseName(operand, suffix)}${terminator}`);
  return streams.result();
}

export function runDirname(args: readonly string[]): CoreutilsRun {
  let terminator = '\n';
  const operands: string[] = [];
  for (const item of shortOptions(args, 'z', DIRNAME_LONG)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('dirname', getoptDiagnostic('dirname', item));
    switch (item.letter) {
      case 'H': return docsResult('dirname', 'help');
      case 'V': return docsResult('dirname', 'version');
      case 'z': terminator = '\0'; break;
      default: break;
    }
  }
  if (operands.length === 0) return usageFailure('dirname', 'dirname: missing operand');
  const streams = new Streams();
  for (const operand of operands) streams.stdout(`${dirName(operand)}${terminator}`);
  return streams.result();
}
