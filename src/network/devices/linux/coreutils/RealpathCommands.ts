import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import { canonicalize, relativePath, type Existence } from './CanonicalPath';
import { Streams, docsResult, quotef, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const READLINK_LONG: readonly LongOption[] = [
  { name: 'canonicalize', letter: 'f', takesArgument: false },
  { name: 'canonicalize-existing', letter: 'e', takesArgument: false },
  { name: 'canonicalize-missing', letter: 'm', takesArgument: false },
  { name: 'no-newline', letter: 'n', takesArgument: false },
  { name: 'quiet', letter: 'q', takesArgument: false },
  { name: 'silent', letter: 's', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'zero', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const REALPATH_LONG: readonly LongOption[] = [
  { name: 'canonicalize-existing', letter: 'e', takesArgument: false },
  { name: 'canonicalize-missing', letter: 'm', takesArgument: false },
  { name: 'logical', letter: 'L', takesArgument: false },
  { name: 'physical', letter: 'P', takesArgument: false },
  { name: 'quiet', letter: 'q', takesArgument: false },
  { name: 'relative-to', letter: 'T', takesArgument: true },
  { name: 'relative-base', letter: 'B', takesArgument: true },
  { name: 'strip', letter: 's', takesArgument: false },
  { name: 'no-symlinks', letter: 's', takesArgument: false },
  { name: 'zero', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export function runReadlink(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  let mode: Existence | null = null;
  let noNewline = false;
  let verbose = false;
  let terminator = '\n';
  const operands: string[] = [];
  for (const item of shortOptions(args, 'femnqsvz', READLINK_LONG)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('readlink', getoptDiagnostic('readlink', item));
    switch (item.letter) {
      case 'H': return docsResult('readlink', 'help');
      case 'V': return docsResult('readlink', 'version');
      case 'f': mode = 'parents'; break;
      case 'e': mode = 'all'; break;
      case 'm': mode = 'none'; break;
      case 'n': noNewline = true; break;
      case 'q': case 's': verbose = false; break;
      case 'v': verbose = true; break;
      case 'z': terminator = '\0'; break;
      default: break;
    }
  }
  if (operands.length === 0) return usageFailure('readlink', 'readlink: missing operand');
  const streams = new Streams();
  if (noNewline && operands.length > 1) streams.diagnostic('readlink: ignoring --no-newline with multiple arguments');
  const suffix = noNewline && operands.length === 1 ? '' : terminator;
  const actor = actorOf(ctx);
  for (const operand of operands) {
    let text: string | null = null;
    let reason = 'Invalid argument';
    if (mode === null) {
      const node = ctx.vfs.path(operand, ctx.cwd, actor).lstatNode();
      if (node === null) reason = 'No such file or directory';
      else if (node.type === 'symlink') text = ctx.vfs.linkTarget(node);
    } else {
      const result = canonicalize(ctx.vfs, operand, ctx.cwd, mode, { logical: false, stripSymlinks: false });
      if ('path' in result) text = result.path; else reason = result.error;
    }
    if (text === null) {
      if (verbose) streams.diagnostic(`readlink: ${quotef(operand)}: ${reason}`);
      streams.exitCode = 1;
      continue;
    }
    streams.stdout(`${text}${suffix}`);
  }
  return streams.result();
}

export function runRealpath(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  let existence: Existence = 'parents';
  let quiet = false;
  let logical = false;
  let strip = false;
  let relativeTo: string | null = null;
  let relativeBase: string | null = null;
  let terminator = '\n';
  const operands: string[] = [];
  for (const item of shortOptions(args, 'emLPqsz', REALPATH_LONG)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('realpath', getoptDiagnostic('realpath', item));
    switch (item.letter) {
      case 'H': return docsResult('realpath', 'help');
      case 'V': return docsResult('realpath', 'version');
      case 'e': existence = 'all'; break;
      case 'm': existence = 'none'; break;
      case 'L': logical = true; break;
      case 'P': logical = false; strip = false; break;
      case 'q': quiet = true; break;
      case 's': strip = true; break;
      case 'z': terminator = '\0'; break;
      case 'T': relativeTo = item.argument ?? null; break;
      case 'B': relativeBase = item.argument ?? null; break;
      default: break;
    }
  }
  if (operands.length === 0) return usageFailure('realpath', 'realpath: missing operand');
  const streams = new Streams();
  const options = { logical, stripSymlinks: strip };
  const resolveDirectory = (name: string): string | null => {
    const result = canonicalize(ctx.vfs, name, ctx.cwd, existence === 'none' ? 'none' : 'all', options);
    return 'path' in result ? result.path : null;
  };
  const to = relativeTo === null ? null : resolveDirectory(relativeTo);
  const base = relativeBase === null ? null : resolveDirectory(relativeBase);
  const under = (path: string, root: string): boolean => root === '/' || path === root || path.startsWith(`${root}/`);
  for (const operand of operands) {
    const result = canonicalize(ctx.vfs, operand, ctx.cwd, existence, options);
    if ('error' in result) {
      if (!quiet) streams.diagnostic(`realpath: ${quotef(operand)}: ${result.error}`);
      streams.exitCode = 1;
      continue;
    }
    let text = result.path;
    const anchor = to ?? base;
    if (anchor !== null && (base === null || under(text, base)) && (to === null || base === null || under(to, base))) {
      text = relativePath(text, to ?? anchor);
    }
    streams.stdout(`${text}${terminator}`);
  }
  return streams.result();
}
