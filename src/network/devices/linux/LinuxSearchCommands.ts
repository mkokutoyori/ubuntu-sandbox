/**
 * Search commands: find, locate, which, whereis, command
 */

import { ShellContext } from './LinuxFileCommands';

/** Parse a `-size` argument: `2k`, `+10M`, `-100c`, `1G`. */
function parseSizeSpec(raw: string): { op: '+' | '-' | '='; value: number } | null {
  const m = /^([+-]?)(\d+)([cwbkMGT]?)$/.exec(raw);
  if (!m) return null;
  const [, prefix, numStr, unit] = m;
  const n = parseInt(numStr, 10);
  // GNU find unit conventions: c=bytes, w=2B, b=512B blocks (default),
  // k=1024, M=1024², G=1024³, T=1024⁴. With no unit, the count is in
  // 512-byte blocks (POSIX), which we treat as the same number of bytes
  // for simulator scale.
  const multipliers: Record<string, number> = {
    '': 512,  c: 1,  w: 2,  b: 512,
    k: 1024,  M: 1024 ** 2,  G: 1024 ** 3,  T: 1024 ** 4,
  };
  return { op: prefix === '+' ? '+' : prefix === '-' ? '-' : '=', value: n * multipliers[unit] };
}

export function cmdFind(ctx: ShellContext, args: string[]): string {
  let startPath = '.';
  let name: string | undefined;
  let iname: string | undefined;
  let pathPat: string | undefined;
  let ipathPat: string | undefined;
  let type: 'f' | 'd' | 'l' | undefined;
  let empty = false;
  let mtime: number | undefined;
  let user: string | undefined;
  let group: string | undefined;
  let execCmd: string | undefined;
  let size: { op: '+' | '-' | '='; value: number } | undefined;
  let maxdepth: number | undefined;
  let mindepth: number | undefined;
  let notNext = false;
  let notFlag = false;
  let print0 = false;
  let printFlag = false;
  let deleteFlag = false;

  let i = 0;

  // First non-flag arg is the path. Real find accepts multiple starting
  // points; pick the first to mirror the existing behaviour.
  if (args.length > 0 && !args[0].startsWith('-') && args[0] !== '!') {
    startPath = args[0];
    i = 1;
  }

  while (i < args.length) {
    const a = args[i];
    // `!` is the POSIX synonym for `-not`. Sticky across the next test.
    if (a === '!' || a === '-not') {
      notNext = true;
      i++;
      continue;
    }
    switch (a) {
      case '-name': name = args[++i]; break;
      case '-iname': iname = args[++i]; break;
      case '-path': pathPat = args[++i]; break;
      case '-ipath': ipathPat = args[++i]; break;
      case '-type': {
        const t = args[++i];
        if (t === 'f' || t === 'd' || t === 'l') type = t;
        break;
      }
      case '-empty': empty = true; break;
      case '-mtime': mtime = parseInt(args[++i], 10); break;
      case '-user': user = args[++i]; break;
      case '-group': group = args[++i]; break;
      case '-size': {
        const spec = parseSizeSpec(args[++i] ?? '');
        if (spec) size = spec;
        break;
      }
      case '-maxdepth': maxdepth = parseInt(args[++i], 10); break;
      case '-mindepth': mindepth = parseInt(args[++i], 10); break;
      case '-print': printFlag = true; break;
      case '-print0': print0 = true; break;
      case '-delete': deleteFlag = true; break;
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
    // The not flag, once seen, applies to the *next* predicate only.
    if (notNext && a !== '!' && a !== '-not') {
      notFlag = !notFlag;
      notNext = false;
    }
    i++;
  }

  const absStart = ctx.vfs.normalizePath(startPath, ctx.cwd);

  const opts: any = {};
  if (name) opts.name = name;
  if (iname) opts.iname = iname;
  if (pathPat) opts.path = pathPat;
  if (ipathPat) opts.ipath = ipathPat;
  if (type) opts.type = type;
  if (empty) opts.empty = true;
  if (mtime !== undefined) opts.mtime = mtime;
  if (size) opts.size = size;
  if (maxdepth !== undefined) opts.maxdepth = maxdepth;
  if (mindepth !== undefined) opts.mindepth = mindepth;
  if (notFlag) opts.not = true;
  if (user) {
    const uid = ctx.userMgr.resolveUid(user);
    if (uid >= 0) opts.user = uid;
  }
  if (group) {
    const gid = ctx.userMgr.resolveGid(group);
    if (gid >= 0) opts.group = gid;
  }

  const results = ctx.vfs.find(absStart, opts);

  // -delete unlinks each match before the formatter runs. Real find
  // deletes depth-first; our find emits parents before children so we
  // reverse for the same effect.
  if (deleteFlag) {
    for (const r of [...results].reverse()) {
      const node = ctx.vfs.lstat(r);
      if (!node) continue;
      if (node.type === 'directory') ctx.vfs.rmdir(r);
      else ctx.vfs.deleteFile(r);
    }
  }

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

  // -print0 emits a NUL between matches instead of a newline. Useful when
  // piping into xargs -0 to handle filenames with whitespace.
  if (print0) return displayResults.join('\0');
  if (printFlag || displayResults.length > 0 || !deleteFlag) {
    return displayResults.join('\n');
  }
  return '';
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
