import type { WinFileCommandContext } from './WinFileCommands';
import { wildcardToRegex } from '@/powershell/runtime/PSWildcard';
import { fileDateTime } from './WinDir';

export const WHERE_HELP = [
  'WHERE [/R dir] [/Q] [/F] [/T] pattern...',
  '',
  'DESCRIPTION:',
  '    Displays the location of files that match the search pattern.',
  '    By default, the search is done along the current directory and',
  '    in the paths specified by the PATH environment variable.',
  '',
  'PARAMETER LIST:',
  '   /R       Recursively searches and displays the files that match the',
  '            given pattern starting from the specified directory.',
  '   /Q       Returns only the exit code, without displaying the list of',
  '            matched files. (Quiet mode)',
  '   /F       Displays the matched filename in double quotes.',
  '   /T       Displays the file size, last modified date and time for all',
  '            matched files.',
  '   pattern  Specifies the search pattern for the files to match.',
  '            Wildcards * and ? can be used in the pattern. The',
  '            "$env:pattern" and "path:pattern" formats can also be',
  '            specified, where "env" is an environment variable and',
  '            the search is done in the specified paths of the "env"',
  '            environment variable. These formats should not be used',
  '            with /R. The search is also done by appending the',
  '            extensions of the PATHEXT variable to the pattern.',
  '   /?       Displays this help message.',
  '',
  '  NOTE: The tool returns an error level of 0 if the search is',
  '        successful, of 1 if the search is unsuccessful and',
  '        of 2 for failures or errors.',
  '',
  'EXAMPLES:',
  '    WHERE /?',
  '    WHERE myfilename1 myfilename2',
  '    WHERE c:\\windows*:*.exe',
  '    WHERE c:\\windows;c:\\windows\\system32:*.dll',
  '    WHERE /R c:\\windows *.exe *.dll *.bat',
  '    WHERE /Q ??.???',
  '    WHERE "c:\\windows\\program files:*.dll"',
  '    WHERE /F /T c:\\windows\\system32:*.exe',
  '    WHERE $windir:*.*',
  '    WHERE $path:*.exe',
].join('\n');

const USAGE_HINT = 'Type "WHERE /?" for usage.';
const NOT_FOUND = 'INFO: Could not find files for the given pattern(s).';
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

interface WhereOptions {
  recursiveRoot: string | null;
  quiet: boolean;
  quoted: boolean;
  details: boolean;
  patterns: string[];
}

interface Search {
  readonly directories: readonly string[];
  readonly pattern: string;
}

type Parse = { options: WhereOptions } | { error: string } | { help: true };

function parseArguments(args: readonly string[]): Parse {
  const options: WhereOptions = { recursiveRoot: null, quiet: false, quoted: false, details: false, patterns: [] };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const lowered = argument.toLowerCase();
    if (lowered === '/?') return { help: true };
    if (lowered === '/r') {
      const root = args[++index];
      if (root === undefined) return { error: `ERROR: Invalid syntax. /R requires a directory.\n${USAGE_HINT}` };
      options.recursiveRoot = root;
    } else if (lowered === '/q') options.quiet = true;
    else if (lowered === '/f') options.quoted = true;
    else if (lowered === '/t') options.details = true;
    else if (argument.startsWith('/') && argument.length === 2) return { error: `ERROR: Invalid argument or option - '${argument}'.\n${USAGE_HINT}` };
    else options.patterns.push(argument);
  }
  if (options.patterns.length === 0) return { error: `ERROR: A pattern must be specified.\n${USAGE_HINT}` };
  return { options };
}

function environmentDirectories(ctx: WinFileCommandContext, name: string): string[] {
  return (ctx.env.get(name.toUpperCase()) ?? '').split(';').map(entry => entry.trim()).filter(entry => entry !== '');
}

function searchOf(ctx: WinFileCommandContext, raw: string): Search | { error: string } {
  const unquoted = raw.replace(/^"(.*)"$/, '$1');
  const variable = /^\$([^:]+):(.+)$/.exec(unquoted);
  if (variable !== null) {
    const directories = environmentDirectories(ctx, variable[1]);
    if (directories.length === 0 && !ctx.env.has(variable[1].toUpperCase())) {
      return { error: `ERROR: The environment variable "${variable[1]}" is not defined.` };
    }
    return { directories, pattern: variable[2] };
  }
  const split = /^(.+):([^:\\/]+)$/.exec(unquoted);
  if (split !== null && split[1].length > 1) {
    return { directories: split[1].split(';').map(entry => entry.trim()).filter(entry => entry !== ''), pattern: split[2] };
  }
  return { directories: [ctx.cwd, ...environmentDirectories(ctx, 'PATH')], pattern: unquoted };
}

function extensionsOf(ctx: WinFileCommandContext): string[] {
  return (ctx.env.get('PATHEXT') ?? DEFAULT_PATHEXT).split(';').map(extension => extension.trim()).filter(extension => extension !== '');
}

function nameMatcher(pattern: string, extensions: readonly string[]): (name: string) => boolean {
  const alternatives = [pattern, ...extensions.map(extension => `${pattern}${extension}`)].map(wildcardToRegex);
  return name => alternatives.some(expression => expression.test(name));
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith('\\') ? `${directory}${name}` : `${directory}\\${name}`;
}

function expandDirectories(ctx: WinFileCommandContext, directories: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const entry of directories) {
    const separator = entry.lastIndexOf('\\');
    const leaf = separator < 0 ? entry : entry.slice(separator + 1);
    if (!/[*?]/.test(leaf)) {
      expanded.push(entry);
      continue;
    }
    const parent = entry.slice(0, separator + 1) || ctx.cwd;
    const matcher = wildcardToRegex(leaf);
    for (const { name, entry: child } of ctx.fs.listDirectory(ctx.fs.normalizePath(parent, ctx.cwd))) {
      if (child.type === 'directory' && matcher.test(name)) expanded.push(joinPath(parent, name));
    }
  }
  return expanded;
}

function walk(ctx: WinFileCommandContext, root: string, matches: (name: string) => boolean, found: string[]): void {
  const entries = ctx.fs.listDirectory(root);
  for (const { name, entry } of entries) {
    if (entry.type === 'file' && matches(name)) found.push(joinPath(root, name));
  }
  for (const { name, entry } of entries) {
    if (entry.type === 'directory') walk(ctx, joinPath(root, name), matches, found);
  }
}

function findFiles(ctx: WinFileCommandContext, search: Search, options: WhereOptions): string[] {
  const matches = nameMatcher(search.pattern, extensionsOf(ctx));
  const found: string[] = [];
  if (options.recursiveRoot !== null) {
    walk(ctx, ctx.fs.normalizePath(options.recursiveRoot, ctx.cwd), matches, found);
    return found;
  }
  for (const directory of expandDirectories(ctx, search.directories)) {
    const absolute = ctx.fs.normalizePath(directory, ctx.cwd);
    if (!ctx.fs.isDirectory(absolute)) continue;
    for (const { name, entry } of ctx.fs.listDirectory(absolute)) {
      if (entry.type === 'file' && matches(name)) found.push(joinPath(directory, name));
    }
  }
  return found;
}

function render(ctx: WinFileCommandContext, path: string, options: WhereOptions): string {
  const shown = options.quoted ? `"${path}"` : path;
  if (!options.details) return shown;
  const entry = ctx.fs.resolve(ctx.fs.normalizePath(path, ctx.cwd));
  if (entry === null || entry.type !== 'file') return shown;
  return `${String(entry.size).padStart(10)}  ${fileDateTime(entry.mtime)}  ${shown}`;
}

export function cmdWhere(ctx: WinFileCommandContext, args: string[]): string {
  const parsed = parseArguments(args);
  if ('help' in parsed) {
    ctx.setExitCode(0);
    return WHERE_HELP;
  }
  if ('error' in parsed) {
    ctx.setExitCode(2);
    return parsed.error;
  }
  const { options } = parsed;
  if (options.recursiveRoot !== null && !ctx.fs.isDirectory(ctx.fs.normalizePath(options.recursiveRoot, ctx.cwd))) {
    ctx.setExitCode(2);
    return `ERROR: The system cannot find the path specified.`;
  }

  const lines: string[] = [];
  let missing = false;
  for (const pattern of options.patterns) {
    const search = searchOf(ctx, pattern);
    if ('error' in search) {
      ctx.setExitCode(2);
      return search.error;
    }
    const found = [...new Set(findFiles(ctx, search, options))];
    if (found.length === 0) missing = true;
    lines.push(...found.map(path => render(ctx, path, options)));
  }
  ctx.setExitCode(missing ? 1 : 0);
  if (options.quiet) return '';
  if (missing) lines.push(NOT_FOUND);
  return lines.join('\n');
}
