import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import { Streams, docsResult, quoteLocale, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'data', letter: 'd', takesArgument: false },
  { name: 'file-system', letter: 'f', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export function runSync(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  let dataOnly = false;
  let fileSystem = false;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'df', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('sync', getoptDiagnostic('sync', item));
    if (item.letter === 'H') return docsResult('sync', 'help');
    if (item.letter === 'V') return docsResult('sync', 'version');
    if (item.letter === 'd') dataOnly = true; else fileSystem = true;
  }
  const streams = new Streams();
  const refuse = (line: string): CoreutilsRun => {
    streams.diagnostic(`sync: ${line}`);
    streams.exitCode = 1;
    return streams.result();
  };
  if (dataOnly && fileSystem) return refuse('cannot specify both --data and --file-system');
  if (operands.length === 0 && dataOnly) return refuse('--data needs at least one argument');
  const actor = actorOf(ctx);
  for (const operand of operands) {
    const node = ctx.vfs.path(operand, ctx.cwd, actor).lstatNode();
    if (node === null) {
      streams.diagnostic(`sync: error opening ${quoteLocale(operand)}: No such file or directory`);
      streams.exitCode = 1;
    }
  }
  return streams.result();
}
