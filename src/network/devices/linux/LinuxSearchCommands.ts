/**
 * Search commands: find, locate, which, whereis, command
 */

import { ShellContext } from './LinuxFileCommands';

export function cmdFind(ctx: ShellContext, args: string[]): string {
  let startPath = '.';
  let name: string | undefined;
  let type: 'f' | 'd' | 'l' | undefined;
  let empty = false;
  let mtime: number | undefined;
  let user: string | undefined;
  let group: string | undefined;
  let execCmd: string | undefined;

  let i = 0;

  // First non-flag arg is the path
  if (args.length > 0 && !args[0].startsWith('-')) {
    startPath = args[0];
    i = 1;
  }

  while (i < args.length) {
    const a = args[i];
    switch (a) {
      case '-name': name = args[++i]; break;
      case '-type': {
        const t = args[++i];
        if (t === 'f' || t === 'd' || t === 'l') type = t;
        break;
      }
      case '-empty': empty = true; break;
      case '-mtime': mtime = parseInt(args[++i], 10); break;
      case '-user': user = args[++i]; break;
      case '-group': group = args[++i]; break;
      case '-exec': {
        // Collect until \;
        const execParts: string[] = [];
        i++;
        while (i < args.length && args[i] !== '\\;' && args[i] !== ';') {
          execParts.push(args[i]);
          i++;
        }
        execCmd = execParts.join(' ');
        break;
      }
      default: break;
    }
    i++;
  }

  const absStart = ctx.vfs.normalizePath(startPath, ctx.cwd);

  const opts: any = {};
  if (name) opts.name = name;
  if (type) opts.type = type;
  if (empty) opts.empty = true;
  if (mtime !== undefined) opts.mtime = mtime;
  if (user) {
    const uid = ctx.userMgr.resolveUid(user);
    if (uid >= 0) opts.user = uid;
  }
  if (group) {
    const gid = ctx.userMgr.resolveGid(group);
    if (gid >= 0) opts.group = gid;
  }

  const results = ctx.vfs.find(absStart, opts);

  // Convert to relative paths from startPath
  const displayResults = results.map(r => {
    if (startPath.startsWith('/')) return r;
    const cwdPrefix = ctx.cwd === '/' ? '/' : ctx.cwd + '/';
    if (r.startsWith(cwdPrefix)) {
      return r.slice(cwdPrefix.length);
    }
    return r;
  });

  if (execCmd) {
    const outputs: string[] = [];
    for (const f of displayResults) {
      const cmd = execCmd.replace(/\{\}/g, f);
      outputs.push(cmd.replace(/^echo\s+/, '') || f);
    }
    return outputs.join('\n');
  }

  return displayResults.join('\n');
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
