import { applyMode, compileMode } from '../ChmodMode';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, displayedComponent, type ShellContext } from '../LinuxFileCommands';
import { Streams, docsResult, quoteLocale, quoteShell, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'mode', letter: 'm', takesArgument: true },
  { name: 'parents', letter: 'p', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'context', letter: 'Z', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const INTERMEDIATE_BITS = 0o300;

export function mkdirOperands(args: readonly string[]): string[] {
  const operands: string[] = [];
  for (const item of shortOptions(args, 'm:pvZ', LONG_OPTIONS)) if (item.kind === 'operand') operands.push(item.value);
  return operands;
}

export function runMkdir(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  let parents = false;
  let verbose = false;
  let modeText: string | null = null;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'm:pvZ', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('mkdir', getoptDiagnostic('mkdir', item));
    switch (item.letter) {
      case 'H': return docsResult('mkdir', 'help');
      case 'V': return docsResult('mkdir', 'version');
      case 'p': parents = true; break;
      case 'v': verbose = true; break;
      case 'm': modeText = item.argument ?? ''; break;
      default: break;
    }
  }
  if (operands.length === 0) return usageFailure('mkdir', 'mkdir: missing operand');
  const streams = new Streams();
  const defaultMode = 0o777 & ~ctx.umask;
  let finalMode = defaultMode;
  if (modeText !== null) {
    const spec = compileMode(modeText);
    if (spec === null) {
      streams.diagnostic(`mkdir: invalid mode ${quoteLocale(modeText)}`);
      streams.exitCode = 1;
      return streams.result();
    }
    finalMode = applyMode(spec, 0o777, true, ctx.umask);
  }
  const actor = actorOf(ctx);
  const say = (shown: string): void => {
    if (verbose) streams.stdout(`mkdir: created directory ${quoteShell(shown)}\n`);
  };
  const fail = (shown: string, reason: string): void => {
    streams.diagnostic(`mkdir: cannot create directory ${quoteShell(shown)}: ${reason}`);
    streams.exitCode = 1;
  };
  for (const operand of operands) {
    const path = ctx.vfs.path(operand, ctx.cwd, actor);
    const absPath = path.value;
    if (absPath.startsWith('/proc/') && !path.exists()) { fail(operand, 'No such file or directory'); continue; }
    if (parents) {
      if (path.exists()) {
        if (path.type() !== 'directory') fail(operand, 'File exists');
        continue;
      }
      const blocker = (() => {
        for (let probe = path.parent(); probe.value !== '/'; probe = probe.parent()) {
          if (probe.exists()) return probe.type() === 'directory' ? null : probe.value;
        }
        return null;
      })();
      if (blocker !== null) {
        const segments = operand.replace(/\/+$/, '').split('/');
        const depth = absPath.split('/').length - blocker.split('/').length;
        fail(segments.slice(0, Math.max(1, segments.length - depth)).join('/'), 'Not a directory');
        continue;
      }
      if (ctx.uid !== 0) {
        let ancestor = path.parent();
        while (!ancestor.exists() && ancestor.value !== '/') ancestor = ancestor.parent();
        if (!ancestor.isWritableDir()) { fail(operand, 'Permission denied'); continue; }
      }
      const missing: string[] = [];
      for (let probe = absPath; probe !== '/' && !ctx.vfs.exists(probe); probe = probe.slice(0, probe.lastIndexOf('/')) || '/') missing.unshift(probe);
      let blocked = false;
      for (const component of missing) {
        const last = component === absPath;
        const parentType = ctx.vfs.getType(component.slice(0, component.lastIndexOf('/')) || '/');
        if (parentType !== 'directory') { fail(operand, 'Not a directory'); blocked = true; break; }
        ctx.vfs.mkdir(component, last ? finalMode : defaultMode | INTERMEDIATE_BITS, ctx.uid, ctx.gid);
        say(displayedComponent(operand, absPath, missing, component));
      }
      if (blocked) continue;
      continue;
    }
    if (ctx.vfs.exists(absPath) || path.lexists()) { fail(operand, 'File exists'); continue; }
    const parentNode = path.parent().inode();
    if (parentNode !== null && parentNode.type !== 'directory') { fail(operand, 'Not a directory'); continue; }
    if (ctx.uid !== 0 && path.parent().inode() && !path.parent().isWritableDir()) { fail(operand, 'Permission denied'); continue; }
    if (!ctx.vfs.mkdir(absPath, finalMode, ctx.uid, ctx.gid)) {
      if (ctx.vfs.freeInodes() === 0) { fail(operand, 'No space left on device'); continue; }
      const parentType = ctx.vfs.getType(absPath.slice(0, absPath.lastIndexOf('/')) || '/');
      fail(operand, parentType === null ? 'No such file or directory' : 'Not a directory');
      continue;
    }
    say(operand);
  }
  return streams.result();
}
