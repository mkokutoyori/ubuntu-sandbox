import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { formatLocalTime, parseDateSpec, positionalSetSpec } from '../system/SystemInfo';
import { TimeZone } from '../../../core/time/TimeZone';
import { argumentFailure, matchArgument } from './BackupControl';
import { Streams, docsResult, quoteLocale, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'date', letter: 'd', takesArgument: true },
  { name: 'debug', letter: 'D', takesArgument: false },
  { name: 'file', letter: 'f', takesArgument: true },
  { name: 'iso-8601', letter: 'I', takesArgument: false, optionalArgument: true },
  { name: 'reference', letter: 'r', takesArgument: true },
  { name: 'resolution', letter: 'R', takesArgument: false },
  { name: 'rfc-email', letter: 'e', takesArgument: false },
  { name: 'rfc-2822', letter: 'e', takesArgument: false },
  { name: 'rfc-3339', letter: '3', takesArgument: true },
  { name: 'set', letter: 's', takesArgument: true },
  { name: 'universal', letter: 'u', takesArgument: false },
  { name: 'utc', letter: 'u', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export interface DateHost {
  readonly nowMs: number;
  readonly mayStepClock: boolean;
  setClock(epochMs: number): void;
  fileMtimeMs(name: string): number | null;
  readLines(name: string): string[] | null;
}

const ISO_FORMATS: readonly (readonly [string, string])[] = [
  ['hours', '%Y-%m-%dT%H%:z'], ['minutes', '%Y-%m-%dT%H:%M%:z'], ['date', '%Y-%m-%d'],
  ['seconds', '%Y-%m-%dT%H:%M:%S%:z'], ['ns', '%Y-%m-%dT%H:%M:%S,%N%:z'],
];
const RFC3339_FORMATS: readonly (readonly [string, string])[] = [
  ['date', '%Y-%m-%d'], ['seconds', '%Y-%m-%d %H:%M:%S%:z'], ['ns', '%Y-%m-%d %H:%M:%S.%N%:z'],
];
const RFC_EMAIL = '%a, %d %b %Y %H:%M:%S %z';
const DEFAULT_FORMAT = '%a %b %e %H:%M:%S %Z %Y';

function withZonePrefix(spec: string, fallback: string | undefined): { spec: string; zone: string | undefined } {
  const match = /^\s*TZ="([^"]*)"\s*(.*)$/.exec(spec);
  if (match === null) return { spec, zone: fallback };
  return { spec: match[2], zone: TimeZone.parse(match[1]) === null ? fallback : match[1] };
}

export function runDate(args: readonly string[], timezone: string | undefined, host: DateHost): CoreutilsRun {
  const streams = new Streams();
  let forceUtc = false;
  let dateSpec: string | null = null;
  let fileName: string | null = null;
  let reference: string | null = null;
  let setSpec: string | null = null;
  let format: string | null = null;
  let styled: string | null = null;
  const operands: string[] = [];
  const fail = (message: string): CoreutilsRun => {
    const failed = new Streams();
    failed.diagnostic(message);
    failed.exitCode = 1;
    return failed.result();
  };
  const style = (value: string): CoreutilsRun | null => {
    if (styled !== null && styled !== value) return usageFailure('date', 'date: multiple output formats specified');
    styled = value;
    return null;
  };
  for (const item of shortOptions(args, 'd:f:I::r:Rs:u', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('date', getoptDiagnostic('date', item));
    const value = item.argument ?? '';
    let conflict: CoreutilsRun | null = null;
    switch (item.letter) {
      case 'H': return docsResult('date', 'help');
      case 'V': return docsResult('date', 'version');
      case 'd': dateSpec = value; break;
      case 'f': fileName = value; break;
      case 'r': reference = value; break;
      case 's': setSpec = value; break;
      case 'u': forceUtc = true; break;
      case 'R': case 'e': conflict = style(RFC_EMAIL); break;
      case 'I': {
        const matched = matchArgument(item.argument ?? 'date', ISO_FORMATS);
        if (matched === 'invalid' || matched === 'ambiguous') {
          return usageFailure('date', argumentFailure('date', matched, item.argument ?? '', '--iso-8601', ISO_FORMATS.map(([name]) => name)));
        }
        conflict = style(matched);
        break;
      }
      case '3': {
        const matched = matchArgument(value, RFC3339_FORMATS);
        if (matched === 'invalid' || matched === 'ambiguous') {
          return usageFailure('date', argumentFailure('date', matched, value, '--rfc-3339', RFC3339_FORMATS.map(([name]) => name)));
        }
        conflict = style(matched);
        break;
      }
      default: break;
    }
    if (conflict !== null) return conflict;
  }
  let positionalSet: string | null = null;
  if (operands.length > 0) {
    if (operands[0].startsWith('+')) format = operands[0].slice(1);
    else positionalSet = operands[0];
    if (operands.length > 1) return usageFailure('date', `date: extra operand ${quoteLocale(operands[1])}`);
  }
  if (format !== null && styled !== null) return usageFailure('date', 'date: multiple output formats specified');
  if ((dateSpec !== null ? 1 : 0) + (fileName !== null ? 1 : 0) + (reference !== null ? 1 : 0) > 1) {
    return usageFailure('date', 'date: the options to specify dates for printing are mutually exclusive');
  }
  if (setSpec !== null && (dateSpec !== null || fileName !== null || reference !== null)) {
    return usageFailure('date', 'date: the options to print and set the time may not be used together');
  }
  const zone = forceUtc ? undefined : timezone;
  const layout = styled ?? format ?? DEFAULT_FORMAT;
  const show = (atMs: number, zoneName: string | undefined): void => {
    streams.stdout(`${formatLocalTime(layout, atMs, zoneName)}\n`);
  };
  if (fileName !== null) {
    const lines = host.readLines(fileName);
    if (lines === null) return fail(`date: ${fileName}: No such file or directory`);
    for (const line of lines) {
      const prefixed = withZonePrefix(line, zone);
      const parsed = parseDateSpec(prefixed.spec, host.nowMs, prefixed.zone);
      if (parsed === null) {
        streams.diagnostic(`date: invalid date ${quoteLocale(line)}`);
        streams.exitCode = 1;
        continue;
      }
      show(parsed.getTime(), zone);
    }
    return streams.result();
  }
  let at = host.nowMs;
  if (reference !== null) {
    const mtime = host.fileMtimeMs(reference);
    if (mtime === null) return fail(`date: ${reference}: No such file or directory`);
    at = mtime;
  } else if (dateSpec !== null) {
    const prefixed = withZonePrefix(dateSpec, zone);
    const parsed = parseDateSpec(prefixed.spec, host.nowMs, prefixed.zone);
    if (parsed === null) return fail(`date: invalid date ${quoteLocale(dateSpec)}`);
    at = parsed.getTime();
  }
  const wanted = setSpec ?? (positionalSet === null ? null : positionalSetSpec(positionalSet, host.nowMs) ?? positionalSet);
  if (wanted !== null) {
    const parsed = parseDateSpec(wanted, host.nowMs, zone);
    if (parsed === null) return fail(`date: invalid date ${quoteLocale(setSpec ?? positionalSet ?? wanted)}`);
    at = parsed.getTime();
    if (host.mayStepClock) host.setClock(at);
    else {
      streams.diagnostic('date: cannot set date: Operation not permitted');
      streams.exitCode = 1;
    }
  }
  show(at, zone);
  return streams.result();
}
