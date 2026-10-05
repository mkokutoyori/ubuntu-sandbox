import type { WinFileCommandContext } from './WinFileCommands';
import { askLine } from './WinCommandInput';
import { hasWildcard, joinPath, nameMatcher, splitFileSpec } from './WinPathSpec';

const SYNTAX_ERROR = 'The syntax of the command is incorrect.';
const NOT_FOUND = 'The system cannot find the file specified.';
const PATH_NOT_FOUND = 'The system cannot find the path specified.';
const END_OF_FILE = String.fromCharCode(0x1a);

const countLine = (count: number, verb: 'copied' | 'moved', noun = 'file(s)'): string =>
  `${String(count).padStart(9)} ${noun} ${verb}.`;

const copyQuestion = (target: string): string => `Overwrite ${target}? (Yes/No/All): `;

export interface TransferSource {
  readonly display: string;
  readonly absolute: string;
  readonly isDirectory: boolean;
}

export type OverwriteFlag = 'y' | '-y' | null;

export function overwritesSilently(
  ctx: WinFileCommandContext, flag: OverwriteFlag, scriptDefault: boolean,
): boolean {
  if (flag === 'y') return true;
  if (flag === '-y') return false;
  const preset = (ctx.env.get('COPYCMD') ?? '').toLowerCase();
  if (preset.includes('/-y')) return false;
  if (preset.includes('/y')) return true;
  return scriptDefault && ctx.inScript;
}

export function overwriteGate(
  ctx: WinFileCommandContext, output: string[], silent: boolean, question: (target: string) => string,
): (target: string) => Promise<boolean> {
  let all = silent;
  return async target => {
    if (all) return true;
    for (;;) {
      const answer = await askLine(ctx, output, question(target));
      if (answer === null) return false;
      const letter = answer.trim().toLowerCase()[0];
      if (letter === 'y') return true;
      if (letter === 'n') return false;
      if (letter === 'a') {
        all = true;
        return true;
      }
    }
  };
}

export function expandSources(
  ctx: WinFileCommandContext, spec: string, directory: 'contents' | 'itself',
): TransferSource[] | null {
  const split = splitFileSpec(ctx.fs, ctx.cwd, spec);
  if (split === null) return null;
  const typedDirectory = spec.slice(0, Math.max(spec.lastIndexOf('\\'), spec.lastIndexOf('/')) + 1);
  if (split.pattern === null && directory === 'itself') {
    return [{ display: spec, absolute: split.directory, isDirectory: true }];
  }
  if (split.pattern === null) {
    const prefix = `${spec.replace(/[\\/]$/, '')}\\`;
    return ctx.fs.listDirectory(split.directory)
      .filter(item => item.entry.type === 'file')
      .map(item => ({ display: `${prefix}${item.name}`, absolute: joinPath(split.directory, item.name), isDirectory: false }));
  }
  if (!hasWildcard(split.pattern)) {
    const absolute = joinPath(split.directory, split.pattern);
    const entry = ctx.fs.resolve(absolute);
    return entry === null ? [] : [{ display: spec, absolute, isDirectory: entry.type === 'directory' }];
  }
  const matches = nameMatcher(split.pattern);
  return ctx.fs.listDirectory(split.directory)
    .filter(item => item.entry.type === 'file' && matches(item.name))
    .map(item => ({ display: `${typedDirectory}${item.name}`, absolute: joinPath(split.directory, item.name), isDirectory: false }));
}

interface CopyArguments {
  readonly chains: string[][];
  readonly overwrite: OverwriteFlag;
  readonly mode: 'a' | 'b' | null;
}

function parseCopyArguments(args: readonly string[]): CopyArguments | null {
  const chains: string[][] = [];
  let overwrite: OverwriteFlag = null;
  let mode: 'a' | 'b' | null = null;
  let joining = false;
  for (const token of args) {
    const lowered = token.toLowerCase();
    if (lowered === '/y') overwrite = 'y';
    else if (lowered === '/-y') overwrite = '-y';
    else if (lowered === '/a') mode = 'a';
    else if (lowered === '/b') mode = 'b';
    else if (['/d', '/v', '/n', '/z', '/l'].includes(lowered)) continue;
    else if (token.startsWith('/')) return null;
    else {
      const pieces = token.split('+');
      pieces.forEach((piece, index) => {
        if (piece === '') {
          joining = true;
          return;
        }
        if (joining || index > 0) chains[chains.length - 1]?.push(piece);
        else chains.push([piece]);
        joining = false;
      });
      if (token.endsWith('+')) joining = true;
    }
  }
  return { chains, overwrite, mode };
}

function readSource(ctx: WinFileCommandContext, absolute: string, ascii: boolean): string {
  const content = ctx.fs.readFile(absolute).content ?? '';
  const end = ascii ? content.indexOf(END_OF_FILE) : -1;
  return end < 0 ? content : content.slice(0, end);
}

export async function cmdCopy(ctx: WinFileCommandContext, args: string[]): Promise<string> {
  const parsed = parseCopyArguments(args);
  if (parsed === null || parsed.chains.length === 0 || parsed.chains.length > 2 || parsed.chains[1]?.length > 1) {
    ctx.setExitCode(1);
    return SYNTAX_ERROR;
  }
  const output: string[] = [];
  const [sourceSpecs, destinationChain] = parsed.chains;
  const sources: TransferSource[] = [];
  for (const spec of sourceSpecs) {
    const found = expandSources(ctx, spec, 'contents');
    if (found === null || found.length === 0) {
      ctx.setExitCode(1);
      return found === null ? PATH_NOT_FOUND : NOT_FOUND;
    }
    sources.push(...found);
  }

  const destinationSpec = destinationChain?.[0] ?? '.';
  const destination = ctx.fs.normalizePath(destinationSpec, ctx.cwd);
  const destinationIsDirectory = ctx.fs.isDirectory(destination);
  if (!destinationIsDirectory && /[\\/]$/.test(destinationSpec)) {
    ctx.setExitCode(1);
    return PATH_NOT_FOUND;
  }

  const silent = overwritesSilently(ctx, parsed.overwrite, true);
  const gate = overwriteGate(ctx, output, silent, copyQuestion);
  const concatenating = sourceSpecs.length > 1 || (sources.length > 1 && !destinationIsDirectory);
  const listing = concatenating || hasWildcard(sourceSpecs[0]) || sources.length > 1;
  let copied = 0;
  let failed = false;

  if (concatenating) {
    const ascii = parsed.mode !== 'b';
    const first = sources[0];
    const target = destinationChain === undefined
      ? joinPath(ctx.cwd, first.absolute.slice(first.absolute.lastIndexOf('\\') + 1))
      : destinationIsDirectory ? joinPath(destination, first.absolute.slice(first.absolute.lastIndexOf('\\') + 1)) : destination;
    for (const source of sources) output.push(source.display);
    const body = sources.map(source => readSource(ctx, source.absolute, ascii)).join('') + (ascii ? END_OF_FILE : '');
    const existing = ctx.fs.resolve(target);
    const intoFirst = target.toLowerCase() === first.absolute.toLowerCase();
    if (existing !== null && !intoFirst && !(await gate(target))) {
      output.push(countLine(0, 'copied'));
      ctx.setExitCode(0);
      return output.join('\n');
    }
    if (existing !== null && existing.attributes.has('readonly')) {
      output.push('Access is denied.', countLine(0, 'copied'));
      ctx.setExitCode(1);
      return output.join('\n');
    }
    const written = ctx.fs.createFile(target, body);
    if (!written.ok) {
      output.push(written.error ?? 'Access is denied.', countLine(0, 'copied'));
      ctx.setExitCode(1);
      return output.join('\n');
    }
    output.push(countLine(1, 'copied'));
    ctx.setExitCode(0);
    return output.join('\n');
  }

  for (const source of sources) {
    const name = source.absolute.slice(source.absolute.lastIndexOf('\\') + 1);
    const target = destinationIsDirectory ? joinPath(destination, name) : destination;
    if (listing) output.push(source.display);
    if (target.toLowerCase() === source.absolute.toLowerCase()) {
      output.push('The file cannot be copied onto itself.');
      failed = true;
      continue;
    }
    if (ctx.fs.resolve(target) !== null && !(await gate(target))) continue;
    const result = ctx.fs.copyFile(source.absolute, target);
    if (!result.ok) {
      output.push(result.error ?? 'Access is denied.');
      failed = true;
      continue;
    }
    if (parsed.mode === 'a') {
      const copy = ctx.fs.resolve(target);
      if (copy !== null) {
        copy.content = readSource(ctx, source.absolute, true);
        copy.size = copy.content.length;
      }
    }
    copied++;
  }
  output.push(countLine(copied, 'copied'));
  ctx.setExitCode(failed && copied === 0 ? 1 : 0);
  return output.join('\n');
}

interface MoveArguments {
  readonly specs: string[];
  readonly overwrite: OverwriteFlag;
}

function parseMoveArguments(args: readonly string[]): MoveArguments | null {
  const operands: string[] = [];
  let overwrite: OverwriteFlag = null;
  for (const token of args) {
    const lowered = token.toLowerCase();
    if (lowered === '/y') overwrite = 'y';
    else if (lowered === '/-y') overwrite = '-y';
    else if (token.startsWith('/')) return null;
    else operands.push(token);
  }
  if (operands.length !== 2) return null;
  return { specs: [operands[0], operands[1]], overwrite };
}

export async function cmdMove(ctx: WinFileCommandContext, args: string[]): Promise<string> {
  const parsed = parseMoveArguments(args);
  if (parsed === null) {
    ctx.setExitCode(1);
    return SYNTAX_ERROR;
  }
  const [sourceList, destinationSpec] = parsed.specs;
  const output: string[] = [];
  const sources: TransferSource[] = [];
  for (const spec of sourceList.split(',').filter(part => part !== '')) {
    const found = expandSources(ctx, spec, 'itself');
    if (found === null || found.length === 0) {
      ctx.setExitCode(1);
      return found === null ? PATH_NOT_FOUND : NOT_FOUND;
    }
    sources.push(...found);
  }

  const destination = ctx.fs.normalizePath(destinationSpec, ctx.cwd);
  const destinationIsDirectory = ctx.fs.isDirectory(destination);
  if (sources.length > 1 && !destinationIsDirectory) {
    ctx.setExitCode(1);
    return 'Cannot move multiple files to a single file.\n' + countLine(0, 'moved');
  }

  const gate = overwriteGate(ctx, output, overwritesSilently(ctx, parsed.overwrite, true), copyQuestion);
  const listing = sources.length > 1 || hasWildcard(sourceList);
  let files = 0;
  let directories = 0;
  let failed = false;
  for (const source of sources) {
    const name = source.absolute.slice(source.absolute.lastIndexOf('\\') + 1);
    const target = destinationIsDirectory ? joinPath(destination, name) : destination;
    if (listing) output.push(source.absolute);
    const existing = ctx.fs.resolve(target);
    if (existing !== null && existing.type === 'file' && !source.isDirectory && !(await gate(target))) continue;
    const result = ctx.fs.moveFile(source.absolute, target);
    if (!result.ok) {
      output.push(result.error ?? 'Access is denied.');
      failed = true;
      continue;
    }
    if (source.isDirectory) directories++;
    else files++;
  }
  if (directories > 0) output.push(countLine(directories, 'moved', 'dir(s)'));
  if (files > 0 || directories === 0) output.push(countLine(files, 'moved'));
  ctx.setExitCode(failed && files + directories === 0 ? 1 : 0);
  return output.join('\n');
}
