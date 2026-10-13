import { defaultNanoSettings, type NanoFlag, type NanoSettings } from './NanoSettings';
import { NANO_USAGE, NANO_VERSION } from './NanoUsage';

export interface NanoSearchRequest {
  readonly pattern: string;
  readonly backwards: boolean;
}

export interface NanoStart {
  readonly line: number;
  readonly column: number;
  readonly search: NanoSearchRequest | null;
  readonly caseSensitive: boolean | null;
  readonly regex: boolean | null;
  readonly alerts: readonly string[];
}

export interface NanoFileRequest {
  readonly path: string;
  readonly start: NanoStart | null;
}

export type NanoInvocation =
  | { readonly kind: 'open'; readonly settings: NanoSettings; readonly files: readonly NanoFileRequest[] }
  | { readonly kind: 'print'; readonly stdout: string }
  | { readonly kind: 'fail'; readonly stdout: string; readonly stderr: string };

type Draft = { -readonly [K in keyof NanoSettings]: NanoSettings[K] };

type OptionEffect =
  | { readonly kind: 'flag'; readonly flag: NanoFlag; readonly value?: boolean }
  | { readonly kind: 'breaklonglines'; readonly value: boolean }
  | { readonly kind: 'text'; readonly field: 'quotestr' | 'wordchars' | 'backupdir' | 'operatingdir' | 'speller' | 'syntax' | 'rcfile' }
  | { readonly kind: 'number'; readonly field: 'tabsize' | 'fill' | 'guidestripe'; readonly rejects: string; readonly positive: boolean }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' };

interface OptionSpec {
  readonly long: string;
  readonly short: string;
  readonly takesArgument: boolean;
  readonly effect: OptionEffect;
}

const flagOption = (long: NanoFlag, short: string): OptionSpec => ({ long, short, takesArgument: false, effect: { kind: 'flag', flag: long } });
const textOption = (long: string, short: string, field: Extract<OptionEffect, { kind: 'text' }>['field']): OptionSpec => ({ long, short, takesArgument: true, effect: { kind: 'text', field } });

export const NANO_LONG_OPTIONS: readonly OptionSpec[] = [
  flagOption('boldtext', 'D'),
  flagOption('multibuffer', 'F'),
  flagOption('ignorercfiles', 'I'),
  flagOption('rawsequences', 'K'),
  flagOption('trimblanks', 'M'),
  textOption('quotestr', 'Q', 'quotestr'),
  flagOption('restricted', 'R'),
  flagOption('quickblank', 'U'),
  { long: 'version', short: 'V', takesArgument: false, effect: { kind: 'version' } },
  textOption('syntax', 'Y', 'syntax'),
  { long: 'breaklonglines', short: 'b', takesArgument: false, effect: { kind: 'breaklonglines', value: true } },
  flagOption('constantshow', 'c'),
  flagOption('rebinddelete', 'd'),
  textOption('rcfile', 'f', 'rcfile'),
  flagOption('showcursor', 'g'),
  { long: 'help', short: 'h', takesArgument: false, effect: { kind: 'help' } },
  flagOption('linenumbers', 'l'),
  flagOption('mouse', 'm'),
  textOption('operatingdir', 'o', 'operatingdir'),
  flagOption('preserve', 'p'),
  { long: 'fill', short: 'r', takesArgument: true, effect: { kind: 'number', field: 'fill', rejects: 'Requested fill size', positive: false } },
  textOption('speller', 's', 'speller'),
  flagOption('saveonexit', 't'),
  flagOption('view', 'v'),
  { long: 'nowrap', short: 'w', takesArgument: false, effect: { kind: 'breaklonglines', value: false } },
  flagOption('nohelp', 'x'),
  flagOption('smarthome', 'A'),
  flagOption('backup', 'B'),
  textOption('backupdir', 'C', 'backupdir'),
  flagOption('tabstospaces', 'E'),
  flagOption('locking', 'G'),
  flagOption('historylog', 'H'),
  { long: 'guidestripe', short: 'J', takesArgument: true, effect: { kind: 'number', field: 'guidestripe', rejects: 'Guide column', positive: true } },
  flagOption('nonewlines', 'L'),
  flagOption('noconvert', 'N'),
  flagOption('bookstyle', 'O'),
  flagOption('positionlog', 'P'),
  flagOption('softwrap', 'S'),
  { long: 'tabsize', short: 'T', takesArgument: true, effect: { kind: 'number', field: 'tabsize', rejects: 'Requested tab size', positive: true } },
  flagOption('wordbounds', 'W'),
  textOption('wordchars', 'X', 'wordchars'),
  flagOption('zap', 'Z'),
  flagOption('atblanks', 'a'),
  flagOption('emptyline', 'e'),
  flagOption('autoindent', 'i'),
  flagOption('jumpyscrolling', 'j'),
  flagOption('cutfromcursor', 'k'),
  flagOption('noread', 'n'),
  flagOption('indicator', 'q'),
  flagOption('unix', 'u'),
  flagOption('afterends', 'y'),
  flagOption('stateflags', '%'),
  flagOption('minibar', '_'),
  flagOption('zero', '0'),
];

const SHORT_ONLY_OPTIONS: readonly OptionSpec[] = [
  { long: '', short: '$', takesArgument: false, effect: { kind: 'flag', flag: 'softwrap' } },
];

const SHORT_OPTIONS: ReadonlyMap<string, OptionSpec> = new Map(
  [...NANO_LONG_OPTIONS, ...SHORT_ONLY_OPTIONS].map((spec) => [spec.short, spec]),
);

const HINT_ONLY_SHORT = '!';

const INT64_LIMIT = 2n ** 63n;

function parseNanoNumber(text: string): number | null {
  if (!/^[ \t\n\v\f\r]*[+-]?\d+$/.test(text)) return null;
  const value = BigInt(text.trim());
  if (value >= INT64_LIMIT || value < -INT64_LIMIT) return null;
  return Number(value);
}

function hint(programName: string): string {
  return `Type '${programName} -h' for a list of available options.`;
}

function failure(programName: string, stderr: string): NanoInvocation {
  return { kind: 'fail', stdout: hint(programName), stderr };
}

function applyEffect(draft: Draft, spec: OptionSpec, value: string): NanoInvocation | null {
  const effect = spec.effect;
  switch (effect.kind) {
    case 'flag':
      draft[effect.flag] = effect.value ?? true;
      return null;
    case 'breaklonglines':
      draft.breaklonglines = effect.value;
      return null;
    case 'text':
      draft[effect.field] = value;
      return null;
    case 'number': {
      const parsed = parseNanoNumber(value);
      if (parsed === null || (effect.positive && parsed <= 0)) {
        return { kind: 'fail', stdout: '', stderr: `${effect.rejects} "${value}" is invalid` };
      }
      draft[effect.field] = parsed;
      return null;
    }
    case 'help':
      return { kind: 'print', stdout: NANO_USAGE };
    case 'version':
      return { kind: 'print', stdout: NANO_VERSION };
  }
}

function scanLongOption(
  programName: string,
  argument: string,
  following: string | undefined,
): { spec: OptionSpec; value: string; consumedFollowing: boolean } | NanoInvocation {
  const body = argument.slice(2);
  const equals = body.indexOf('=');
  const name = equals >= 0 ? body.slice(0, equals) : body;
  const inline = equals >= 0 ? body.slice(equals + 1) : null;
  const exact = NANO_LONG_OPTIONS.find((spec) => spec.long === name);
  const candidates = exact ? [exact] : NANO_LONG_OPTIONS.filter((spec) => spec.long.startsWith(name));
  if (candidates.length === 0) return failure(programName, `${programName}: unrecognized option '${argument}'`);
  if (candidates.length > 1) {
    const possibilities = candidates.map((spec) => `'--${spec.long}'`).join(' ');
    return failure(programName, `${programName}: option '${argument}' is ambiguous; possibilities: ${possibilities}`);
  }
  const spec = candidates[0];
  if (!spec.takesArgument) {
    if (inline !== null) return failure(programName, `${programName}: option '--${spec.long}' doesn't allow an argument`);
    return { spec, value: '', consumedFollowing: false };
  }
  if (inline !== null) return { spec, value: inline, consumedFollowing: false };
  if (following === undefined) return failure(programName, `${programName}: option '--${spec.long}' requires an argument`);
  return { spec, value: following, consumedFollowing: true };
}

const POSITION_SEPARATORS = /[ ,./;]/;

function parseLineColumn(text: string): { line: number; column: number; valid: boolean } {
  const trimmed = text.replace(/^ +/, '');
  const separator = trimmed.search(POSITION_SEPARATORS);
  if (separator < 0) {
    const line = parseNanoNumber(trimmed);
    return { line: line ?? 0, column: 0, valid: line !== null };
  }
  let valid = true;
  let line = 0;
  if (separator > 0) {
    const parsed = parseNanoNumber(trimmed.slice(0, separator));
    if (parsed === null) valid = false;
    else line = parsed;
  }
  const column = parseNanoNumber(trimmed.slice(separator + 1));
  if (column === null) return { line, column: 0, valid: false };
  return { line, column, valid };
}

function parseStart(argument: string): NanoStart {
  if (argument === '+') return { line: -1, column: 0, search: null, caseSensitive: null, regex: null, alerts: [] };
  const text = argument.slice(1);
  const alerts: string[] = [];
  let caseSensitive: boolean | null = null;
  let regex: boolean | null = null;
  let index = 0;
  for (; index < text.length && /[A-Za-z]/.test(text[index]); index++) {
    switch (text[index]) {
      case 'c': caseSensitive = true; break;
      case 'C': caseSensitive = false; break;
      case 'r': regex = true; break;
      case 'R': regex = false; break;
      default: alerts.push(`Invalid search modifier '${text[index]}'`);
    }
  }
  const marker = text[index];
  if (marker === '/' || marker === '?') {
    const pattern = text.slice(index + 1);
    if (pattern === '') alerts.push('Empty search string');
    return { line: 0, column: 0, search: pattern === '' ? null : { pattern, backwards: marker === '?' }, caseSensitive, regex, alerts };
  }
  const position = parseLineColumn(text);
  if (!position.valid) alerts.push('Invalid line or column number');
  return { line: position.line, column: position.column, search: null, caseSensitive, regex, alerts };
}

export function parseNanoCommandLine(args: readonly string[], programName = 'nano'): NanoInvocation {
  const draft: Draft = { ...defaultNanoSettings() };
  const operands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (argument.startsWith('--')) {
      const scanned = scanLongOption(programName, argument, args[index + 1]);
      if ('kind' in scanned) return scanned;
      if (scanned.consumedFollowing) index++;
      const outcome = applyEffect(draft, scanned.spec, scanned.value);
      if (outcome !== null) return outcome;
      continue;
    }
    if (argument.startsWith('-') && argument.length > 1) {
      const letters = [...argument.slice(1)];
      for (let position = 0; position < letters.length; position++) {
        const letter = letters[position];
        if (letter === HINT_ONLY_SHORT) return { kind: 'fail', stdout: hint(programName), stderr: '' };
        const spec = SHORT_OPTIONS.get(letter);
        if (spec === undefined) return failure(programName, `${programName}: invalid option -- '${letter}'`);
        let value = '';
        if (spec.takesArgument) {
          const attached = letters.slice(position + 1).join('');
          if (attached !== '') value = attached;
          else if (index + 1 < args.length) value = args[++index];
          else return failure(programName, `${programName}: option requires an argument -- '${letter}'`);
        }
        const outcome = applyEffect(draft, spec, value);
        if (outcome !== null) return outcome;
        if (spec.takesArgument) break;
      }
      continue;
    }
    operands.push(argument);
  }
  const files: NanoFileRequest[] = [];
  for (let index = 0; index < operands.length;) {
    let start: NanoStart | null = null;
    if (index < operands.length - 1 && operands[index].startsWith('+')) start = parseStart(operands[index++]);
    files.push({ path: operands[index++], start });
  }
  return { kind: 'open', settings: draft, files };
}
