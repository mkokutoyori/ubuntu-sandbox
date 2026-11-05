import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import { Streams, docsResult, quoteLocale, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

function operandsOf(program: string, args: readonly string[]): { operands: string[] } | CoreutilsRun {
  const operands: string[] = [];
  for (const item of shortOptions(args, '', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure(program, getoptDiagnostic(program, item));
    return docsResult(program, item.letter === 'H' ? 'help' : 'version');
  }
  return { operands };
}

function failure(line: string): CoreutilsRun {
  const streams = new Streams();
  streams.diagnostic(line);
  streams.exitCode = 1;
  return streams.result();
}

export function runLink(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  const parsed = operandsOf('link', args);
  if (!('operands' in parsed)) return parsed;
  const { operands } = parsed;
  if (operands.length === 0) return usageFailure('link', 'link: missing operand');
  if (operands.length === 1) return usageFailure('link', `link: missing operand after ${quoteLocale(operands[0])}`);
  if (operands.length > 2) return usageFailure('link', `link: extra operand ${quoteLocale(operands[2])}`);
  const [source, destination] = operands;
  const cannot = (reason: string): CoreutilsRun => failure(`link: cannot create link ${quoteLocale(destination)} to ${quoteLocale(source)}: ${reason}`);
  const actor = actorOf(ctx);
  const sourcePath = ctx.vfs.path(source, ctx.cwd, actor);
  const sourceNode = sourcePath.lstatNode();
  if (sourceNode === null) return cannot('No such file or directory');
  if (sourceNode.type === 'directory') return cannot('Operation not permitted');
  const destinationPath = ctx.vfs.path(destination, ctx.cwd, actor);
  if (destinationPath.lstatNode() !== null) return cannot('File exists');
  const parent = destinationPath.parent().inode();
  if (parent === null) return cannot('No such file or directory');
  if (parent.type !== 'directory') return cannot('Not a directory');
  if (ctx.uid !== 0 && !destinationPath.parent().isWritableDir()) return cannot('Permission denied');
  if (!ctx.vfs.createHardLink(destinationPath.value, sourcePath.value)) return cannot('Invalid cross-device link');
  return new Streams().result();
}

export function runUnlink(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  const parsed = operandsOf('unlink', args);
  if (!('operands' in parsed)) return parsed;
  const { operands } = parsed;
  if (operands.length === 0) return usageFailure('unlink', 'unlink: missing operand');
  if (operands.length > 1) return usageFailure('unlink', `unlink: extra operand ${quoteLocale(operands[1])}`);
  const cannot = (reason: string): CoreutilsRun => failure(`unlink: cannot unlink ${quoteLocale(operands[0])}: ${reason}`);
  const path = ctx.vfs.path(operands[0], ctx.cwd, actorOf(ctx));
  const node = path.lstatNode();
  if (node === null) return cannot('No such file or directory');
  if (node.type === 'directory') return cannot('Is a directory');
  if (ctx.uid !== 0 && (!path.parent().canWrite() || !path.parent().canExecute())) return cannot('Permission denied');
  ctx.vfs.deleteFile(path.value);
  return new Streams().result();
}
