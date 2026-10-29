/**
 * Search commands: find, locate, which, whereis, command
 */

import { ShellContext } from './LinuxFileCommands';
import { parseFind } from './FindExpression';

export function cmdFind(ctx: ShellContext, args: string[]): string {
  const parsed = parseFind(ctx, args);
  if ('error' in parsed) return parsed.error;
  const { plan } = parsed;
  const errors: string[] = [];
  for (const start of plan.starts) {
    const absStart = ctx.vfs.normalizePath(start, ctx.cwd);
    if (!ctx.vfs.exists(absStart) && ctx.vfs.lstat(absStart) === null) {
      errors.push(`find: '${start}': No such file or directory`);
      continue;
    }
    const typed = start.replace(/\/+$/, '') || '/';
    const displayOf = (path: string): string => {
      if (start.startsWith('/')) return path;
      return path === absStart ? typed : `${typed === '/' ? '' : typed}${path.slice(absStart === '/' ? 0 : absStart.length)}`;
    };
    const walkOptions = {
      maxdepth: plan.maxdepth, postOrder: plan.postOrder,
      ...(!plan.crossDevices && ctx.deviceOf ? { device: ctx.deviceOf(absStart), deviceOf: ctx.deviceOf } : {}),
    };
    ctx.vfs.walkFind(absStart, walkOptions, (path, inode, depth) => {
      if (plan.mindepth !== undefined && depth < plan.mindepth) return;
      const run = { path, display: displayOf(path), start: typed, inode, depth, prune: false, quit: false };
      plan.expression(run);
      if (run.quit) return 'stop';
      return run.prune ? 'prune' : undefined;
    });
  }
  const text = plan.output.map((record) => record.text + record.terminator).join('');
  return [...errors, text.replace(/\n$/, '')].filter((part) => part !== '').join('\n');
}

export function cmdLocate(ctx: ShellContext, args: string[]): string {
  const patterns: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) continue;
    patterns.push(a);
  }
  if (patterns.length === 0) return '';

  const pattern = patterns[0];
  // Search entire filesystem
  const allFiles = ctx.vfs.find('/', {});
  const matches = allFiles.filter(f => {
    if (pattern.includes('*') || pattern.includes('?')) {
      const basename = f.split('/').pop() || '';
      return ctx.vfs.globMatch(basename, pattern.replace(/"/g, ''));
    }
    return f.includes(pattern.replace(/"/g, ''));
  });

  return matches.join('\n');
}

/**
 * `command` — resolve / describe a command name, used here for the
 * `-v` (terse path) and `-V` (verbose) introspection forms. Execution
 * with no flag is handled by the bash interpreter, which bypasses
 * function and alias lookup; this dispatcher path only answers queries.
 */
export function cmdCommand(
  ctx: ShellContext,
  args: string[],
  knownCommands?: ReadonlySet<string>,
): { output: string; exitCode: number } {
  let verbose = false;
  let vOnly = false;
  let i = 0;
  for (; i < args.length; i++) {
    if (args[i] === '-v') { vOnly = true; continue; }
    if (args[i] === '-V') { verbose = true; continue; }
    if (args[i] === '-p') continue;            // "default PATH" — accepted
    if (args[i] === '--') { i++; break; }
    break;
  }
  const name = args[i];
  if (!name) return { output: '', exitCode: 0 };

  const path = resolveCommandPath(ctx, name, knownCommands);
  if (vOnly || verbose) {
    if (!path) {
      return { output: verbose ? `bash: command: ${name}: not found\n` : '', exitCode: 1 };
    }
    return { output: verbose ? `${name} is ${path}\n` : `${path}\n`, exitCode: 0 };
  }
  // `command name …` reaching the dispatcher (interpreter bypassed):
  // there is nothing to run from here, so just report resolvability.
  return path
    ? { output: '', exitCode: 0 }
    : { output: `${name}: command not found\n`, exitCode: 127 };
}

/** Resolve a command name to a filesystem path, or null when unknown. */
function resolveCommandPath(
  ctx: ShellContext,
  name: string,
  knownCommands?: ReadonlySet<string>,
): string | null {
  // Absolute / relative path → consult the VFS directly.
  if (name.includes('/')) {
    return ctx.vfs.exists(ctx.vfs.normalizePath(name, ctx.cwd)) ? name : null;
  }
  // Standard bin directories on the VFS.
  for (const dir of ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (ctx.vfs.exists(`${dir}/${name}`)) return `${dir}/${name}`;
  }
  // A simulator-provided command → synthesize its conventional path.
  if (knownCommands?.has(name)) return `/usr/bin/${name}`;
  return null;
}

export function cmdUpdatedb(ctx: ShellContext): string {
  // No-op in our simulator - locate searches live
  return '';
}
