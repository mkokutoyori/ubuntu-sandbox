import type { WinFileCommandContext } from './WinFileCommands';
import type { WinFSEntry } from './WindowsFileSystem';
import { askLine } from './WinCommandInput';
import { overwriteGate, overwritesSilently, type OverwriteFlag } from './WinCopy';
import { hasWildcard, joinPath, nameMatcher, splitFileSpec } from './WinPathSpec';

const INVALID_PARAMETERS = 'Invalid number of parameters';
const INVALID_PATH = 'Invalid path';
const CYCLIC = 'Cannot perform a cyclic copy';
const ACCESS_DENIED = 'File creation error - Access is denied.';
const SELF_COPY = 'File cannot be copied onto itself';

const EXIT_NO_FILES = 1;
const EXIT_TERMINATED = 2;
const EXIT_ERROR = 4;

const IGNORED_SWITCHES: ReadonlySet<string> = new Set(['v', 'n', 'z', 'b', 'j', 'g', 'compress', 'sparse']);

interface XcopyOptions {
  subdirectories: boolean;
  empty: boolean;
  treeOnly: boolean;
  updateExisting: boolean;
  assumeDirectory: boolean;
  overwrite: OverwriteFlag;
  since: Date | 'newer' | null;
  hidden: boolean;
  keepReadOnly: boolean;
  overwriteReadOnly: boolean;
  archiveOnly: boolean;
  archiveReset: boolean;
  continueOnError: boolean;
  quiet: boolean;
  fullNames: boolean;
  listOnly: boolean;
  promptEach: boolean;
  wait: boolean;
  excludeFiles: string[];
  security: boolean;
}

type Parsed = { options: XcopyOptions; operands: string[] } | { error: string };

function parseDate(text: string): Date | null {
  const match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(text);
  if (match === null) return null;
  const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
  return new Date(year, Number(match[1]) - 1, Number(match[2]));
}

function parseArguments(args: readonly string[]): Parsed {
  const options: XcopyOptions = {
    subdirectories: false, empty: false, treeOnly: false, updateExisting: false, assumeDirectory: false,
    overwrite: null, since: null, hidden: false, keepReadOnly: false, overwriteReadOnly: false,
    archiveOnly: false, archiveReset: false, continueOnError: false, quiet: false, fullNames: false,
    listOnly: false, promptEach: false, wait: false, excludeFiles: [], security: false,
  };
  const operands: string[] = [];
  for (const token of args) {
    if (!token.startsWith('/')) {
      operands.push(token);
      continue;
    }
    for (const piece of token.slice(1).split('/').filter(part => part !== '')) {
      const colon = piece.indexOf(':');
      const name = (colon < 0 ? piece : piece.slice(0, colon)).toLowerCase();
      const value = colon < 0 ? null : piece.slice(colon + 1);
      switch (name) {
        case 's': options.subdirectories = true; break;
        case 'e': options.empty = true; options.subdirectories = true; break;
        case 't': options.treeOnly = true; options.subdirectories = true; break;
        case 'u': options.updateExisting = true; break;
        case 'i': options.assumeDirectory = true; break;
        case 'y': options.overwrite = 'y'; break;
        case '-y': options.overwrite = '-y'; break;
        case 'h': options.hidden = true; break;
        case 'k': options.keepReadOnly = true; break;
        case 'r': options.overwriteReadOnly = true; break;
        case 'a': options.archiveOnly = true; break;
        case 'm': options.archiveOnly = true; options.archiveReset = true; break;
        case 'c': options.continueOnError = true; break;
        case 'q': options.quiet = true; break;
        case 'f': options.fullNames = true; break;
        case 'l': options.listOnly = true; break;
        case 'p': options.promptEach = true; break;
        case 'w': options.wait = true; break;
        case 'o':
        case 'x': options.security = true; break;
        case 'd': {
          if (value === null || value === '') options.since = 'newer';
          else {
            const date = parseDate(value);
            if (date === null) return { error: 'Invalid date' };
            options.since = date;
          }
          break;
        }
        case 'exclude':
          if (value === null || value === '') return { error: INVALID_PARAMETERS };
          options.excludeFiles.push(...value.split('+').filter(file => file !== ''));
          break;
        default:
          if (!IGNORED_SWITCHES.has(name)) return { error: INVALID_PARAMETERS };
      }
    }
  }
  if (operands.length === 0 || operands.length > 2) return { error: INVALID_PARAMETERS };
  return { options, operands };
}

interface Candidate {
  readonly absolute: string;
  readonly relative: string;
  readonly entry: WinFSEntry;
}

interface Branch {
  readonly relative: string;
  hasFiles: boolean;
}

const isHiddenOrSystem = (entry: WinFSEntry): boolean => entry.attributes.has('hidden') || entry.attributes.has('system');

function collect(
  ctx: WinFileCommandContext, directory: string, relative: string, matches: (name: string) => boolean,
  options: XcopyOptions, files: Candidate[], branches: Branch[],
): boolean {
  let any = false;
  const entries = ctx.fs.listDirectory(directory);
  for (const { name, entry } of entries) {
    if (entry.type === 'file' && matches(name)) {
      files.push({ absolute: joinPath(directory, name), relative: relative === '' ? name : `${relative}\\${name}`, entry });
      any = true;
    }
  }
  if (!options.subdirectories) return any;
  for (const { name, entry } of entries) {
    if (entry.type !== 'directory') continue;
    if (isHiddenOrSystem(entry) && !options.hidden) continue;
    const branch: Branch = { relative: relative === '' ? name : `${relative}\\${name}`, hasFiles: false };
    branches.push(branch);
    branch.hasFiles = collect(ctx, joinPath(directory, name), branch.relative, matches, options, files, branches);
    any = any || branch.hasFiles;
  }
  return any;
}

function excludedBy(ctx: WinFileCommandContext, names: readonly string[]): string[] | null {
  const strings: string[] = [];
  for (const name of names) {
    const result = ctx.fs.readFile(ctx.fs.normalizePath(name, ctx.cwd));
    if (!result.ok) return null;
    strings.push(...(result.content ?? '').split(/\r?\n/).map(line => line.trim().toLowerCase()).filter(line => line !== ''));
  }
  return strings;
}

function acceptedBy(candidate: Candidate, options: XcopyOptions, excluded: readonly string[], destination: WinFSEntry | null): boolean {
  const { entry, absolute } = candidate;
  if (isHiddenOrSystem(entry) && !options.hidden) return false;
  if (options.archiveOnly && !entry.attributes.has('archive')) return false;
  const lowered = absolute.toLowerCase();
  if (excluded.some(text => lowered.includes(text))) return false;
  if (options.updateExisting && destination === null) return false;
  if (options.since instanceof Date && entry.mtime.getTime() < options.since.getTime()) return false;
  if (options.since === 'newer' && destination !== null && entry.mtime.getTime() <= destination.mtime.getTime()) return false;
  return true;
}

const countLine = (count: number, listOnly: boolean): string => `${count} File(s)${listOnly ? '' : ' copied'}`;

export async function cmdXcopy(ctx: WinFileCommandContext, args: string[]): Promise<string> {
  const parsed = parseArguments(args);
  if ('error' in parsed) {
    ctx.setExitCode(EXIT_ERROR);
    return parsed.error;
  }
  const { options, operands } = parsed;
  const output: string[] = [];
  const finish = (code: number, count: number): string => {
    output.push(countLine(count, options.listOnly));
    ctx.setExitCode(code);
    return output.join('\n');
  };

  const sourceSpec = operands[0];
  const destinationSpec = operands[1] ?? '.';
  const split = splitFileSpec(ctx.fs, ctx.cwd, sourceSpec);
  if (split === null) {
    output.push(INVALID_PATH);
    return finish(EXIT_ERROR, 0);
  }
  const sourceIsPlainFile = split.pattern !== null && !hasWildcard(split.pattern);
  if (sourceIsPlainFile && ctx.fs.resolve(joinPath(split.directory, split.pattern!)) === null) {
    output.push(`File not found - ${sourceSpec}`);
    return finish(EXIT_NO_FILES, 0);
  }

  const typedDirectory = sourceSpec.slice(0, Math.max(sourceSpec.lastIndexOf('\\'), sourceSpec.lastIndexOf('/')) + 1);
  const displayPrefix = split.pattern === null ? `${sourceSpec.replace(/[\\/]$/, '')}\\` : typedDirectory;
  const excluded = excludedBy(ctx, options.excludeFiles);
  if (excluded === null) {
    output.push(`File not found - ${options.excludeFiles[0]}`);
    return finish(EXIT_ERROR, 0);
  }

  if (options.wait) await askLine(ctx, output, 'Press any key to begin copying file(s)');

  const destination = ctx.fs.normalizePath(destinationSpec, ctx.cwd);
  const existing = ctx.fs.resolve(destination);
  const files: Candidate[] = [];
  const branches: Branch[] = [];
  collect(ctx, split.directory, '', nameMatcher(split.pattern), options, files, branches);

  let destinationIsDirectory: boolean;
  if (existing !== null) destinationIsDirectory = existing.type === 'directory';
  else if (/[\\/]$/.test(destinationSpec) || options.assumeDirectory) destinationIsDirectory = true;
  else if (!sourceIsPlainFile || options.subdirectories) destinationIsDirectory = true;
  else {
    let decided: boolean | null = null;
    while (decided === null) {
      const answer = await askLine(ctx, output,
        `Does ${destinationSpec} specify a file name\nor directory name on the target\n(F = file, D = directory)? `);
      if (answer === null) {
        output.push('0 File(s) copied');
        ctx.setExitCode(EXIT_TERMINATED);
        return output.join('\n');
      }
      const letter = answer.trim().toLowerCase()[0];
      if (letter === 'f') decided = false;
      else if (letter === 'd') decided = true;
    }
    destinationIsDirectory = decided;
  }

  const sourceRoot = split.directory.toLowerCase().replace(/\\$/, '');
  if (options.subdirectories && destinationIsDirectory
    && (`${destination.toLowerCase()}\\`).startsWith(`${sourceRoot}\\`)) {
    output.push(CYCLIC);
    return finish(EXIT_ERROR, 0);
  }
  if (!destinationIsDirectory && files.length > 1) {
    output.push(INVALID_PATH);
    return finish(EXIT_ERROR, 0);
  }

  const silent = overwritesSilently(ctx, options.overwrite, false);
  const gate = overwriteGate(ctx, output, silent, target => `Overwrite ${target} (Yes/No/All)? `);
  let copied = 0;
  let failed = false;

  if (!options.listOnly && destinationIsDirectory && existing === null && (files.length > 0 || options.empty || options.treeOnly)) {
    ctx.fs.mkdirp(destination);
  }
  if (options.empty || options.treeOnly) {
    for (const branch of branches) {
      if (options.listOnly || !(options.empty || branch.hasFiles)) continue;
      ctx.fs.mkdirp(joinPath(destination, branch.relative));
    }
  }
  if (options.treeOnly) return finish(0, 0);

  for (const candidate of files) {
    const target = destinationIsDirectory ? joinPath(destination, candidate.relative) : destination;
    const present = ctx.fs.resolve(target);
    if (!acceptedBy(candidate, options, excluded, present?.type === 'file' ? present : null)) continue;
    const shown = candidate.relative === '' ? sourceSpec : `${displayPrefix}${candidate.relative}`;
    const label = options.fullNames ? `${candidate.absolute} -> ${target}` : shown;
    if (options.promptEach) {
      const answer = await askLine(ctx, output, `${shown} (Y/N)? `);
      if (answer === null || answer.trim().toLowerCase()[0] !== 'y') continue;
    }
    if (target.toLowerCase() === candidate.absolute.toLowerCase()) {
      output.push(SELF_COPY);
      return finish(EXIT_ERROR, copied);
    }
    if (options.listOnly) {
      if (!options.quiet) output.push(label);
      copied++;
      continue;
    }
    if (present !== null && present.type === 'file' && !(await gate(target))) continue;
    if (present !== null && present.attributes.has('readonly')) {
      if (options.overwriteReadOnly) present.attributes.delete('readonly');
      else {
        output.push(ACCESS_DENIED);
        failed = true;
        if (options.continueOnError) continue;
        return finish(EXIT_ERROR, copied);
      }
    }
    const parent = target.slice(0, target.lastIndexOf('\\'));
    if (parent.length > 2) ctx.fs.mkdirp(parent);
    const result = ctx.fs.copyFile(candidate.absolute, target, { security: options.security });
    if (!result.ok) {
      output.push(`File creation error - ${result.error ?? 'Access is denied.'}`);
      failed = true;
      if (options.continueOnError) continue;
      return finish(EXIT_ERROR, copied);
    }
    const copy = ctx.fs.resolve(target);
    if (copy !== null && !options.keepReadOnly) copy.attributes.delete('readonly');
    if (options.archiveReset) candidate.entry.attributes.delete('archive');
    if (!options.quiet) output.push(label);
    copied++;
  }
  return finish(failed ? EXIT_ERROR : copied === 0 && files.length === 0 ? EXIT_NO_FILES : 0, copied);
}
