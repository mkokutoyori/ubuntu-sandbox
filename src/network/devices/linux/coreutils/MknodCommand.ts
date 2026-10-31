import { applyMode, compileMode } from '../ChmodMode';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import { Streams, docsResult, quoteShell, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'mode', letter: 'm', takesArgument: true },
  { name: 'context', letter: 'Z', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const DEVICE_NUMBER_LIMIT = 0xffffffffn;

function deviceNumber(text: string): number | null {
  if (!/^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.test(text)) return null;
  const value = BigInt(/^0[0-7]+$/.test(text) ? `0o${text.slice(1)}` : text);
  return value > DEVICE_NUMBER_LIMIT ? null : Number(value);
}

export function runMknod(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  let modeText: string | null = null;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'm:Z', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('mknod', getoptDiagnostic('mknod', item));
    switch (item.letter) {
      case 'H': return docsResult('mknod', 'help');
      case 'V': return docsResult('mknod', 'version');
      case 'm': modeText = item.argument ?? ''; break;
      default: break;
    }
  }
  const streams = new Streams();
  if (operands.length === 0) return usageFailure('mknod', 'mknod: missing operand');
  if (operands.length === 1) return usageFailure('mknod', `mknod: missing operand after ${quoteShell(operands[0])}`);
  const typeWord = operands[1];
  const kind = typeWord === 'b' ? 'blockdev' : typeWord === 'c' || typeWord === 'u' ? 'chardev' : typeWord === 'p' ? 'fifo' : null;
  if (kind === null) return usageFailure('mknod', `mknod: invalid device type ${quoteShell(typeWord)}`);
  let finalMode = 0o666 & ~ctx.umask;
  if (modeText !== null) {
    const spec = compileMode(modeText);
    if (spec === null) {
      streams.diagnostic('mknod: invalid mode');
      streams.exitCode = 1;
      return streams.result();
    }
    finalMode = applyMode(spec, 0o666, false, ctx.umask);
  }
  let major = 0;
  let minor = 0;
  if (kind === 'fifo') {
    if (operands.length > 2) {
      const lines = [`mknod: extra operand ${quoteShell(operands[2])}`];
      if (operands.length === 4) lines.push('Fifos do not have major and minor device numbers.');
      return usageFailure('mknod', lines.join('\n'));
    }
  } else {
    if (operands.length < 4) {
      const lines = [`mknod: missing operand after ${quoteShell(operands[operands.length - 1])}`];
      if (operands.length === 2) lines.push('Special files require major and minor device numbers.');
      return usageFailure('mknod', lines.join('\n'));
    }
    if (operands.length > 4) return usageFailure('mknod', `mknod: extra operand ${quoteShell(operands[4])}`);
    const parsedMajor = deviceNumber(operands[2]);
    if (parsedMajor === null) return failure(streams, `mknod: invalid major device number ${quoteShell(operands[2])}`);
    const parsedMinor = deviceNumber(operands[3]);
    if (parsedMinor === null) return failure(streams, `mknod: invalid minor device number ${quoteShell(operands[3])}`);
    major = parsedMajor;
    minor = parsedMinor;
    if (ctx.uid !== 0) return failure(streams, `mknod: ${operands[0]}: Operation not permitted`);
  }
  const path = ctx.vfs.path(operands[0], ctx.cwd, actorOf(ctx));
  if (path.exists() || path.lexists()) return failure(streams, `mknod: ${operands[0]}: File exists`);
  const parent = path.parent().inode();
  if (parent === null) return failure(streams, `mknod: ${operands[0]}: No such file or directory`);
  if (parent.type !== 'directory') return failure(streams, `mknod: ${operands[0]}: Not a directory`);
  if (ctx.uid !== 0 && !path.parent().isWritableDir()) return failure(streams, `mknod: ${operands[0]}: Permission denied`);
  const created = kind === 'fifo'
    ? ctx.vfs.createFifo(path.value, finalMode, ctx.uid, ctx.gid)
    : ctx.vfs.createDevice(path.value, kind, major, minor, finalMode, ctx.uid, ctx.gid);
  if (!created) return failure(streams, `mknod: ${operands[0]}: No such file or directory`);
  return streams.result();
}

function failure(streams: Streams, line: string): CoreutilsRun {
  streams.diagnostic(line);
  streams.exitCode = 1;
  return streams.result();
}
