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
import { md5Hex } from '@/crypto/hash/md5';
import { sha1Hex } from '@/crypto/hash/sha1';
import { sha256Hex } from '@/crypto/hash/sha256';
import { sha512Hex } from '@/crypto/hash/sha512';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import { wildcardToRegex, wildcardMatches, hasWildcard } from '@/powershell/runtime/PSWildcard';

function isRegistryPath(path: string): boolean {
  return /^(HKLM|HKCU|HKCR|HKU|HKCC):/i.test(path) || /^HKEY_/i.test(path);
}

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

export class SplitPathCmdlet implements ICmdlet {
  readonly name = 'split-path';
  readonly parameters = ['Path', 'LiteralPath', 'Qualifier', 'NoQualifier', 'Parent', 'Leaf', 'LeafBase', 'Extension', 'Resolve', 'IsAbsolute'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const p   = pathArgOf(ctx);
    const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    const leaf   = idx >= 0 ? p.slice(idx + 1) : p;
    const parent = idx >= 0 ? p.slice(0, idx)   : '';

    if (ctx.named['leaf']      === true) return leaf;
    if (ctx.named['parent']    === true) return parent;
    if (ctx.named['extension'] === true) {
      const dot = leaf.lastIndexOf('.');
      return dot > 0 ? leaf.slice(dot) : '';
    }
    if (ctx.named['qualifier'] === true) {
      const m = p.match(/^[A-Za-z]:/);
      return m ? m[0] : '';
    }
    if (ctx.named['leafbase']  === true) {
      const dot = leaf.lastIndexOf('.');
      return dot > 0 ? leaf.slice(0, dot) : leaf;
    }
    return parent;
  }
}

// ─── Join-Path ────────────────────────────────────────────────────────────

export class JoinPathCmdlet implements ICmdlet {
  readonly name = 'join-path';
  readonly parameters = ['Path', 'ChildPath', 'AdditionalChildPath', 'Resolve'] as const;
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

export class TestPathCmdlet implements ICmdlet {
  readonly name = 'test-path';
  readonly parameters = ['Path', 'LiteralPath', 'PathType', 'Filter', 'Include', 'Exclude', 'IsValid', 'Newer', 'OlderThan'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    if (!path) return false;

    if (ctx.providers.registry) {
      if (isRegistryPath(path)) return ctx.providers.registry.testPath(path) ?? false;
    } else {
      requireRegistryProvider(path);
    }

    const fs = ctx.providers.filesystem;
    if (fs) return fs.exists(path);
    return false;
  }
}

// ─── Resolve-Path ────────────────────────────────────────────────────────

export class ResolvePathCmdlet implements ICmdlet {
  readonly name = 'resolve-path';
  readonly parameters = ['Path', 'LiteralPath', 'Relative', 'RelativeBasePath'] as const;
  readonly aliases = ['rvpa'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    const fs   = ctx.providers.filesystem;
    if (!fs) return path;
    const abs = fs.normalizePath(path, fs.getCwd());
    return { Path: abs, ProviderPath: abs } as Record<string, PSValue>;
  }
}

// ─── Get-ChildItem ────────────────────────────────────────────────────────

function pathArgOf(ctx: CmdletContext, fallback = ''): string {
  const literal = ctx.named['literalpath'];
  if (literal !== undefined) return psValueToString(literal);
  return psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? fallback);
}

export class GetChildItemCmdlet implements ICmdlet {
  readonly name = 'get-childitem';
  readonly parameters = ['Path', 'LiteralPath', 'Filter', 'Include', 'Exclude', 'Recurse', 'Depth', 'Force', 'Name', 'Attributes', 'Directory', 'File', 'Hidden', 'ReadOnly', 'System'] as const;
  readonly displayName = 'Get-ChildItem';
  readonly aliases = ['ls', 'dir', 'gci'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path    = pathArgOf(ctx, '.');
    const filter  = ctx.named['filter']  ? psValueToString(ctx.named['filter'])  : null;
    const recurse = ctx.named['recurse'] === true || ctx.named['recurse'] === 'true';
    const onlyFiles = ctx.named['file']      === true;
    const onlyDirs  = ctx.named['directory'] === true;
    const nameOnly  = ctx.named['name']      === true;

    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      // Returns a formatted listing string; the cmdlet layer wraps strings
      // transparently so callers see a familiar Get-ChildItem output.
      return ctx.providers.registry.getChildItem(path);
    }

    // Env: drive — list every host env var as a {Name, Value} object so
    // `Get-ChildItem Env: | Sort-Object Name | Select-Object -First 10`
    // works the same as it does in real PowerShell.
    if (/^env:\\?$/i.test(path) || /^env:/i.test(path)) {
      return ctx.runtime.listEnvVars() as PSValue;
    }

    const fs = ctx.providers.filesystem;
    if (!fs) {
      if (path !== '.') ctx.emitError(`Cannot find path '${path}' because it does not exist.`);
      return [];
    }
    if (path !== '.' && !fs.exists(path)) {
      ctx.emitError(`Cannot find path '${path}' because it does not exist.`);
      return [];
    }

    if (path !== '.' && !fs.isDirectory(path)) {
      return [itemObject(fs, path)];
    }

    const collect = (dir: string): PSValue[] => {
      const entries = fs.listDir(dir);
      const out: PSValue[] = entries.map(e => ({
        Name: e.name,
        FullName: `${dir}\\${e.name}`,
        // FileInfo.Extension includes the leading dot; directories and
        // extension-less files report an empty string (matches real PS).
        Extension: e.isDirectory ? '' : (e.name.includes('.') ? e.name.slice(e.name.lastIndexOf('.')) : ''),
        BaseName: e.isDirectory
          ? e.name
          : (e.name.includes('.') ? e.name.slice(0, e.name.lastIndexOf('.')) : e.name),
        // Real PowerShell's DirectoryInfo has no `Length` — Format-Table
        // renders an empty cell.  Setting it to null reproduces that
        // visually; downstream `Where-Object { $_.Length -gt 0 }` keeps
        // working because PS coerces null → 0.
        Length: e.isDirectory ? null : e.size,
        // Real PS uses a 6-char `darhsl` mode column. Plain files have the
        // archive bit on (-a----); plain directories show only d (d-----).
        Mode: e.isDirectory ? 'd-----' : '-a----',
        PSIsContainer: e.isDirectory,
        LastWriteTime: e.mtime,
      } as Record<string, PSValue>));
      if (recurse) {
        for (const e of entries) {
          if (e.isDirectory) out.push(...collect(`${dir}\\${e.name}`));
        }
      }
      return out;
    };

    let items = collect(path);
    if (filter) {
      const pat = wildcardToRegex(filter);
      items = items.filter(item => pat.test(psValueToString((item as Record<string, PSValue>)['Name'])));
    }
    if (onlyFiles) {
      items = items.filter(item => !(item as Record<string, PSValue>)['PSIsContainer']);
    }
    if (onlyDirs) {
      items = items.filter(item => (item as Record<string, PSValue>)['PSIsContainer']);
    }
    if (nameOnly) {
      return items.map(item => (item as Record<string, PSValue>)['Name']) as PSValue;
    }
    return items;
  }
}

// ─── Get-Content ─────────────────────────────────────────────────────────

export class GetContentCmdlet implements ICmdlet {
  readonly name = 'get-content';
  readonly parameters = ['Path', 'LiteralPath', 'ReadCount', 'TotalCount', 'Tail', 'Filter', 'Include', 'Exclude', 'Force', 'Raw', 'Encoding', 'Delimiter', 'Wait', 'Stream'] as const;
  readonly aliases = ['cat', 'type', 'gc'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    let content: string;
    try { content = fs.readFile(path); }
    catch { return null; }
    const raw = ctx.named['raw'] === true || ctx.named['raw'] === 'true';
    if (raw) return content;

    // PowerShell Get-Content returns one PSValue per line. The trailing empty
    // token from a final newline is dropped so `.Count` matches user intent.
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    const tail       = ctx.named['tail']       !== undefined ? Number(ctx.named['tail'])       : undefined;
    const totalCount = ctx.named['totalcount'] !== undefined ? Number(ctx.named['totalcount']) : undefined;
    const sliced = tail !== undefined
      ? lines.slice(Math.max(0, lines.length - tail))
      : totalCount !== undefined
        ? lines.slice(0, totalCount)
        : lines;
    // PowerShell unwraps single-element arrays produced by Get-Content so
    // `$x = Get-Content single-line.txt` yields a string; `.Count` still
    // works on the array form when content has multiple lines.
    if (sliced.length === 1) return sliced[0] as PSValue;
    return sliced as unknown as PSValue;
  }
}

// ─── Set-Content ─────────────────────────────────────────────────────────

export class SetContentCmdlet implements ICmdlet {
  readonly name = 'set-content';
  readonly parameters = ['Path', 'LiteralPath', 'Value', 'Force', 'Encoding', 'PassThru', 'NoNewline', 'Stream', 'Filter', 'Include', 'Exclude'] as const;
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
    fs.writeFile(path, lines.join('\n') + (noNewline ? '' : '\n'));
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
  readonly aliases = ['clc'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = psValueToString(
      ctx.named['path'] ?? ctx.named['literalpath'] ?? ctx.positional[0] ?? '');
    if (path === '') {
      ctx.emitError("Clear-Content : Cannot bind argument to parameter 'Path' because it is an empty string.");
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
  readonly aliases = ['ac'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path  = pathArgOf(ctx);
    const raw   = ctx.named['value'] ?? ctx.positional[1] ?? ctx.pipeInput ?? '';
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
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

export class NewItemCmdlet implements ICmdlet {
  readonly name = 'new-item';
  readonly parameters = ['Path', 'Name', 'ItemType', 'Value', 'Force'] as const;
  readonly aliases = ['ni'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path     = pathArgOf(ctx);
    const itemType = psValueToString(ctx.named['itemtype'] ?? ctx.named['type'] ?? 'File').toLowerCase();
    const value    = ctx.named['value'] !== undefined ? psValueToString(ctx.named['value']) : null;

    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      const force = ctx.named['force'] === true;
      return ctx.providers.registry.newItem(path, force);
    }

    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    const force = ctx.named['force'] === true;
    if (itemType === 'directory' || itemType === 'dir') {
      if (fs.exists(path) && !force) {
        ctx.emitError(`New-Item : An item with the specified name '${path}' already exists.`);
        return null;
      }
      fs.createDir(path);
    } else {
      if (fs.exists(path) && !force) {
        ctx.emitError(`New-Item : The file '${path}' already exists.`);
        return null;
      }
      // -Force creates any missing parent directories (matches real PS).
      if (force) {
        const parent = path.replace(/[\\/][^\\/]*$/, '');
        if (parent && parent !== path && !fs.exists(parent)) fs.createDir(parent);
      }
      fs.createFile(path);
      if (value !== null) fs.writeFile(path, value);
    }
    return { Name: path, FullName: path, ItemType: itemType } as Record<string, PSValue>;
  }
}

// ─── Remove-Item ─────────────────────────────────────────────────────────

export class RemoveItemCmdlet implements ICmdlet {
  readonly name = 'remove-item';
  readonly parameters = ['Path', 'LiteralPath', 'Filter', 'Include', 'Exclude', 'Recurse', 'Force', 'Stream'] as const;
  readonly aliases = ['rm', 'del', 'ri', 'rmdir', 'erase', 'rd'] as const;

  execute(ctx: CmdletContext): PSValue {
    const recurse = ctx.named['recurse'] === true;

    // Build the target list. An explicit -Path/positional wins; otherwise
    // accept pipeline input (strings or FileInfo objects from Get-ChildItem).
    const explicit = ctx.named['literalpath'] ?? ctx.named['path'] ?? ctx.positional[0];
    let targets: string[];
    if (explicit !== undefined && explicit !== null) {
      targets = (Array.isArray(explicit) ? explicit : [explicit]).map(pathOf);
    } else {
      const raw = ctx.pipeInput;
      const items = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
      targets = items.map(pathOf).filter(p => p.length > 0);
    }
    if (targets.length === 0) return null;

    for (const path of targets) {
      // Env:VAR — clear the variable on the environment provider.
      const envMatch = /^env:(.+)$/i.exec(path);
      if (envMatch) {
        ctx.providers.environment?.remove(envMatch[1]);
        continue;
      }
      if (isRegistryPath(path)) {
        if (!ctx.providers.registry) requireRegistryProvider(path);
        ctx.providers.registry.removeItem(path, recurse);
        continue;
      }
      const fs = ctx.providers.filesystem;
      if (!fs) return null;
      try { fs.remove(path, recurse); }
      catch (e) { ctx.emitError(e instanceof Error ? e.message : String(e)); }
    }
    return null;
  }
}

/** Resolve a pipeline item to a filesystem path: a string, or an object's
 *  FullName / PSPath / Path / Name property (Get-ChildItem output). */
function pathOf(v: PSValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, PSValue>;
    const k = ['FullName', 'PSPath', 'Path', 'Name'].find(
      n => o[n] !== undefined && o[n] !== null);
    return k ? psValueToString(o[k]) : '';
  }
  return psValueToString(v);
}

// ─── Copy-Item ────────────────────────────────────────────────────────────

export class CopyItemCmdlet implements ICmdlet {
  readonly name = 'copy-item';
  readonly displayName = 'Copy-Item';
  readonly parameters = ['Path', 'LiteralPath', 'Destination', 'Filter', 'Include', 'Exclude', 'Recurse', 'Force', 'PassThru', 'Container', 'WhatIf', 'Confirm', 'Credential', 'ToSession', 'FromSession'] as const;
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

function parentOf(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '');
  const cut = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
  return cut <= 0 ? cleaned.slice(0, cut + 1) : cleaned.slice(0, cut);
}

function pipedPath(pipeInput: PSValue): string | null {
  const first = Array.isArray(pipeInput) ? pipeInput[0] : pipeInput;
  if (first === null || first === undefined) return null;
  if (typeof first === 'string') return first;
  if (typeof first === 'object') {
    const record = first as Record<string, PSValue>;
    const full = record['FullName'] ?? record['PSPath'] ?? record['Path'];
    if (full !== undefined) return psValueToString(full);
  }
  return null;
}

function expandPathSpec(
  fs: NonNullable<CmdletContext['providers']['filesystem']>, spec: string,
): string[] {
  if (!hasWildcard(spec)) return fs.exists(spec) ? [spec] : [];
  const dir = parentOf(spec);
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
  const isDir = fs.exists(path) && fs.isDirectory(path);
  const name = baseNameOf(path);
  return {
    Name: name,
    FullName: path,
    PSIsContainer: isDir,
    Extension: isDir ? '' : (name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''),
    Mode: isDir ? 'd-----' : '-a----',
  } as Record<string, PSValue>;
}

// ─── Move-Item ────────────────────────────────────────────────────────────

export class MoveItemCmdlet implements ICmdlet {
  readonly name = 'move-item';
  readonly parameters = ['Path', 'LiteralPath', 'Destination', 'Filter', 'Include', 'Exclude', 'Force', 'PassThru'] as const;
  readonly aliases = ['mv', 'move', 'mi'] as const;

  execute(ctx: CmdletContext): PSValue {
    const src  = pathArgOf(ctx);
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
  readonly aliases = ['ren', 'rni'] as const;

  execute(ctx: CmdletContext): PSValue {
    const src     = pathArgOf(ctx);
    const newName = psValueToString(ctx.named['newname'] ?? ctx.positional[1] ?? '');
    if (!src || !newName) {
      ctx.emitError('Rename-Item requires -Path and -NewName');
      return null;
    }
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
  if (ctx.named['path']) return psValueToString(ctx.named['path']);
  return ctx.positional.map(psValueToString).join(' ').trim();
}

export class GetItemPropertyCmdlet implements ICmdlet {
  readonly name = 'get-itemproperty';
  readonly parameters = ['Path', 'LiteralPath', 'Name', 'Filter', 'Include', 'Exclude'] as const;
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
  readonly aliases = ['gi'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    if (!path) { ctx.emitError('Get-Item requires -Path'); return null; }
    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      return ctx.providers.registry.getItem(path);
    }
    // Env:VAR — return a {Name, Value} object for the env variable.
    const envMatch = /^env:(.+)$/i.exec(path);
    if (envMatch) {
      const name = envMatch[1];
      const all  = ctx.runtime.listEnvVars();
      const hit  = all.find(e => e.Name.toLowerCase() === name.toLowerCase());
      if (!hit) {
        ctx.emitError(`Cannot find path 'Env:${name}' because it does not exist.`);
        return null;
      }
      return { Name: hit.Name, Value: hit.Value } as Record<string, PSValue>;
    }
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    if (!fs.exists(path)) {
      ctx.emitError(`Cannot find path '${path}' because it does not exist.`);
      return null;
    }
    const isDir = fs.isDirectory(path);
    const baseName = path.replace(/\\$/, '').split(/[\\/]/).pop() ?? path;
    const stat = lookupDirEntry(fs, path);
    const attrs = stat?.attributes ?? new Set<string>(isDir ? ['directory'] : ['archive']);
    return {
      Name:          baseName,
      FullName:      path,
      PSIsContainer: isDir,
      Mode:          renderModeFromAttributes(attrs, isDir),
      Length:        isDir ? 0 : (stat?.size ?? (fs.readFile(path) || '').length),
      LastWriteTime: stat?.mtime ?? null,
      Attributes:    Array.from(attrs).map(a => titleCaseAttribute(a)).join(', '),
      IsReadOnly:    attrs.has('readonly'),
    } as Record<string, PSValue>;
  }
}

/** Find the entry record for a file by listing its parent directory. */
function lookupDirEntry(
  fs: NonNullable<CmdletContext['providers']['filesystem']>,
  path: string,
): { size: number; mtime: Date; attributes: Set<string> } | null {
  const norm = path.replace(/[\\/]+$/, '');
  const lastSep = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  const parent = lastSep > 1 ? norm.slice(0, lastSep) : norm.slice(0, lastSep + 1);
  const leaf   = lastSep >= 0 ? norm.slice(lastSep + 1) : norm;
  try {
    const entries = fs.listDir(parent || '.');
    const hit = entries.find(e => e.name.toLowerCase() === leaf.toLowerCase());
    if (!hit) return null;
    return { size: hit.size, mtime: hit.mtime, attributes: hit.attributes ?? new Set() };
  } catch { return null; }
}

function renderModeFromAttributes(attrs: Set<string>, isDir: boolean): string {
  const d = isDir          ? 'd' : '-';
  const a = attrs.has('archive')  ? 'a' : '-';
  const r = attrs.has('readonly') ? 'r' : '-';
  const h = attrs.has('hidden')   ? 'h' : '-';
  const s = attrs.has('system')   ? 's' : '-';
  const l = '-';
  return d + a + r + h + s + l;
}

function titleCaseAttribute(a: string): string {
  if (a === 'readonly') return 'ReadOnly';
  return a.charAt(0).toUpperCase() + a.slice(1);
}

export class SetItemCmdlet implements ICmdlet {
  readonly name = 'set-item';
  readonly parameters = ['Path', 'LiteralPath', 'Value', 'Force', 'PassThru', 'Type'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path  = pathArgOf(ctx);
    const value = psValueToString(ctx.named['value'] ?? ctx.positional[1] ?? '');
    if (!path) { ctx.emitError('Set-Item requires -Path'); return null; }
    // Env:VAR — write through to the environment provider so cmd subshells
    // see the same variable.
    const envMatch = /^env:(.+)$/i.exec(path);
    if (envMatch) {
      const name = envMatch[1];
      if (!ctx.providers.environment) {
        ctx.emitError(`Set-Item : Cannot find drive 'Env'.`);
        return null;
      }
      ctx.providers.environment.set(name, value);
      return null;
    }
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

const FILE_HASH_ALGORITHMS: Record<string, (s: string) => string> = {
  MD5: md5Hex,
  SHA1: sha1Hex,
  SHA256: sha256Hex,
  SHA512: sha512Hex,
};

export class GetFileHashCmdlet implements ICmdlet {
  readonly name = 'get-filehash';
  readonly parameters = ['Path', 'LiteralPath', 'Algorithm'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = pathArgOf(ctx);
    if (!path) { ctx.emitError("Get-FileHash : Cannot bind argument to parameter 'Path' because it is an empty string."); return null; }
    const algorithm = psValueToString(ctx.named['algorithm'] ?? 'SHA256').toUpperCase();
    const hashFn = FILE_HASH_ALGORITHMS[algorithm];
    if (!hashFn) {
      ctx.emitError(`Get-FileHash : Cannot validate argument on parameter 'Algorithm'. The argument "${algorithm}" does not belong to the set "MD5,SHA1,SHA256,SHA512".`);
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
      Hash: hashFn(content).toUpperCase(),
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
