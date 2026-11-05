import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, quoteLocale, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'input', letter: 'i', takesArgument: true },
  { name: 'output', letter: 'o', takesArgument: true },
  { name: 'error', letter: 'e', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export const STDBUF_PRELOAD = '/usr/libexec/coreutils/libstdbuf.so';
export const STDBUF_FAILURE = 125;

const SUFFIXES: Readonly<Record<string, bigint>> = {
  K: 1024n, M: 1024n ** 2n, G: 1024n ** 3n, T: 1024n ** 4n, P: 1024n ** 5n, E: 1024n ** 6n,
  KB: 1000n, MB: 1000n ** 2n, GB: 1000n ** 3n, TB: 1000n ** 4n, PB: 1000n ** 5n, EB: 1000n ** 6n,
};

type Mode = { kind: 'ok'; value: string } | { kind: 'invalid'; reason: string };

function parseMode(text: string): Mode {
  if (text === 'L') return { kind: 'ok', value: 'L' };
  const match = /^(\d*)([A-Za-z]*)$/.exec(text);
  if (match === null || (match[1] === '' && match[2] === '')) return { kind: 'invalid', reason: '' };
  const suffix = match[2] === '' ? 1n : SUFFIXES[match[2].toUpperCase()];
  if (suffix === undefined || (match[2].length === 2 && match[2][1] !== 'B') || match[2].length > 2) return { kind: 'invalid', reason: '' };
  const value = (match[1] === '' ? 1n : BigInt(match[1])) * suffix;
  if (value > 0xffffffffffffffffn) return { kind: 'invalid', reason: ': Value too large for defined data type' };
  return { kind: 'ok', value: String(value) };
}

export interface StdbufPlan {
  readonly env: Record<string, string>;
  readonly command: string[];
}

export function planStdbuf(program: string, args: readonly string[], inherited: Record<string, string>): StdbufPlan | CoreutilsRun {
  const env: Record<string, string> = {};
  const command: string[] = [];
  let specified = false;
  const failure = (lines: string[], withTry: boolean): CoreutilsRun => {
    const streams = new Streams();
    for (const line of lines) streams.diagnostic(line);
    if (withTry) streams.diagnostic(`Try '${program} --help' for more information.`);
    streams.exitCode = STDBUF_FAILURE;
    return streams.result();
  };
  for (const item of shortOptions(['+', ...args].slice(1), '+i:o:e:', LONG_OPTIONS)) {
    if (item.kind === 'operand') { command.push(item.value); continue; }
    if (item.kind !== 'option') {
      const text = getoptDiagnostic(program, item).replace(/\nTry .*$/s, '');
      return failure([text], true);
    }
    if (item.letter === 'H') return docsResult(program, 'help');
    if (item.letter === 'V') return docsResult(program, 'version');
    const text = item.argument ?? '';
    const mode = parseMode(text);
    if (mode.kind === 'invalid') return failure([`${program}: invalid mode ${quoteLocale(text)}${mode.reason}`], false);
    if (item.letter === 'i' && mode.value === 'L') return failure([`${program}: line buffering stdin is meaningless`], true);
    env[`_STDBUF_${item.letter.toUpperCase()}`] = mode.value;
    specified = true;
  }
  if (command.length === 0) return failure([`${program}: missing operand`], true);
  if (!specified) return failure([`${program}: you must specify a buffering mode option`], true);
  env.LD_PRELOAD = inherited.LD_PRELOAD === undefined || inherited.LD_PRELOAD === '' ? STDBUF_PRELOAD : `${inherited.LD_PRELOAD}:${STDBUF_PRELOAD}`;
  return { env, command };
}
