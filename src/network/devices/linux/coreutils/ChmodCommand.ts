import { applyMode, compileMode, type ModeSpec } from '../ChmodMode';
import { getoptDiagnostic } from '../commands/Getopt';
import type { ShellContext } from '../LinuxFileCommands';
import type { INode } from '../VirtualFileSystem';
import { Streams, docsResult, quoteLocale, quoteShell, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const MODE_LETTERS = 'rwxXstugoa,+=01234567';
const LONG_NAMES = ['changes', 'silent', 'quiet', 'verbose', 'recursive', 'reference', 'no-preserve-root', 'preserve-root', 'help', 'version'] as const;

interface ChmodOptions {
  report: 'none' | 'changes' | 'verbose';
  quiet: boolean;
  recursive: boolean;
  reference: string | null;
}

function modeString(ctx: ShellContext, inode: INode, permissions: number): string {
  return ctx.vfs.formatPermissions({ ...inode, permissions }).slice(1);
}

export function runChmod(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  const options: ChmodOptions = { report: 'none', quiet: false, recursive: false, reference: null };
  const operands: string[] = [];
  let modeText: string | null = null;
  let parsing = true;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!parsing || token === '-' || !token.startsWith('-')) { operands.push(token); continue; }
    if (token === '--') { parsing = false; continue; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = token.slice(2, eq < 0 ? undefined : eq);
      const matches = LONG_NAMES.filter((candidate) => candidate === name || candidate.startsWith(name));
      const exact = LONG_NAMES.find((candidate) => candidate === name);
      const picked = exact ?? (matches.length === 1 ? matches[0] : undefined);
      if (picked === undefined) return usageFailure('chmod', getoptDiagnostic('chmod', { kind: 'unrecognized', token }));
      switch (picked) {
        case 'help': return docsResult('chmod', 'help');
        case 'version': return docsResult('chmod', 'version');
        case 'changes': options.report = 'changes'; break;
        case 'verbose': options.report = 'verbose'; break;
        case 'silent': case 'quiet': options.quiet = true; break;
        case 'recursive': options.recursive = true; break;
        case 'reference':
          if (eq >= 0) options.reference = token.slice(eq + 1);
          else if (i + 1 < args.length) options.reference = args[++i];
          else return usageFailure('chmod', getoptDiagnostic('chmod', { kind: 'missing-argument', letter: 'r', long: 'reference' }));
          break;
        default:
          if (eq >= 0) return usageFailure('chmod', getoptDiagnostic('chmod', { kind: 'needless-argument', long: picked }));
          break;
      }
      continue;
    }
    if (MODE_LETTERS.includes(token[1])) { modeText = token; parsing = false; continue; }
    for (let j = 1; j < token.length; j++) {
      switch (token[j]) {
        case 'c': options.report = 'changes'; break;
        case 'v': options.report = 'verbose'; break;
        case 'f': options.quiet = true; break;
        case 'R': options.recursive = true; break;
        default: return usageFailure('chmod', getoptDiagnostic('chmod', { kind: 'invalid', letter: token[j] }));
      }
    }
  }
  const needsMode = options.reference === null;
  if (needsMode && modeText === null) modeText = operands.shift() ?? null;
  if (operands.length === 0) {
    const missing = needsMode ? modeText : options.reference;
    return usageFailure('chmod', missing === null ? 'chmod: missing operand' : `chmod: missing operand after ${quoteLocale(missing)}`);
  }
  if (!needsMode && modeText !== null) return usageFailure('chmod', 'chmod: cannot combine mode and --reference options');

  const streams = new Streams();
  let spec: ModeSpec | null = null;
  let referenceMode = 0;
  if (needsMode) {
    spec = compileMode(modeText as string);
    if (spec === null) return usageFailure('chmod', `chmod: invalid mode: ${quoteLocale(modeText as string)}`);
  } else {
    const reference = ctx.vfs.resolveInode(ctx.vfs.normalizePath(options.reference as string, ctx.cwd), true);
    if (reference === null) {
      streams.diagnostic(`chmod: failed to get attributes of ${quoteShell(options.reference as string)}: No such file or directory`);
      streams.exitCode = 1;
      return streams.result();
    }
    referenceMode = reference.permissions & 0o7777;
  }

  const apply = (shown: string, absPath: string, inode: INode): void => {
    if (ctx.uid !== 0 && inode.uid !== ctx.uid) {
      if (!options.quiet) streams.diagnostic(`chmod: changing permissions of ${quoteShell(shown)}: Operation not permitted`);
      streams.exitCode = 1;
      return;
    }
    const before = inode.permissions & 0o7777;
    const after = spec === null ? referenceMode : applyMode(spec, before, inode.type === 'directory', ctx.umask);
    if (after !== before) ctx.vfs.chmod(absPath, (inode.permissions & ~0o7777) | after);
    const octal = (mode: number): string => mode.toString(8).padStart(4, '0');
    if (after !== before && options.report !== 'none') {
      streams.stdout(`mode of ${quoteShell(shown)} changed from ${octal(before)} (${modeString(ctx, inode, before)}) to ${octal(after)} (${modeString(ctx, inode, after)})\n`);
    } else if (options.report === 'verbose') {
      streams.stdout(`mode of ${quoteShell(shown)} retained as ${octal(before)} (${modeString(ctx, inode, before)})\n`);
    }
  };
  const walk = (shown: string, absPath: string): void => {
    const entries = ctx.vfs.listDirectory(absPath);
    if (entries === null) return;
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const childShown = `${shown.replace(/\/+$/, '')}/${entry.name}`;
      const childPath = `${absPath.replace(/\/$/, '')}/${entry.name}`;
      const child = ctx.vfs.resolveInode(childPath, false);
      if (child === null || child.type === 'symlink') continue;
      apply(childShown, childPath, child);
      if (child.type === 'directory') walk(childShown, childPath);
    }
  };
  for (const operand of operands) {
    const absPath = ctx.vfs.normalizePath(operand, ctx.cwd);
    const inode = ctx.vfs.resolveInode(absPath, true);
    if (inode === null) {
      const link = ctx.vfs.resolveInode(absPath, false);
      if (!options.quiet) {
        streams.diagnostic(link !== null && link.type === 'symlink'
          ? `chmod: cannot operate on dangling symlink ${quoteShell(operand)}`
          : `chmod: cannot access ${quoteShell(operand)}: No such file or directory`);
      }
      streams.exitCode = 1;
      continue;
    }
    apply(operand, absPath, inode);
    if (options.recursive && inode.type === 'directory') walk(operand, absPath);
  }
  return streams.result();
}
