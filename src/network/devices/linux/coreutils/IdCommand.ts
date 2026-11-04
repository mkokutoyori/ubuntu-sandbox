import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import type { ShellContext } from '../LinuxFileCommands';
import { Streams, docsResult, quoteLocale, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'context', letter: 'Z', takesArgument: false },
  { name: 'group', letter: 'g', takesArgument: false },
  { name: 'groups', letter: 'G', takesArgument: false },
  { name: 'name', letter: 'n', takesArgument: false },
  { name: 'real', letter: 'r', takesArgument: false },
  { name: 'user', letter: 'u', takesArgument: false },
  { name: 'zero', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export function runId(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  const flags = { u: false, g: false, G: false, n: false, r: false };
  let zero = false;
  let context = false;
  const specs: string[] = [];
  for (const item of shortOptions(args, 'agnruzGZ', LONG_OPTIONS)) {
    if (item.kind === 'operand') { specs.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('id', getoptDiagnostic('id', item));
    switch (item.letter) {
      case 'H': return docsResult('id', 'help');
      case 'V': return docsResult('id', 'version');
      case 'Z': {
        const streams = new Streams();
        streams.diagnostic('id: --context (-Z) works only on an SELinux-enabled kernel');
        streams.exitCode = 1;
        return streams.result();
      }
      case 'z': zero = true; break;
      case 'u': case 'g': case 'G': case 'n': case 'r': flags[item.letter] = true; break;
      default: break;
    }
  }
  const streams = new Streams();
  const refuse = (line: string): CoreutilsRun => {
    streams.diagnostic(`id: ${line}`);
    streams.exitCode = 1;
    return streams.result();
  };
  if (Number(flags.u) + Number(flags.g) + Number(flags.G) + Number(context) > 1) return refuse('cannot print "only" of more than one choice');
  const defaultFormat = !(flags.u || flags.g || flags.G || context);
  if (defaultFormat && (flags.r || flags.n)) return refuse('cannot print only names or real IDs in default format');
  if (defaultFormat && zero) return refuse('option --zero not permitted in default format');
  const targets: (string | undefined)[] = specs.length === 0 ? [undefined] : specs;
  const separator = zero ? '\0' : ' ';
  for (const spec of targets) {
    let name = spec;
    if (spec !== undefined) {
      const byNumber = /^\d+$/.test(spec) ? ctx.userMgr.getUserByUid(Number(spec)) : undefined;
      name = byNumber?.username ?? spec;
      if (spec === '' || ctx.userMgr.getUser(name) === undefined) {
        streams.diagnostic(`id: ${quoteLocale(spec)}: no such user${spec === '' ? ': No such file or directory' : ''}`);
        streams.exitCode = 1;
        continue;
      }
    }
    const text = defaultFormat ? ctx.userMgr.id(name) : ctx.userMgr.idWithFlags(name, flags);
    if (text.startsWith('id: ')) {
      streams.diagnostic(text);
      streams.exitCode = 1;
      continue;
    }
    streams.stdout(flags.G ? text.split(' ').join(separator) : text);
    streams.stdout(zero && flags.G && specs.length > 1 ? '\0\0' : zero ? '\0' : '\n');
  }
  return streams.result();
}
