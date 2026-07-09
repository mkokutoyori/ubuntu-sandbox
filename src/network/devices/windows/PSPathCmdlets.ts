import type { WindowsFileSystem } from './WindowsFileSystem';
import { PSRegistryProvider, isRegistryPath } from './PSRegistryProvider';

export interface PSPathContext {
  fs: WindowsFileSystem;
  cwd: string;
  registry: PSRegistryProvider;
}

export function psTestPath(ctx: PSPathContext, args: string[]): string {
  const target = args.filter(a => !a.startsWith('-')).join(' ');
  if (!target) return 'False';
  if (isRegistryPath(target)) return ctx.registry.testPath(target) ? 'True' : 'False';
  const absPath = ctx.fs.normalizePath(target, ctx.cwd);
  return ctx.fs.exists(absPath) ? 'True' : 'False';
}

export function psResolvePath(ctx: PSPathContext, args: string[]): string {
  const target = args.filter(a => !a.startsWith('-')).join(' ');
  if (!target) return "Resolve-Path : Cannot bind argument to parameter 'Path' because it is an empty string.";
  const absPath = ctx.fs.normalizePath(target, ctx.cwd);
  if (!ctx.fs.exists(absPath)) return `Resolve-Path : Cannot find path '${target}' because it does not exist.`;
  return `\nPath\n----\n${absPath}\n`;
}

export function psSplitPath(args: string[]): string {
  let target = '';
  let leaf = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-Leaf') { leaf = true; continue; }
    if (args[i] === '-Parent') { continue; }
    if (args[i] === '-Path' && args[i + 1]) { target = args[++i]; continue; }
    if (!args[i].startsWith('-') && !target) { target = args[i]; }
  }
  if (!target) return '';
  const lastSep = target.lastIndexOf('\\');
  if (leaf) {
    return lastSep >= 0 ? target.substring(lastSep + 1) : target;
  }
  return lastSep >= 0 ? target.substring(0, lastSep) : '';
}

export function psJoinPath(args: string[]): string {
  let parentPath = '', childPath = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-Path' && args[i + 1]) { parentPath = args[++i]; continue; }
    if (args[i] === '-ChildPath' && args[i + 1]) { childPath = args[++i]; continue; }
    if (!args[i].startsWith('-')) {
      if (!parentPath) { parentPath = args[i]; }
      else if (!childPath) { childPath = args[i]; }
    }
  }
  if (!parentPath) return '';
  if (!childPath) return parentPath;
  const sep = parentPath.endsWith('\\') ? '' : '\\';
  return `${parentPath}${sep}${childPath}`;
}
