/**
 * PathCmdlets — Split-Path, Join-Path, Test-Path, Resolve-Path.
 *
 * Test-Path delegates to the filesystem provider (or testPathHook via runtime).
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { AD_NULL_GUID } from '@/network/devices/windows/server/ad/AdTypes';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { fileDigestHex, fileDigestName } from '@/crypto/hash';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import { wildcardToRegex, wildcardMatches, hasWildcard } from '@/powershell/runtime/PSWildcard';
import { parseAttributeNames, isDefaultVisible } from '@/network/devices/windows/fileAttributes';
import { joinPath } from '@/network/devices/windows/WinPathSpec';
import { parentPathOf } from '@/network/devices/windows/windowsPath';
import { namedRecord } from '@/powershell/runtime/PSPathInfo';
import { newErrorRecord } from '@/powershell/runtime/semantics/PSStreams';
import {
  CLEAR_CONTENT_REFUSAL, COPY_ACROSS_PROVIDERS, copyNamespaceItem, listNamespace, namespaceExists, namespaceTarget, newNamespaceItem,
  readNamespaceContent, removeNamespaceItems, renameNamespaceItem, resolveNamespacePaths, seekRefusal, setNamespaceItem, writeNamespaceContent,
} from './NamespaceDrives';
import { pathInfoOf, providerPathOf } from './ProviderPaths';
import type { DirEntry } from '@/powershell/providers/PSProviders';

function isRegistryPath(path: string): boolean {
  return /^(HKLM|HKCU|HKCR|HKU|HKCC):/i.test(path) || /^HKEY_/i.test(path);
}

const CONTENT_NOT_SUPPORTED = 'Cannot use interface. The IContentCmdletProvider interface is not implemented by this provider.';

function requireRegistryProvider(path: string): void {
  if (isRegistryPath(path)) {
    throw new Error('Registry provider not recognized in this context');
  }
}

/**
 * `HKLM\Logiciel\...` — une ruche, mais sans les deux-points du lecteur
 * PowerShell. `reg.exe` écrit ainsi, PowerShell non : pour lui `HKLM`
 * sans `:` n'est pas un lecteur, et il le dit.
 *
 * Sans ce garde, un tel chemin ne passait aucun des deux tests
 * ci-dessus : l'écriture retombait sur un `return null` muet, et
 * `Set-ItemProperty` rendait la main sans erreur ni effet. Une écriture
 * perdue qui se présente comme réussie est pire qu'un refus.
 */
function hivePathMissingDrive(path: string): boolean {
  return /^(HKLM|HKCU|HKCR|HKU|HKCC)\\/i.test(path);
}

function reportMissingDrive(ctx: CmdletContext, cmdlet: string, path: string): void {
  const drive = /^([A-Z]+)\\/i.exec(path)?.[1] ?? path;
  ctx.emitError(
    `${cmdlet} : Cannot find drive. A drive with the name '${drive}' does not exist.`);
}

// ─── Split-Path ───────────────────────────────────────────────────────────

const QUALIFIER = /^([^\\/:]+):/;

function qualifierOf(path: string): string | null {
  const match = QUALIFIER.exec(path);
  return match === null ? null : match[1];
}

function rootedDrive(path: string): string {
  const colon = path.indexOf(':');
  return colon !== -1 && colon + 1 === path.length ? `${path}\\` : path;
}

function trimmedPath(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '');
}

function childNameOfProviderPath(path: string): string {
  const trimmed = trimmedPath(path);
  const cut = trimmed.lastIndexOf('\\');
  return cut === -1 ? rootedDrive(trimmed) : trimmed.slice(cut + 1);
}

function withoutQualifier(path: string): string {
  const name = qualifierOf(path);
  return name !== null && path.length > name.length + 1 ? path.slice(name.length + 1) : path;
}

function boundPathOf(item: PSValue): string | undefined {
  const record = item as Record<string, PSValue> | null;
  const named = record?.['FullName'] ?? record?.['PSPath'] ?? record?.['Path'];
  return named === undefined ? undefined : psValueToString(named);
}

export function pathItemOf(item: PSValue): string {
  return boundPathOf(item) ?? psValueToString(item);
}

function pathSources(ctx: CmdletContext): PSValue[] {
  const explicit = ctx.named['literalpath'] ?? ctx.named['path'] ?? ctx.positional[0];
  const source = explicit !== undefined ? explicit : ctx.pipeInput;
  if (source === undefined || source === null) return [];
  return Array.isArray(source) ? source : [source];
}

function pathInputs(ctx: CmdletContext): string[] {
  return pathSources(ctx).map(pathItemOf);
}

function resolvedPaths(ctx: CmdletContext, typed: string, literal: boolean): string[] {
  const located = locatedPath(ctx, typed);
  const namespace = namespaceTarget(located);
  if (namespace !== null) return resolveNamespacePaths(ctx, namespace);
  if (isRegistryPath(located) && ctx.providers.registry) {
    if (ctx.providers.registry.testPath(located) === true) return [located];
    ctx.emitError(`Cannot find path '${located}' because it does not exist.`);
    return [];
  }
  const fs = ctx.providers.filesystem;
  if (!fs) return [typed];
  const absolute = fs.normalizePath(typed, fs.getCwd());
  const found = !literal && hasWildcard(typed) ? expandPathSpec(fs, absolute) : fs.exists(absolute) ? [absolute] : [];
  if (found.length === 0) ctx.emitError(`Cannot find path '${typed}' because it does not exist.`);
  return found;
}

export class SplitPathCmdlet implements ICmdlet {
  readonly name = 'split-path';
  readonly displayName = 'Split-Path';
  readonly parameters = ['Path', 'LiteralPath', 'Qualifier', 'NoQualifier', 'Parent', 'Leaf', 'LeafBase', 'Extension', 'Resolve', 'IsAbsolute'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly switchParameters = ['Qualifier', 'NoQualifier', 'Parent', 'Leaf', 'LeafBase', 'Extension', 'Resolve', 'IsAbsolute'] as const;
  readonly coreOnlyParameters = ['LeafBase', 'Extension'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const literal = ctx.named['literalpath'] !== undefined;
    const subjects = pathInputs(ctx).flatMap(typed => (ctx.named['resolve'] === true ? resolvedPaths(ctx, typed, literal) : [typed]));
    const results: PSValue[] = [];
    for (const subject of subjects) {
      const one = this.split(ctx, subject);
      if (one !== undefined) results.push(one);
    }
    return results.length === 0 ? null : results.length === 1 ? results[0] : results;
  }

  private split(ctx: CmdletContext, path: string): PSValue | undefined {
    if (ctx.named['isabsolute'] === true) return qualifierOf(path) !== null;
    if (ctx.named['qualifier'] === true) {
      const name = qualifierOf(path);
      if (name === null) {
        ctx.emitError(`Cannot parse path because path '${path}' does not have a qualifier specified.`);
        return undefined;
      }
      return `${name}:`;
    }
    if (ctx.named['noqualifier'] === true) return withoutQualifier(path);
    if (ctx.named['leaf'] === true || ctx.named['leafbase'] === true || ctx.named['extension'] === true) {
      const leaf = childNameOfProviderPath(path);
      const dot = leaf.lastIndexOf('.');
      if (ctx.named['leafbase'] === true) return dot === -1 ? leaf : leaf.slice(0, dot);
      if (ctx.named['extension'] === true) return dot === -1 ? '' : leaf.slice(dot);
      return leaf;
    }
    return parentPathOf(path);
  }
}

// ─── Join-Path ────────────────────────────────────────────────────────────

export class JoinPathCmdlet implements ICmdlet {
  readonly name = 'join-path';
  readonly parameters = ['Path', 'ChildPath', 'AdditionalChildPath', 'Resolve'] as const;
  readonly parameterValues = { Path: 'path' } as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const parts = [
      ctx.named['path']      ?? ctx.positional[0] ?? '',
      ctx.named['childpath'] ?? ctx.positional[1] ?? '',
    ];
    const p1  = psValueToString(parts[0]).replace(/[\\/]+$/, '');
    const p2  = psValueToString(parts[1]).replace(/^[\\/]+/, '');
    const sep = p1.includes('/') && !p1.includes('\\') ? '/' : '\\';
    return p2 ? `${p1}${sep}${p2}` : p1;
  }
}

// ─── Test-Path ────────────────────────────────────────────────────────────

function hasControlCharacter(text: string): boolean {
  return [...text].some(char => char.charCodeAt(0) < 32);
}

export class TestPathCmdlet implements ICmdlet {
  readonly name = 'test-path';
  readonly parameters = ['Path', 'LiteralPath', 'PathType', 'Filter', 'Include', 'Exclude', 'IsValid', 'Newer', 'OlderThan'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const sources = pathSources(ctx);
    if (sources.every(item => item === null || item === undefined)) {
      ctx.emitError("Test-Path : Cannot bind argument to parameter 'Path' because it is null.");
      return null;
    }
    const answers = sources.map(item => this.exists(ctx, locatedPath(ctx, pathItemOf(item))));
    return answers.length === 1 ? answers[0] : answers;
  }

  private exists(ctx: CmdletContext, path: string): boolean {
    if (!path) return false;

    const namespace = namespaceTarget(path);
    if (namespace !== null) return namespaceExists(ctx, namespace);

    if (ctx.providers.registry) {
      if (isRegistryPath(path)) return ctx.providers.registry.testPath(path) ?? false;
    } else {
      requireRegistryProvider(path);
    }

    if (ctx.named['isvalid'] === true) return !/[<>|"]/.test(path) && !hasControlCharacter(path);

    const fs = ctx.providers.filesystem;
    if (!fs) return false;
    const absolute = fs.normalizePath(path, fs.getCwd());
    const found = ctx.named['literalpath'] === undefined && hasWildcard(path) ? expandPathSpec(fs, absolute) : fs.exists(absolute) ? [absolute] : [];
    const kind = ctx.named['pathtype'] !== undefined ? psValueToString(ctx.named['pathtype']).toLowerCase() : 'any';
    return found.length > 0 && found.every(item => kind === 'container' ? fs.isDirectory(item) : kind === 'leaf' ? !fs.isDirectory(item) : true);
  }
}

// ─── Resolve-Path ────────────────────────────────────────────────────────

export class ResolvePathCmdlet implements ICmdlet {
  readonly name = 'resolve-path';
  readonly displayName = 'Resolve-Path';
  readonly parameters = ['Path', 'LiteralPath', 'Relative', 'RelativeBasePath'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly switchParameters = ['Relative'] as const;
  readonly aliases = ['rvpa'] as const;

  execute(ctx: CmdletContext): PSValue {
    const fs = ctx.providers.filesystem;
    const literal = ctx.named['literalpath'] !== undefined;
    const relative = ctx.named['relative'] === true;
    const base = ctx.named['relativebasepath'] !== undefined ? psValueToString(ctx.named['relativebasepath']) : fs?.getCwd() ?? '';
    const results: PSValue[] = pathInputs(ctx).flatMap(typed => resolvedPaths(ctx, typed, literal)).map(absolute =>
      relative ? relativePathFrom(base, absolute) : pathInfoOf(ctx, absolute));
    return results.length === 0 ? null : results.length === 1 ? results[0] : results;
  }
}

export class ConvertPathCmdlet implements ICmdlet {
  readonly name = 'convert-path';
  readonly displayName = 'Convert-Path';
  readonly parameters = ['Path', 'LiteralPath'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = ['cvpa'] as const;

  execute(ctx: CmdletContext): PSValue {
    const literal = ctx.named['literalpath'] !== undefined;
    const results: PSValue[] = pathInputs(ctx).flatMap(typed => resolvedPaths(ctx, typed, literal)).map(absolute => providerPathOf(ctx, absolute));
    return results.length === 0 ? null : results.length === 1 ? results[0] : results;
  }
}

function relativePathFrom(base: string, absolute: string): string {
  const from = base.replace(/\\+$/, '').split('\\');
  const to = absolute.replace(/\\+$/, '').split('\\');
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared].toLowerCase() === to[shared].toLowerCase()) shared++;
  if (shared === 0) return absolute;
  const up = from.length - shared;
  const down = to.slice(shared);
  const prefix = up === 0 ? '.' : Array.from({ length: up }, () => '..').join('\\');
  return down.length === 0 ? prefix : `${prefix}\\${down.join('\\')}`;
}

// ─── Get-ChildItem ────────────────────────────────────────────────────────

function locatedPath(ctx: CmdletContext, typed: string): string {
  return typed === '' ? typed : ctx.runtime.locations.resolve(typed) ?? typed;
}

function pathArgOf(ctx: CmdletContext, fallback = ''): string {
  const literal = ctx.named['literalpath'];
  return locatedPath(ctx, literal !== undefined ? psValueToString(literal) : psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? fallback));
}

export class GetChildItemCmdlet implements ICmdlet {
  readonly name = 'get-childitem';
  readonly parameters = ['Path', 'LiteralPath', 'Filter', 'Include', 'Exclude', 'Recurse', 'Depth', 'Force', 'Name', 'Attributes', 'Directory', 'File', 'Hidden', 'ReadOnly', 'System'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly displayName = 'Get-ChildItem';
  readonly switchParameters = ['Recurse', 'Force', 'Name', 'Directory', 'File', 'Hidden', 'ReadOnly', 'System'] as const;
  readonly aliases = ['ls', 'dir', 'gci'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = ctx.named['path'] !== undefined || ctx.named['literalpath'] !== undefined
      || ctx.positional[0] !== undefined
      ? pathArgOf(ctx, '.')
      : locatedPath(ctx, pipedPath(ctx.pipeInput) ?? '.');
    const literal = ctx.named['literalpath'] !== undefined;
    const filter  = ctx.named['filter']  ? psValueToString(ctx.named['filter'])  : null;
    const recurse = ctx.named['recurse'] === true || ctx.named['recurse'] === 'true';
    const depth   = ctx.named['depth'] !== undefined ? Number(ctx.named['depth']) : undefined;
    const onlyFiles = ctx.named['file']      === true;
    const onlyDirs  = ctx.named['directory'] === true;
    const nameOnly  = ctx.named['name']      === true;

    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      // Returns a formatted listing string; the cmdlet layer wraps strings
      // transparently so callers see a familiar Get-ChildItem output.
      return ctx.providers.registry.getChildItem(path);
    }

    const namespace = namespaceTarget(path);
    if (namespace !== null) return listNamespace(ctx, namespace, nameOnly);

    const fs = ctx.providers.filesystem;
    if (!fs) {
      if (path !== '.') ctx.emitError(`Cannot find path '${path}' because it does not exist.`);
      return [];
    }

    const wanted = this.attributeFilter(ctx);
    if (wanted === null) return [];

    const listed = path === '.' ? fs.getCwd() : path;
    const roots = (literal || !hasWildcard(listed) ? [listed] : expandPathSpec(fs, listed))
      .map(root => (root === '.' ? root : fs.normalizePath(root, fs.getCwd())));
    if (roots.length === 0) {
      ctx.emitError(`Get-ChildItem : Cannot find path '${path}' because it does not exist.`);
      return [];
    }

    const items: PSValue[] = [];
    for (const root of roots) {
      if (root !== '.' && !fs.exists(root)) {
        ctx.emitError(`Cannot find path '${root}' because it does not exist.`);
        continue;
      }
      if (root !== '.' && !fs.isDirectory(root)) {
        items.push(itemObject(fs, root));
        continue;
      }
      items.push(...this.collect(fs, root, recurse, depth, 0, wanted));
    }

    let kept = items;
    if (filter) {
      const pat = wildcardToRegex(filter);
      kept = kept.filter(item => pat.test(psValueToString((item as Record<string, PSValue>)['Name'])));
    }
    const include = patternList(ctx.named['include']);
    if (include.length > 0) {
      kept = kept.filter(item => include.some(
        p => wildcardMatches(p, psValueToString((item as Record<string, PSValue>)['Name']))));
    }
    const exclude = patternList(ctx.named['exclude']);
    if (exclude.length > 0) {
      kept = kept.filter(item => !exclude.some(
        p => wildcardMatches(p, psValueToString((item as Record<string, PSValue>)['Name']))));
    }
    if (onlyFiles) {
      kept = kept.filter(item => !(item as Record<string, PSValue>)['PSIsContainer']);
    }
    if (onlyDirs) {
      kept = kept.filter(item => (item as Record<string, PSValue>)['PSIsContainer']);
    }
    if (nameOnly) {
      return kept.map(item => (item as Record<string, PSValue>)['Name']) as PSValue;
    }
    return kept;
  }

  private attributeFilter(ctx: CmdletContext): ((attrs: ReadonlySet<string>) => boolean) | null {
    const spec = ctx.named['attributes'];
    if (spec !== undefined) {
      const asked = parseAttributeNames(psValueToString(spec));
      if (asked === null) {
        ctx.emitError(`Get-ChildItem : Cannot convert value "${psValueToString(spec)}" to type `
          + `"System.IO.FileAttributes". Invalid attribute name.`);
        return null;
      }
      return attrs => asked.every(a => attrs.has(a));
    }
    const only: string[] = [];
    for (const flag of ['hidden', 'system', 'readonly'] as const) {
      if (ctx.named[flag] === true) only.push(flag);
    }
    if (only.length > 0) return attrs => only.every(a => attrs.has(a));
    if (ctx.named['force'] === true) return () => true;
    return isDefaultVisible;
  }

  private collect(
    fs: NonNullable<CmdletContext['providers']['filesystem']>,
    dir: string, recurse: boolean, depth: number | undefined, level: number,
    wanted: (attrs: ReadonlySet<string>) => boolean,
  ): PSValue[] {
    const entries = fs.listDir(dir).filter(e => wanted(e.attributes ?? new Set<string>()));
    const out: PSValue[] = entries.map(e => entryObject(dir, e));
    if (recurse && (depth === undefined || level < depth)) {
      for (const e of entries) {
        if (e.isDirectory) out.push(...this.collect(fs, joinPath(dir, e.name), recurse, depth, level + 1, wanted));
      }
    }
    return out;
  }
}

const FILE_SYSTEM_PREFIX = 'Microsoft.PowerShell.Core\\FileSystem::';

const ATTRIBUTE_ORDER = ['readonly', 'hidden', 'system', 'directory', 'archive', 'normal', 'reparsepoint', 'offline', 'notcontentindexed'] as const;

function attributesText(isDirectory: boolean, attributes: ReadonlySet<string>): string {
  const present = new Set(attributes);
  if (isDirectory) present.add('directory');
  return ATTRIBUTE_ORDER.filter(name => present.has(name))
    .map(name => (name === 'readonly' ? 'ReadOnly' : name === 'notcontentindexed' ? 'NotContentIndexed' : name === 'reparsepoint' ? 'ReparsePoint' : name.charAt(0).toUpperCase() + name.slice(1)))
    .join(', ');
}

function renderedAs<T extends object>(record: T, text: () => string): T {
  Object.defineProperty(record, 'toString', { value: text, enumerable: false });
  return record;
}

function directoryInfo(path: string, shown: 'name' | 'full'): Record<string, PSValue> {
  const isRoot = parentPathOf(path) === '';
  const name = isRoot ? path : baseNameOf(path);
  const record: Record<string, PSValue> = { Name: name, FullName: path, Exists: true, PSIsContainer: true };
  renderedAs(record, () => (shown === 'name' ? name : path));
  Object.defineProperty(record, 'Parent', { get: () => (isRoot ? null : directoryInfo(parentPathOf(path), 'name')), enumerable: false });
  return record;
}

function rootOf(path: string): string {
  const letter = /^([A-Za-z]):/.exec(path)?.[1];
  return letter === undefined ? '\\' : `${letter.toUpperCase()}:\\`;
}

function entryObject(dir: string, e: DirEntry, shown: 'name' | 'full' = 'name'): PSValue {
  const fullName = joinPath(dir, e.name);
  const attributes = e.attributes ?? new Set<string>();
  const driveName = (/^([A-Za-z]):/.exec(fullName)?.[1] ?? 'C').toUpperCase();
  const record: Record<string, PSValue> = {
    Name: e.name,
    FullName: fullName,
    Extension: e.isDirectory ? '' : (e.name.includes('.') ? e.name.slice(e.name.lastIndexOf('.')) : ''),
    BaseName: e.isDirectory
      ? e.name
      : (e.name.includes('.') ? e.name.slice(0, e.name.lastIndexOf('.')) : e.name),
    Length: e.isDirectory ? null : e.size,
    Mode: modeOf(e.isDirectory, attributes),
    PSIsContainer: e.isDirectory,
    LastWriteTime: e.mtime,
    CreationTime: e.ctime ?? null,
    Attributes: attributesText(e.isDirectory, attributes),
    IsReadOnly: attributes.has('readonly'),
    Exists: true,
    PSPath: `${FILE_SYSTEM_PREFIX}${fullName}`,
    PSParentPath: `${FILE_SYSTEM_PREFIX}${dir}`,
    PSChildName: e.name,
    PSDrive: namedRecord(driveName, driveName),
    PSProvider: namedRecord('FileSystem', 'Microsoft.PowerShell.Core\\FileSystem'),
  };
  if (e.isDirectory) {
    record['Parent'] = directoryInfo(dir, 'name');
    record['Root'] = directoryInfo(rootOf(fullName), 'full');
  } else {
    record['Directory'] = directoryInfo(dir, 'full');
    record['DirectoryName'] = dir;
  }
  renderedAs(record, () => (shown === 'name' ? e.name : fullName));
  return record;
}

function modeOf(isDirectory: boolean, attrs: ReadonlySet<string>): string {
  return [
    isDirectory ? 'd' : '-',
    attrs.has('archive') ? 'a' : '-',
    attrs.has('readonly') ? 'r' : '-',
    attrs.has('hidden') ? 'h' : '-',
    attrs.has('system') ? 's' : '-',
    '-',
  ].join('');
}

// ─── Get-Content ─────────────────────────────────────────────────────────

export class GetContentCmdlet implements ICmdlet {
  readonly name = 'get-content';
  readonly displayName = 'Get-Content';
  readonly parameters = ['Path', 'LiteralPath', 'ReadCount', 'TotalCount', 'First', 'Head', 'Tail', 'Last', 'Filter', 'Include', 'Exclude', 'Force', 'Raw', 'Encoding', 'Delimiter', 'Wait', 'Stream', 'AsByteStream'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = ['cat', 'type', 'gc'] as const;

  execute(ctx: CmdletContext): PSValue {
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    if (ctx.named['stream'] !== undefined) {
      ctx.emitError('Get-Content : -Stream is not supported in this simulator: '
        + 'the file system has no alternate data streams.');
      return null;
    }
    if (ctx.named['wait'] === true) {
      ctx.emitError('Get-Content : -Wait is not supported in this simulator: '
        + 'the engine is synchronous, so a file cannot be followed as it grows.');
      return null;
    }

    const literal = ctx.named['literalpath'];
    const specs = (literal !== undefined
      ? pathListOf(literal)
      : pathListOf(ctx.named['path'] ?? ctx.positional[0] ?? '')).map(spec => locatedPath(ctx, spec));
    if (specs.length === 0) return null;

    const namespace = namespaceTarget(specs[0]);
    if (namespace !== null) return readNamespaceContent(ctx, namespace);
    if (isRegistryPath(specs[0])) {
      ctx.emitError(CONTENT_NOT_SUPPORTED);
      return null;
    }

    const targets: string[] = [];
    for (const spec of specs) {
      const matched = literal !== undefined ? [spec] : expandPathSpec(fs, spec);
      if (matched.length === 0) {
        ctx.emitError(`Get-Content : Cannot find path '${spec}' because it does not exist.`);
        continue;
      }
      targets.push(...matched);
    }
    if (targets.length === 0) return null;

    let text = '';
    for (const target of targets) {
      try { text += fs.readFile(target); }
      catch { ctx.emitError(`Get-Content : Cannot find path '${target}' because it does not exist.`); }
    }

    if (ctx.named['asbytestream'] === true) {
      return [...text].map(ch => ch.charCodeAt(0)) as unknown as PSValue;
    }
    if (ctx.named['raw'] === true || ctx.named['raw'] === 'true') return text;

    const delimiter = ctx.named['delimiter'] !== undefined
      ? psValueToString(ctx.named['delimiter']) : null;
    let pieces = delimiter !== null && delimiter !== ''
      ? text.split(delimiter)
      : text.split(/\r?\n/);
    if (pieces.length > 0 && pieces[pieces.length - 1] === '') pieces.pop();

    const head = firstNumberOf(ctx, ['totalcount', 'first', 'head']);
    const tail = firstNumberOf(ctx, ['tail', 'last']);
    if (tail !== undefined) pieces = pieces.slice(Math.max(0, pieces.length - tail));
    else if (head !== undefined) pieces = pieces.slice(0, head);

    if (Number(ctx.named['readcount'] ?? -1) === 0) return pieces as unknown as PSValue;
    if (pieces.length === 1) return pieces[0] as PSValue;
    return pieces as unknown as PSValue;
  }
}

function pathListOf(value: PSValue): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(psValueToString).filter(p => p !== '');
}

function firstNumberOf(ctx: CmdletContext, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    if (ctx.named[key] !== undefined) return Number(ctx.named[key]);
  }
  return undefined;
}

// ─── Set-Content ─────────────────────────────────────────────────────────

export class SetContentCmdlet implements ICmdlet {
  readonly name = 'set-content';
  readonly parameters = ['Path', 'LiteralPath', 'Value', 'Force', 'Encoding', 'PassThru', 'NoNewline', 'Stream', 'Filter', 'Include', 'Exclude'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = ['sc'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path  = pathArgOf(ctx);
    const raw   = ctx.named['value'] ?? ctx.positional[1] ?? ctx.pipeInput ?? '';
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    // PowerShell Set-Content treats each input value as its own line; an
    // array/pipeline writes one value per line (NOT space-joined).
    const lines = Array.isArray(raw) ? raw.map(v => psValueToString(v)) : [psValueToString(raw)];
    const noNewline = ctx.named['nonewline'] === true || ctx.named['nonewline'] === 'true';
    const namespace = namespaceTarget(path);
    if (isRegistryPath(path)) {
      ctx.emitError(CONTENT_NOT_SUPPORTED);
      return null;
    }
    if (namespace !== null) writeNamespaceContent(ctx, namespace, Array.isArray(raw) ? raw : [raw]);
    else fs.writeFile(path, noNewline ? lines.join('') : `${lines.join('\n')}\n`);
    if (ctx.named['passthru'] === true || ctx.named['passthru'] === 'true') {
      return lines.length === 1 ? lines[0] : (lines as unknown as PSValue);
    }
    return null;
  }
}

// ─── Clear-Content ───────────────────────────────────────────────────────

export class ClearContentCmdlet implements ICmdlet {
  readonly name = 'clear-content';
  readonly parameters = ['Path', 'LiteralPath', 'Force', 'Stream', 'Filter', 'Include', 'Exclude'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = ['clc'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = locatedPath(ctx, psValueToString(
      ctx.named['path'] ?? ctx.named['literalpath'] ?? ctx.positional[0] ?? ''));
    if (path === '') {
      ctx.emitError("Clear-Content : Cannot bind argument to parameter 'Path' because it is an empty string.");
      return null;
    }
    if (namespaceTarget(path) !== null || isRegistryPath(path)) {
      ctx.emitError(namespaceTarget(path) !== null ? CLEAR_CONTENT_REFUSAL : CONTENT_NOT_SUPPORTED);
      return null;
    }
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    if (!fs.exists(path)) {
      ctx.emitError(`Clear-Content : Cannot find path '${path}' because it does not exist.`);
      return null;
    }
    fs.writeFile(path, '');
    return null;
  }
}

// ─── Add-Content ─────────────────────────────────────────────────────────

export class AddContentCmdlet implements ICmdlet {
  readonly name = 'add-content';
  readonly parameters = ['Path', 'LiteralPath', 'Value', 'Force', 'Encoding', 'PassThru', 'NoNewline', 'Stream', 'Filter', 'Include', 'Exclude'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = ['ac'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path  = pathArgOf(ctx);
    const raw   = ctx.named['value'] ?? ctx.positional[1] ?? ctx.pipeInput ?? '';
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    const namespace = namespaceTarget(path);
    if (namespace !== null || isRegistryPath(path)) {
      ctx.emitError(namespace !== null ? seekRefusal(namespace) : CONTENT_NOT_SUPPORTED);
      return null;
    }
    const lines = Array.isArray(raw) ? raw.map(v => psValueToString(v)) : [psValueToString(raw)];
    // PowerShell Add-Content treats each input value as a line and ensures the
    // file ends with a trailing newline so subsequent appends start fresh.
    const existing = (() => { try { return fs.readFile(path); } catch { return ''; } })();
    const needsLeadingNl = existing.length > 0 && !/[\r\n]$/.test(existing);
    const payload = (needsLeadingNl ? '\n' : '') + lines.join('\n') + '\n';
    fs.appendFile(path, payload);
    return null;
  }
}

// ─── New-Item ─────────────────────────────────────────────────────────────

type FileSystemItemType = 'directory' | 'file' | 'symboliclink' | 'junction' | 'hardlink';

const ITEM_TYPE_WORDS: ReadonlyArray<readonly [string, FileSystemItemType]> = [
  ['directory', 'directory'],
  ['container', 'directory'],
  ['file', 'file'],
  ['symboliclink', 'symboliclink'],
  ['junction', 'junction'],
  ['hardlink', 'hardlink'],
];

const UNKNOWN_ITEM_TYPE = 'The type is not a known type for the file system. Only "file","directory" or "symboliclink" can be specified.';

function fileSystemItemType(typed: string): FileSystemItemType | null {
  if (typed === '') return 'file';
  return ITEM_TYPE_WORDS.find(([word]) => wildcardMatches(`${typed}*`, word))?.[1] ?? null;
}

function childPath(ctx: CmdletContext, container: string, name: string): string {
  const parent = locatedPath(ctx, container === '' ? '.' : container);
  return `${parent.replace(/[\\/]+$/, '')}\\${name}`;
}

function newItemFailure(
  ctx: CmdletContext,
  failure: { message: string; exceptionType: string; errorId: string; category: string; target: string | null },
): null {
  ctx.emitErrorRecord(newErrorRecord({
    message: failure.message,
    exceptionType: failure.exceptionType,
    category: failure.category,
    targetObject: failure.target,
    fullyQualifiedErrorId: `${failure.errorId},Microsoft.PowerShell.Commands.NewItemCommand`,
  }) as unknown as PSValue);
  return null;
}

const IO_FAILURE = { exceptionType: 'System.IO.IOException', category: 'WriteError', errorId: 'NewItemIOError' } as const;

export class NewItemCmdlet implements ICmdlet {
  readonly name = 'new-item';
  readonly parameters = ['Path', 'Name', 'ItemType', 'Value', 'Force'] as const;
  readonly parameterValues = { Path: 'path' } as const;
  readonly aliases = ['ni'] as const;

  execute(ctx: CmdletContext): PSValue {
    const containers = pathInputs(ctx);
    const name = ctx.named['name'] === undefined ? '' : psValueToString(ctx.named['name']);
    if (containers.length === 0 && ctx.named['name'] === undefined) {
      ctx.emitError('New-Item : Cannot process command because of one or more missing mandatory parameters: Path.');
      return null;
    }
    const created = (containers.length === 0 ? [''] : containers)
      .map(container => this.create(ctx, name === '' ? locatedPath(ctx, container) : childPath(ctx, container, name)))
      .filter(item => item !== null);
    return created.length === 0 ? null : created.length === 1 ? created[0] : created;
  }

  private create(ctx: CmdletContext, path: string): PSValue {
    const force = ctx.named['force'] === true;
    const namespace = namespaceTarget(path);
    if (namespace !== null) return newNamespaceItem(ctx, namespace, ctx.named['value'], force);

    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      const created = ctx.providers.registry.newItem(path, force);
      const value = ctx.named['value'];
      if (value !== undefined && !created.startsWith('New-Item :')) {
        const failure = ctx.providers.registry.setItemProperty(path, '(default)', psValueToString(value));
        if (failure !== '') ctx.emitError(failure);
      }
      return created;
    }

    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    const kind = fileSystemItemType(psValueToString(ctx.named['itemtype'] ?? ctx.named['type'] ?? ''));
    if (kind === null) {
      return newItemFailure(ctx, {
        message: `${UNKNOWN_ITEM_TYPE}\nParameter name: type`,
        exceptionType: 'System.Management.Automation.ParentContainsErrorRecordException',
        errorId: 'Argument',
        category: 'InvalidArgument',
        target: null,
      });
    }
    if (kind === 'symboliclink' || kind === 'hardlink' || kind === 'junction') {
      ctx.emitError(`New-Item : -ItemType ${kind} is not supported in this simulator: `
        + 'the file system has no links.');
      return null;
    }
    const absolute = fs.normalizePath(path, fs.getCwd());
    if (kind === 'directory') {
      if (!force && fs.exists(absolute)) {
        return newItemFailure(ctx, {
          message: `An item with the specified name ${absolute} already exists.`,
          exceptionType: 'System.IO.IOException',
          errorId: 'DirectoryExist',
          category: 'ResourceExists',
          target: absolute,
        });
      }
      fs.createDir(absolute);
      return itemObject(fs, absolute);
    }
    if (!force && fs.exists(absolute)) {
      return newItemFailure(ctx, { ...IO_FAILURE, message: `The file '${absolute}' already exists.`, target: absolute });
    }
    if (force) fs.createDir(parentPathOf(absolute));
    try {
      fs.createFile(absolute);
      if (ctx.named['value'] !== undefined) fs.writeFile(absolute, psValueToString(ctx.named['value']));
    } catch (error) {
      return newItemFailure(ctx, { ...IO_FAILURE, message: error instanceof Error ? error.message : String(error), target: absolute });
    }
    return itemObject(fs, absolute);
  }
}

// ─── Remove-Item ─────────────────────────────────────────────────────────

export class RemoveItemCmdlet implements ICmdlet {
  readonly name = 'remove-item';
  readonly parameters = ['Path', 'LiteralPath', 'Filter', 'Include', 'Exclude', 'Recurse', 'Force', 'Stream'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = ['rm', 'del', 'ri', 'rmdir', 'erase', 'rd'] as const;

  execute(ctx: CmdletContext): PSValue {
    const recurse = ctx.named['recurse'] === true;

    const targets = pathInputs(ctx);
    if (targets.length === 0) return null;

    for (const path of targets.map(target => locatedPath(ctx, target))) {
      if (path === '') {
        ctx.emitError("Remove-Item : Cannot bind argument to parameter 'Path' because it is an empty string.");
        continue;
      }
      const namespace = namespaceTarget(path);
      if (namespace !== null) {
        removeNamespaceItems(ctx, namespace);
        continue;
      }
      if (isRegistryPath(path)) {
        if (!ctx.providers.registry) requireRegistryProvider(path);
        const failure = ctx.providers.registry.removeItem(path, recurse);
        if (failure !== '') ctx.emitError(failure);
        continue;
      }
      const fs = ctx.providers.filesystem;
      if (!fs) return null;
      if (!recurse && fs.exists(path) && fs.isDirectory(path) && fs.listDir(path).length > 0) {
        ctx.emitError(`Remove-Item : The item at ${path} has children and the Recurse `
          + `parameter was not specified. If you continue, all children will be removed with `
          + `the item. It is a directory.`);
        continue;
      }
      try { fs.remove(path, recurse); }
      catch (e) { ctx.emitError(e instanceof Error ? e.message : String(e)); }
    }
    return null;
  }
}

// ─── Copy-Item ────────────────────────────────────────────────────────────

export class CopyItemCmdlet implements ICmdlet {
  readonly name = 'copy-item';
  readonly displayName = 'Copy-Item';
  readonly parameters = ['Path', 'LiteralPath', 'Destination', 'Filter', 'Include', 'Exclude', 'Recurse', 'Force', 'PassThru', 'Container', 'WhatIf', 'Confirm', 'Credential', 'ToSession', 'FromSession'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path', Destination: 'path' } as const;
  readonly aliases = ['cp', 'copy', 'cpi'] as const;

  execute(ctx: CmdletContext): PSValue {
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    if (ctx.named['tosession'] !== undefined || ctx.named['fromsession'] !== undefined) {
      ctx.emitError('Copy-Item : -ToSession / -FromSession are not supported in this simulator: '
        + 'there is no PowerShell remoting file transfer.');
      return null;
    }

    const literal = ctx.named['literalpath'] !== undefined;
    const spec = psValueToString(
      ctx.named['path'] ?? ctx.named['literalpath'] ?? ctx.positional[0]
      ?? pipedPath(ctx.pipeInput) ?? '');
    const dest = psValueToString(ctx.named['destination'] ?? ctx.positional[1] ?? '');
    if (!spec || !dest) {
      ctx.emitError('Copy-Item : Both -Path and -Destination are required.');
      return null;
    }

    const fromNamespace = namespaceTarget(locatedPath(ctx, spec));
    const toNamespace = namespaceTarget(locatedPath(ctx, dest));
    if (fromNamespace !== null && toNamespace !== null) return copyNamespaceItem(ctx, fromNamespace, toNamespace, ctx.named['passthru'] === true);
    if (fromNamespace !== null || toNamespace !== null) {
      ctx.emitError(COPY_ACROSS_PROVIDERS);
      return null;
    }

    const sources = literal ? [spec] : expandPathSpec(fs, spec);
    if (sources.length === 0) {
      ctx.emitError(`Copy-Item : Cannot find path '${spec}' because it does not exist.`);
      return null;
    }
    const kept = sources.filter(source => nameSurvivesFilters(ctx, baseNameOf(source)));

    const recurse = ctx.named['recurse'] === true;
    const whatIf = ctx.named['whatif'] === true;
    const many = kept.length > 1 || (!literal && hasWildcard(spec));
    const copied: PSValue[] = [];
    if (many && !whatIf && !fs.exists(dest)) fs.createDir(dest);

    for (const source of kept) {
      if (!fs.exists(source)) {
        ctx.emitError(`Copy-Item : Cannot find path '${source}' because it does not exist.`);
        continue;
      }
      const target = many || (fs.exists(dest) && fs.isDirectory(dest) && !fs.isDirectory(source))
        ? `${dest.replace(/\\+$/, '')}\\${baseNameOf(source)}`
        : dest;
      if (whatIf) {
        ctx.emit(`What if: Performing the operation "Copy ${fs.isDirectory(source) ? 'Directory' : 'File'}" `
          + `on target "Item: ${source} Destination: ${target}".`);
        continue;
      }
      try {
        if (fs.isDirectory(source)) this.copyTree(ctx, fs, source, target, recurse);
        else fs.copy(source, target);
      } catch (e) {
        ctx.emitError(e instanceof Error ? e.message : String(e));
        continue;
      }
      if (ctx.named['passthru'] === true) copied.push(itemObject(fs, target));
    }

    if (copied.length === 0) return null;
    return (copied.length === 1 ? copied[0] : copied) as PSValue;
  }

  private copyTree(
    ctx: CmdletContext, fs: NonNullable<CmdletContext['providers']['filesystem']>,
    source: string, target: string, recurse: boolean,
  ): void {
    if (!fs.exists(target)) fs.createDir(target);
    if (!recurse) return;
    for (const entry of fs.listDir(source)) {
      if (!nameSurvivesFilters(ctx, entry.name)) continue;
      const from = `${source}\\${entry.name}`;
      const to = `${target}\\${entry.name}`;
      if (entry.isDirectory) this.copyTree(ctx, fs, from, to, recurse);
      else fs.copy(from, to);
    }
  }
}

function baseNameOf(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '');
  const cut = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
  return cut === -1 ? cleaned : cleaned.slice(cut + 1);
}

function pipedPath(pipeInput: PSValue): string | null {
  const first = Array.isArray(pipeInput) ? pipeInput[0] : pipeInput;
  if (first === null || first === undefined) return null;
  return typeof first === 'string' ? first : boundPathOf(first) ?? null;
}

export function expandPathSpec(
  fs: NonNullable<CmdletContext['providers']['filesystem']>, spec: string,
): string[] {
  if (!hasWildcard(spec)) return fs.exists(spec) ? [spec] : [];
  const dir = parentPathOf(spec);
  const pattern = baseNameOf(spec);
  if (!fs.exists(dir) || !fs.isDirectory(dir)) return [];
  const matcher = wildcardToRegex(pattern);
  return fs.listDir(dir)
    .filter(entry => matcher.test(entry.name))
    .map(entry => `${dir.replace(/\\+$/, '')}\\${entry.name}`);
}

function nameSurvivesFilters(ctx: CmdletContext, name: string): boolean {
  const filter = ctx.named['filter'] !== undefined ? psValueToString(ctx.named['filter']) : null;
  if (filter !== null && !wildcardMatches(filter, name)) return false;
  const include = patternList(ctx.named['include']);
  if (include.length > 0 && !include.some(p => wildcardMatches(p, name))) return false;
  const exclude = patternList(ctx.named['exclude']);
  if (exclude.some(p => wildcardMatches(p, name))) return false;
  return true;
}

function patternList(value: PSValue): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(psValueToString).filter(p => p !== '');
}

function itemObject(
  fs: NonNullable<CmdletContext['providers']['filesystem']>, path: string,
): PSValue {
  const absolute = fs.normalizePath(path, fs.getCwd());
  const parent = parentPathOf(absolute);
  const name = baseNameOf(absolute);
  const found = parent === '' ? undefined : fs.listDir(parent)
    .find(entry => entry.name.toLowerCase() === name.toLowerCase());
  if (found !== undefined) return entryObject(parent, found, 'full');
  const isDir = fs.exists(absolute) && fs.isDirectory(absolute);
  if (parent === '') return directoryInfo(absolute, 'full');
  const record: Record<string, PSValue> = {
    Name: name,
    FullName: absolute,
    PSIsContainer: isDir,
    Extension: isDir ? '' : (name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''),
    Mode: isDir ? 'd-----' : '-a----',
  };
  return renderedAs(record, () => absolute);
}

// ─── Move-Item ────────────────────────────────────────────────────────────

export class MoveItemCmdlet implements ICmdlet {
  readonly name = 'move-item';
  readonly parameters = ['Path', 'LiteralPath', 'Destination', 'Filter', 'Include', 'Exclude', 'Force', 'PassThru'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path', Destination: 'path' } as const;
  readonly aliases = ['mv', 'move', 'mi'] as const;

  execute(ctx: CmdletContext): PSValue {
    const named = ctx.named['path'] !== undefined || ctx.named['literalpath'] !== undefined || ctx.positional[0] !== undefined;
    const src  = named ? pathArgOf(ctx) : pipedPath(ctx.pipeInput) ?? '';
    const dest = psValueToString(ctx.named['destination'] ?? ctx.positional[1] ?? '');
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    fs.move(src, dest);
    return null;
  }
}

// ─── Rename-Item ─────────────────────────────────────────────────────────
// Same provider call as Move-Item but with a sibling-name new path.

export class RenameItemCmdlet implements ICmdlet {
  readonly name = 'rename-item';
  readonly parameters = ['Path', 'LiteralPath', 'NewName', 'Force', 'PassThru'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = ['ren', 'rni'] as const;

  execute(ctx: CmdletContext): PSValue {
    const src     = pathArgOf(ctx) || (pipedPath(ctx.pipeInput) ?? '');
    const newName = psValueToString(ctx.named['newname'] ?? ctx.positional[1] ?? '');
    if (!src || !newName) {
      ctx.emitError('Rename-Item requires -Path and -NewName');
      return null;
    }
    const namespace = namespaceTarget(src);
    if (namespace !== null) return renameNamespaceItem(ctx, namespace, newName, ctx.named['force'] === true, ctx.named['passthru'] === true);
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    // -NewName is a sibling name; build the destination from the parent dir.
    const parent = src.replace(/[\\/][^\\/]*$/, '') || '.';
    const dest = parent === '.' ? newName : `${parent}\\${newName}`;
    fs.move(src, dest);
    return null;
  }
}

// ─── mkdir / md (function-style alias for `New-Item -ItemType Directory`) ─

export class MkdirCmdlet implements ICmdlet {
  readonly name = 'mkdir';
  readonly parameters = ['Path', 'Name', 'ItemType', 'Value', 'Force'] as const;
  readonly parameterValues = { Path: 'path' } as const;
  readonly aliases = ['md'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    if (!path) { ctx.emitError('mkdir requires a path'); return null; }
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    fs.createDir(path);
    return { Name: path, FullName: path, ItemType: 'directory' } as Record<string, PSValue>;
  }
}

// ─── Out-File ─────────────────────────────────────────────────────────────

export class OutFileCmdlet implements ICmdlet {
  readonly name = 'out-file';
  readonly parameters = ['FilePath', 'LiteralPath', 'Encoding', 'Append', 'Force', 'NoClobber', 'Width', 'NoNewline'] as const;
  readonly parameterValues = { FilePath: 'path', LiteralPath: 'path' } as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const filePath = psValueToString(ctx.named['filepath'] ?? ctx.named['literalpath'] ?? ctx.named['path'] ?? ctx.positional[0] ?? '');
    const append   = ctx.named['append'] === true;
    const input    = ctx.pipeInput ?? ctx.positional[0] ?? '';
    const content  = typeof input === 'string' ? input
      : Array.isArray(input) ? (input as PSValue[]).map(v => psValueToString(v)).join('\n')
      : psValueToString(input);
    const fs = ctx.providers.filesystem;
    if (!fs || !filePath) return null;
    if (append) fs.appendFile(filePath, content);
    else        fs.writeFile(filePath,  content);
    return null;
  }
}

// ─── Get-ItemProperty / Set-ItemProperty / Remove-ItemProperty ──────────────
// Currently registry-only — the legacy executor handles the (rare) filesystem
// equivalents (file attributes), so we throw "not recognized" there to fall
// back transparently.

/**
 * Re-join positional path fragments back into a single registry path. The
 * lexer splits `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion` into
 * two tokens at the space, so the cmdlet receives them as separate
 * positional arguments — we glue them back together with a space.
 */
function joinPathPositionals(ctx: CmdletContext): string {
  return locatedPath(ctx, ctx.named['path'] ? psValueToString(ctx.named['path']) : ctx.positional.map(psValueToString).join(' ').trim());
}

export class GetItemPropertyCmdlet implements ICmdlet {
  readonly name = 'get-itemproperty';
  readonly parameters = ['Path', 'LiteralPath', 'Name', 'Filter', 'Include', 'Exclude'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly displayName = 'Get-ItemProperty';
  readonly aliases = ['gp'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = joinPathPositionals(ctx);
    const name = ctx.named['name'] ? psValueToString(ctx.named['name']) : undefined;
    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      const reg = ctx.providers.registry;
      if (reg.getItemPropertyValues) {
        const values = reg.getItemPropertyValues(path);
        if (values === null) {
          ctx.emitError(`Cannot find path '${path}' because it does not exist.`);
          return null;
        }
        if (name) {
          const key = Object.keys(values).find(k => k.toLowerCase() === name.toLowerCase());
          if (!key) {
            ctx.emitError(`Property '${name}' does not exist at path '${path}'.`);
            return null;
          }
          return { [key]: values[key] } as Record<string, PSValue>;
        }
        return values as Record<string, PSValue>;
      }
      return reg.getItemProperty(path, name);
    }
    requireRegistryProvider(path); // throws "not recognized" — fallback to executor for FS attrs
    return null;
  }
}

export class SetItemPropertyCmdlet implements ICmdlet {
  readonly name = 'set-itemproperty';
  readonly parameters = ['Path', 'LiteralPath', 'Name', 'Value', 'Force', 'PassThru', 'Type'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly displayName = 'Set-ItemProperty';
  readonly aliases = ['sp'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path  = pathArgOf(ctx);
    const name  = psValueToString(ctx.named['name']  ?? ctx.positional[1] ?? '');
    const raw   = ctx.named['value'] ?? ctx.positional[2];
    const value = typeof raw === 'number' ? raw : psValueToString(raw ?? '');
    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      return ctx.providers.registry.setItemProperty(path, name, value);
    }
    if (hivePathMissingDrive(path)) {
      reportMissingDrive(ctx, 'Set-ItemProperty', path);
      return null;
    }
    requireRegistryProvider(path);
    return null;
  }
}

/**
 * `New-ItemProperty` — crée une valeur dans une clé de registre.
 *
 * C'est la commande par laquelle on *ajoute* une valeur, là où
 * `Set-ItemProperty` en modifie une : les deux écrivent, mais un script
 * d'installation (ou de persistance) utilise la première. Elle
 * n'existait pas du tout, si bien qu'une ligne
 * `New-ItemProperty ... -PropertyType String` ne posait rien et ne
 * disait rien — l'écriture disparaissait en silence.
 *
 * `-PropertyType` décide du type stocké : `DWord`/`QWord` gardent un
 * nombre, tout le reste une chaîne.
 */
export class NewItemPropertyCmdlet implements ICmdlet {
  readonly name = 'new-itemproperty';
  readonly parameters = ['Path', 'LiteralPath', 'Name', 'Value', 'PropertyType', 'Force', 'PassThru'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly displayName = 'New-ItemProperty';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[1] ?? '');
    const raw  = ctx.named['value'] ?? ctx.positional[2];
    const kind = psValueToString(ctx.named['propertytype'] ?? '').toLowerCase();
    const numeric = kind === 'dword' || kind === 'qword';
    const value: string | number = numeric
      ? Number(psValueToString(raw ?? '0'))
      : (typeof raw === 'number' ? raw : psValueToString(raw ?? ''));
    if (!path) { ctx.emitError('New-ItemProperty requires -Path'); return null; }
    if (!name) { ctx.emitError('New-ItemProperty requires -Name'); return null; }

    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      const reg = ctx.providers.registry;
      // Sans `-Force`, PowerShell exige que la clé existe déjà ; le
      // fournisseur le dit lui-même par son message d'erreur.
      const err = reg.setItemProperty(path, name, value);
      if (err) { ctx.emitError(err); return null; }
      return { [name]: value } as Record<string, PSValue>;
    }
    if (hivePathMissingDrive(path)) {
      reportMissingDrive(ctx, 'New-ItemProperty', path);
      return null;
    }
    requireRegistryProvider(path);
    return null;
  }
}

export class RemoveItemPropertyCmdlet implements ICmdlet {
  readonly name = 'remove-itemproperty';
  readonly parameters = ['Path', 'LiteralPath', 'Name', 'Force', 'Include', 'Exclude', 'Filter'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly displayName = 'Remove-ItemProperty';
  readonly aliases = ['rp'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[1] ?? '');
    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      return ctx.providers.registry.removeItemProperty(path, name);
    }
    if (hivePathMissingDrive(path)) {
      reportMissingDrive(ctx, 'Remove-ItemProperty', path);
      return null;
    }
    requireRegistryProvider(path);
    return null;
  }
}

/**
 * `Clear-ItemProperty` — reset a registry value to its type-default (empty
 * string for REG_SZ, 0 for REG_DWORD) without removing the value itself.
 * Implemented on top of `setItemProperty` so it works against any registry
 * provider that supports writes.
 */
export class ClearItemPropertyCmdlet implements ICmdlet {
  readonly name = 'clear-itemproperty';
  readonly parameters = ['Path', 'LiteralPath', 'Name', 'Force', 'Include', 'Exclude', 'Filter'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = ['clp'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[1] ?? '');
    if (!isRegistryPath(path)) {
      ctx.emitError(`Clear-ItemProperty : Cannot find path '${path}' because it does not exist.`);
      return null;
    }
    if (!ctx.providers.registry) requireRegistryProvider(path);
    const reg = ctx.providers.registry;
    const existing = reg.getItemPropertyValues?.(path);
    const current = existing
      ? existing[Object.keys(existing).find(k => k.toLowerCase() === name.toLowerCase()) ?? '']
      : undefined;
    const cleared: string | number = typeof current === 'number' ? 0 : '';
    return reg.setItemProperty(path, name, cleared);
  }
}

// ─── Get-Item / Set-Item ────────────────────────────────────────────────────
// Read / overwrite a filesystem entry. Registry paths fall through to the
// existing item-property cmdlets.

export class GetItemCmdlet implements ICmdlet {
  readonly name = 'get-item';
  readonly parameters = ['Path', 'LiteralPath', 'Filter', 'Include', 'Exclude', 'Force', 'Stream'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = ['gi'] as const;

  execute(ctx: CmdletContext): PSValue {
    const explicit = ctx.named['path'] ?? ctx.named['literalpath'] ?? ctx.positional[0];
    if (explicit === undefined && ctx.pipeInput !== null && ctx.pipeInput !== undefined) {
      const items = Array.isArray(ctx.pipeInput) ? ctx.pipeInput : [ctx.pipeInput];
      const found = items.map(item => this.fetch(ctx, pathItemOf(item))).filter(entry => entry !== null);
      return found.length === 0 ? null : found.length === 1 ? found[0] : found as PSValue;
    }
    return this.fetch(ctx, pathArgOf(ctx));
  }

  private fetch(ctx: CmdletContext, path: string): PSValue {
    if (!path) { ctx.emitError('Get-Item requires -Path'); return null; }
    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      return ctx.providers.registry.getItem(path);
    }
    const namespace = namespaceTarget(path);
    if (namespace !== null) {
      const entries = listNamespace(ctx, namespace) as PSValue[];
      return entries.length === 0 ? null : entries.length === 1 ? entries[0] : entries;
    }
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    const absolute = fs.normalizePath(path, fs.getCwd());
    const found = ctx.named['literalpath'] === undefined && hasWildcard(path)
      ? expandPathSpec(fs, absolute)
      : fs.exists(absolute) ? [absolute] : [];
    if (found.length === 0) {
      ctx.emitError(`Cannot find path '${path}' because it does not exist.`);
      return null;
    }
    const items = found.map(item => itemObject(fs, item));
    return items.length === 1 ? items[0] : items;
  }
}

export class SetItemCmdlet implements ICmdlet {
  readonly name = 'set-item';
  readonly parameters = ['Path', 'LiteralPath', 'Value', 'Force', 'PassThru', 'Type'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path  = pathArgOf(ctx);
    const value = psValueToString(ctx.named['value'] ?? ctx.positional[1] ?? '');
    if (!path) { ctx.emitError('Set-Item requires -Path'); return null; }
    const namespace = namespaceTarget(path);
    if (namespace !== null) return setNamespaceItem(ctx, namespace, ctx.named['value'] ?? ctx.positional[1] ?? null, ctx.named['passthru'] === true);
    if (isRegistryPath(path)) {
      // Defer to legacy executor (which has rich registry-Set-Item behaviour).
      throw new PSRuntimeError(commandNotFoundMessage('Set-Item on registry paths'));
    }
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    fs.writeFile(path, value);
    return null;
  }
}

// ─── Get-Acl / Set-Acl ──────────────────────────────────────────────────────

function stripAdPathPrefix(path: string): string {
  return path.replace(/^ad:\\?/i, '').replace(/^\\+/, '');
}

function isTruthyPSValue(v: PSValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() !== 'false' && v !== '';
  return Boolean(v);
}

export class GetAclCmdlet implements ICmdlet {
  readonly name = 'get-acl';
  readonly parameters = ['Path', 'LiteralPath', 'InputObject', 'Audit', 'Filter', 'Include', 'Exclude'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    if (/^ad:/i.test(path)) {
      const ad = ctx.providers.ad;
      if (!ad) { ctx.emitError("Get-Acl : Cannot find drive. A drive with the name 'AD' does not exist."); return null; }
      const dn = stripAdPathPrefix(path);
      const rules = ad.getAcl(dn);
      if (rules === null) { ctx.emitError(`Get-Acl : Cannot find path '${path}' because it does not exist.`); return null; }
      const accessArr: PSValue[] = rules.map(r => ({
        IdentityReference: r.identitySam,
        ActiveDirectoryRights: r.rights,
        AccessControlType: r.accessControlType,
        ObjectType: r.objectType,
        InheritanceType: r.inheritanceType,
        InheritedObjectType: r.inheritedObjectType,
        IsInherited: false,
      } as unknown as PSValue));
      const result: Record<string, PSValue> = {
        Path: path,
        Owner: 'MANDENG\\Domain Admins',
        Access: accessArr as PSValue,
        AddAccessRule: ((ace: PSValue) => { accessArr.push(ace); return null; }) as unknown as PSValue,
      };
      return result;
    }
    const fs = ctx.providers.filesystem;
    if (!fs || !path) { ctx.emitError("Get-Acl : Cannot bind argument to parameter 'Path' because it is an empty string."); return null; }
    if (!fs.exists(path)) { ctx.emitError(`Get-Acl : Cannot find path '${path}' because it does not exist.`); return null; }
    const acl = fs.getAcl(path);
    if (!acl) {
      ctx.emitError(`Get-Acl : Cannot retrieve ACL for '${path}'.`);
      return null;
    }
    const accessArr: PSValue[] = acl.acl.map(a => ({
      FileSystemRights:  a.permissions.join(', '),
      AccessControlType: a.type === 'allow' ? 'Allow' : 'Deny',
      IdentityReference: a.principal,
      IsInherited:       false,
    } as unknown as PSValue));
    // La SACL — la liste d'audit — est rendue même sans `-Audit` : sur
    // un vrai Windows le commutateur commande la *lecture* du
    // descripteur, pas la présence de la propriété, et un objet non
    // audité rend simplement une liste vide.
    const auditArr: PSValue[] = (fs.getAudit?.(path) ?? []).map(a => ({
      FileSystemRights:  a.permissions.join(', '),
      AuditFlags:        a.flags.map(f => f === 'success' ? 'Success' : 'Failure').join(', '),
      IdentityReference: a.principal,
      IsInherited:       false,
    } as unknown as PSValue));
    const result: Record<string, PSValue> = {
      Path:  path,
      Owner: acl.owner,
      Group: 'BUILTIN\\Administrators',
      Access: accessArr as PSValue,
      Audit: auditArr as PSValue,
      AddAuditRule: ((rule: PSValue) => { auditArr.push(rule); return null; }) as unknown as PSValue,
      RemoveAuditRule: ((rule: PSValue) => {
        const rec = rule as unknown as Record<string, PSValue>;
        const identity = psValueToString(rec['IdentityReference'] ?? '');
        const idx = auditArr.findIndex(a => psValueToString(
          (a as unknown as Record<string, PSValue>)['IdentityReference'] ?? '') === identity);
        if (idx >= 0) auditArr.splice(idx, 1);
        return null;
      }) as unknown as PSValue,
      AreAccessRulesProtected: false,
      AddAccessRule: ((rule: PSValue) => { accessArr.push(rule); return null; }) as unknown as PSValue,
      // Real .NET FileSystemSecurity.SetAccessRule replaces any existing
      // rule(s) for the same identity + access type instead of appending
      // a duplicate, unlike AddAccessRule.
      SetAccessRule: ((rule: PSValue) => {
        const rec = rule as unknown as Record<string, PSValue>;
        const identity = psValueToString(rec['IdentityReference'] ?? '');
        const type = psValueToString(rec['AccessControlType'] ?? 'Allow');
        const idx = accessArr.findIndex(a => {
          const ar = a as unknown as Record<string, PSValue>;
          return psValueToString(ar['IdentityReference'] ?? '') === identity
            && psValueToString(ar['AccessControlType'] ?? 'Allow') === type;
        });
        if (idx >= 0) accessArr[idx] = rule; else accessArr.push(rule);
        return null;
      }) as unknown as PSValue,
      SetAccessRuleProtection: ((isProtected: PSValue) => {
        result['AreAccessRulesProtected'] = isTruthyPSValue(isProtected);
        return null;
      }) as unknown as PSValue,
    };
    return result;
  }
}

export class SetAclCmdlet implements ICmdlet {
  readonly name = 'set-acl';
  readonly parameters = ['Path', 'LiteralPath', 'AclObject', 'InputObject', 'Passthru'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    if (/^ad:/i.test(path)) {
      const ad = ctx.providers.ad;
      if (!ad) { ctx.emitError("Set-Acl : Cannot find drive. A drive with the name 'AD' does not exist."); return null; }
      const aclObj = ctx.named['aclobject'] ?? ctx.positional[1];
      if (typeof aclObj !== 'object' || aclObj === null || Array.isArray(aclObj)) {
        ctx.emitError("Set-Acl : Cannot process argument because the value of argument 'AclObject' is not valid.");
        return null;
      }
      const access = (aclObj as Record<string, PSValue>)['Access'];
      const accessArr = Array.isArray(access) ? access : [];
      const rules = accessArr.map(a => {
        const rec = a as unknown as Record<string, PSValue>;
        return {
          identitySam: psValueToString(rec['IdentityReference'] ?? ''),
          rights: psValueToString(rec['ActiveDirectoryRights'] ?? ''),
          accessControlType: psValueToString(rec['AccessControlType'] ?? 'Allow') === 'Deny' ? 'Deny' as const : 'Allow' as const,
          objectType: psValueToString(rec['ObjectType'] ?? AD_NULL_GUID),
          inheritanceType: psValueToString(rec['InheritanceType'] ?? 'None'),
          inheritedObjectType: psValueToString(rec['InheritedObjectType'] ?? AD_NULL_GUID),
        };
      });
      const dn = stripAdPathPrefix(path);
      const res = ad.setAcl(dn, rules);
      if (!res.ok) ctx.emitError(`Set-Acl : ${res.message}`);
      return null;
    }
    const fs = ctx.providers.filesystem;
    if (!fs) { ctx.emitError("Set-Acl : Cannot find drive. A drive with the name 'C' does not exist."); return null; }
    if (!path) { ctx.emitError("Set-Acl : Cannot bind argument to parameter 'Path' because it is an empty string."); return null; }
    if (!fs.exists(path)) { ctx.emitError(`Set-Acl : Cannot find path '${path}' because it does not exist.`); return null; }
    const aclObj = ctx.named['aclobject'] ?? ctx.positional[1];
    if (typeof aclObj !== 'object' || aclObj === null || Array.isArray(aclObj)) {
      ctx.emitError("Set-Acl : Cannot process argument because the value of argument 'AclObject' is not valid.");
      return null;
    }
    const rec = aclObj as Record<string, PSValue>;
    if (rec['AreAccessRulesProtected'] !== undefined) {
      fs.setAclProtected(path, isTruthyPSValue(rec['AreAccessRulesProtected']));
    }
    const access = rec['Access'];
    const accessArr = Array.isArray(access) ? access : [];
    for (const a of accessArr) {
      const rule = a as unknown as Record<string, PSValue>;
      const principal = psValueToString(rule['IdentityReference'] ?? '');
      if (!principal) continue;
      const rightsRaw = psValueToString(rule['FileSystemRights'] ?? '');
      const permissions = rightsRaw.split(',').map(s => s.trim()).filter(Boolean);
      const type = psValueToString(rule['AccessControlType'] ?? 'Allow') === 'Deny' ? 'deny' as const : 'allow' as const;
      fs.addAce(path, { principal, type, permissions });
    }
    // La SACL est remplacée en bloc, pas fusionnée : `Set-Acl` applique
    // un descripteur, il ne l'ajoute pas au précédent.
    const audit = rec['Audit'];
    if (Array.isArray(audit) && fs.setAudit) {
      fs.setAudit(path, audit.map(a => {
        const r = a as unknown as Record<string, PSValue>;
        const flagsRaw = psValueToString(r['AuditFlags'] ?? 'Success').toLowerCase();
        const flags: Array<'success' | 'failure'> = [];
        if (flagsRaw.includes('success')) flags.push('success');
        if (flagsRaw.includes('failure')) flags.push('failure');
        return {
          principal: psValueToString(r['IdentityReference'] ?? ''),
          flags: flags.length ? flags : ['success' as const],
          permissions: psValueToString(r['FileSystemRights'] ?? '')
            .split(',').map(x => x.trim()).filter(Boolean),
        };
      }).filter(r => r.principal));
    }
    return null;
  }
}

const FILE_HASH_ALGORITHMS: ReadonlySet<string> = new Set(['MD5', 'SHA1', 'SHA256', 'SHA384', 'SHA512']);

export class GetFileHashCmdlet implements ICmdlet {
  readonly name = 'get-filehash';
  readonly parameters = ['Path', 'LiteralPath', 'Algorithm'] as const;
  readonly parameterValues = { Path: 'path', LiteralPath: 'path' } as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    if (!path) { ctx.emitError("Get-FileHash : Cannot bind argument to parameter 'Path' because it is an empty string."); return null; }
    const algorithm = psValueToString(ctx.named['algorithm'] ?? 'SHA256').toUpperCase();
    const digest = FILE_HASH_ALGORITHMS.has(algorithm) ? fileDigestName(algorithm) : null;
    if (digest === null) {
      ctx.emitError(`Get-FileHash : Cannot validate argument on parameter 'Algorithm'. The argument "${algorithm}" does not belong to the set "MD5,SHA1,SHA256,SHA384,SHA512".`);
      return null;
    }
    const fs = ctx.providers.filesystem;
    if (!fs) { ctx.emitError(commandNotFoundMessage('Get-FileHash')); return null; }
    if (!fs.exists(path)) {
      ctx.emitError(`Get-FileHash : Could not find file '${path}'.`);
      return null;
    }
    let content: string;
    try { content = fs.readFile(path); }
    catch { ctx.emitError(`Get-FileHash : Could not find file '${path}'.`); return null; }
    return {
      Algorithm: algorithm,
      Hash: fileDigestHex(digest, content).toUpperCase(),
      Path: path,
    } as Record<string, PSValue>;
  }
}

// ─── Get-AuthenticodeSignature ────────────────────────────────────────────

const TRUSTED_SIGNED_ROOTS = [
  'c:\\windows\\', 'c:\\program files\\', 'c:\\program files (x86)\\',
];

export class GetAuthenticodeSignatureCmdlet implements ICmdlet {
  readonly name = 'get-authenticodesignature';
  readonly displayName = 'Get-AuthenticodeSignature';
  readonly parameters = ['FilePath', 'LiteralPath'] as const;
  readonly parameterValues = { FilePath: 'path', LiteralPath: 'path' } as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = psValueToString(ctx.named['filepath'] ?? ctx.named['literalpath'] ?? ctx.positional[0] ?? '');
    if (!path) { ctx.emitError("Get-AuthenticodeSignature : Cannot bind argument to parameter 'FilePath' because it is an empty string."); return null; }
    const fs = ctx.providers.filesystem;
    if (!fs) { ctx.emitError(commandNotFoundMessage('Get-AuthenticodeSignature')); return null; }
    if (!fs.exists(path)) {
      ctx.emitError(`Get-AuthenticodeSignature : Cannot find path '${path}' because it does not exist.`);
      return null;
    }
    const lower = path.toLowerCase();
    const trusted = TRUSTED_SIGNED_ROOTS.some(root => lower.startsWith(root));
    return {
      Path: path,
      Status: trusted ? 'Valid' : 'NotSigned',
      StatusMessage: trusted
        ? 'Signature verified.'
        : 'The file is not digitally signed. The publisher could not be verified.',
      SignerCertificate: trusted ? { Subject: 'CN=Microsoft Windows, O=Microsoft Corporation', Thumbprint: 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2' } : null,
    } as Record<string, PSValue>;
  }
}
