/**
 * Search commands: find, locate, which, whereis, command
 */

import { ShellContext } from './LinuxFileCommands';
import { parseFind, type FindHost } from './FindExpression';

export interface FindResult {
  output: string;
  exitCode: number;
  stderr?: string;
  interleaved?: string;
}

export function cmdFind(ctx: ShellContext, args: string[], host?: FindHost, stdin?: string): FindResult {
  const parsed = parseFind(ctx, args, host, stdin);
  if ('text' in parsed) return { output: parsed.text, exitCode: parsed.exitCode };
  if ('error' in parsed) {
    const diagnostic = `${parsed.error}\n`;
    return { output: '', stderr: diagnostic, interleaved: diagnostic, exitCode: parsed.exitCode };
  }
  const { plan } = parsed;
  const emitError = (message: string): void => {
    plan.output.push({ text: message, terminator: '\n', stream: 'stderr' });
    plan.state.exitCode = 1;
  };
  for (const start of plan.starts) {
    const absStart = ctx.vfs.normalizePath(start, ctx.cwd);
    if (start === '' || (!ctx.vfs.exists(absStart) && ctx.vfs.lstat(absStart) === null)) {
      emitError(`find: '${start}': No such file or directory`);
      continue;
    }
    const typed = start.replace(/\/+$/, '') || '/';
    const displayOf = (path: string): string => {
      const tail = start.startsWith('/') ? path : path === absStart ? typed : `${typed === '/' ? '' : typed}${path.slice(absStart === '/' ? 0 : absStart.length)}`;
      return path === absStart ? start : tail;
    };
    const follow = plan.follow === 'none' && start.length > 1 && start.endsWith('/') ? 'args' : plan.follow;
    const walkOptions = {
      maxdepth: plan.maxdepth, postOrder: plan.postOrder, follow,
      onError: (message: string) => emitError(`find: ${message.split(absStart).join(typed)}`),
      ...(!plan.crossDevices && ctx.deviceOf ? { device: ctx.deviceOf(absStart), deviceOf: ctx.deviceOf } : {}),
    };
    ctx.vfs.walkFind(absStart, walkOptions, (path, inode, depth, link) => {
      if (plan.mindepth !== undefined && depth < plan.mindepth) return;
      const run = { path, display: displayOf(path), start, inode, link, depth, prune: false, quit: false };
      plan.expression(run);
      if (run.quit) return 'stop';
      return run.prune ? 'prune' : undefined;
    });
  }
  plan.finish();
  for (const [path, content] of plan.files) ctx.vfs.writeFile(path, content, ctx.uid, ctx.gid, 0o022);
  const render = (stream: 'stdout' | 'stderr' | 'both'): string => plan.output
    .filter((record) => stream === 'both' || record.stream === stream)
    .map((record) => record.text + record.terminator).join('');
  const stdout = render('stdout');
  const stderr = render('stderr');
  const result: FindResult = { output: stdout, exitCode: plan.state.exitCode };
  if (stderr !== '') {
    result.stderr = stderr;
    result.interleaved = render('both');
  }
  return result;
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
