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

export function cmdWhich(ctx: ShellContext, args: string[]): string {
  const results: string[] = [];
  for (const cmd of args) {
    if (cmd.startsWith('-')) continue;
    // Search in standard paths
    const searchPaths = ['/bin', '/usr/bin', '/sbin', '/usr/sbin', '/usr/local/bin'];
    let found = false;
    for (const dir of searchPaths) {
      const path = `${dir}/${cmd}`;
      if (ctx.vfs.exists(path)) {
        results.push(path);
        found = true;
        break;
      }
    }
    if (!found) {
      results.push(`which: no ${cmd} in (/bin:/usr/bin:/sbin:/usr/sbin)`);
    }
  }
  return results.join('\n');
}

export function cmdWhereis(ctx: ShellContext, args: string[]): string {
  const results: string[] = [];
  for (const cmd of args) {
    if (cmd.startsWith('-')) continue;
    const locations: string[] = [];
    const searchPaths = ['/bin', '/usr/bin', '/sbin', '/usr/sbin', '/usr/local/bin'];
    for (const dir of searchPaths) {
      const path = `${dir}/${cmd}`;
      if (ctx.vfs.exists(path)) locations.push(path);
    }
    results.push(`${cmd}: ${locations.join(' ')}`);
  }
  return results.join('\n');
}

export function cmdCommand(ctx: ShellContext, args: string[]): string {
  if (args[0] !== '-v' || args.length < 2) return '';
  const cmd = args[1];
  const searchPaths = ['/bin', '/usr/bin', '/sbin', '/usr/sbin', '/usr/local/bin'];
  for (const dir of searchPaths) {
    const path = `${dir}/${cmd}`;
    if (ctx.vfs.exists(path)) return path;
  }
  return '';
}

export function cmdUpdatedb(ctx: ShellContext): string {
  // No-op in our simulator - locate searches live
  return '';
}
