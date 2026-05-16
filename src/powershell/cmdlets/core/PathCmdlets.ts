/**
 * PathCmdlets — Split-Path, Join-Path, Test-Path, Resolve-Path.
 *
 * Test-Path delegates to the filesystem provider (or testPathHook via runtime).
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function isRegistryPath(path: string): boolean {
  return /^(HKLM|HKCU|HKCR|HKU|HKCC):/i.test(path) || /^HKEY_/i.test(path);
}

function requireRegistryProvider(path: string): void {
  if (isRegistryPath(path)) {
    throw new Error('Registry provider not recognized in this context');
  }
}

// ─── Split-Path ───────────────────────────────────────────────────────────

export class SplitPathCmdlet implements ICmdlet {
  readonly name = 'split-path';
  readonly parameters = ['Path', 'LiteralPath', 'Qualifier', 'NoQualifier', 'Parent', 'Leaf', 'LeafBase', 'Extension', 'Resolve', 'IsAbsolute'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const p   = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
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
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
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
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
    const fs   = ctx.providers.filesystem;
    if (!fs) return path;
    const abs = fs.normalizePath(path, fs.getCwd());
    return { Path: abs, ProviderPath: abs } as Record<string, PSValue>;
  }
}

// ─── Get-ChildItem ────────────────────────────────────────────────────────

export class GetChildItemCmdlet implements ICmdlet {
  readonly name = 'get-childitem';
  readonly parameters = ['Path', 'LiteralPath', 'Filter', 'Include', 'Exclude', 'Recurse', 'Depth', 'Force', 'Name', 'Attributes', 'Directory', 'File', 'Hidden', 'ReadOnly', 'System'] as const;
  readonly displayName = 'Get-ChildItem';
  readonly aliases = ['ls', 'dir', 'gci'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path    = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '.');
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

    const collect = (dir: string): PSValue[] => {
      const entries = fs.listDir(dir);
      const out: PSValue[] = entries.map(e => ({
        Name: e.name,
        FullName: `${dir}\\${e.name}`,
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
      const pat = new RegExp(`^${filter.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
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
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
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
    const path  = psValueToString(ctx.named['path']  ?? ctx.positional[0] ?? '');
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

// ─── Add-Content ─────────────────────────────────────────────────────────

export class AddContentCmdlet implements ICmdlet {
  readonly name = 'add-content';
  readonly parameters = ['Path', 'LiteralPath', 'Value', 'Force', 'Encoding', 'PassThru', 'NoNewline', 'Stream', 'Filter', 'Include', 'Exclude'] as const;
  readonly aliases = ['ac'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path  = psValueToString(ctx.named['path']  ?? ctx.positional[0] ?? '');
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
    const path     = psValueToString(ctx.named['path']     ?? ctx.positional[0] ?? '');
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
    const path    = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
    const recurse = ctx.named['recurse'] === true;

    // Env:VAR — clear the variable on the environment provider.
    const envMatch = /^env:(.+)$/i.exec(path);
    if (envMatch) {
      ctx.providers.environment?.remove(envMatch[1]);
      return null;
    }

    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      return ctx.providers.registry.removeItem(path, recurse);
    }

    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    fs.remove(path, recurse);
    return null;
  }
}

// ─── Copy-Item ────────────────────────────────────────────────────────────

export class CopyItemCmdlet implements ICmdlet {
  readonly name = 'copy-item';
  readonly parameters = ['Path', 'LiteralPath', 'Destination', 'Filter', 'Include', 'Exclude', 'Recurse', 'Force', 'PassThru', 'Container'] as const;
  readonly aliases = ['cp', 'copy', 'cpi'] as const;

  execute(ctx: CmdletContext): PSValue {
    const src  = psValueToString(ctx.named['path']        ?? ctx.named['literalpath'] ?? ctx.positional[0] ?? '');
    const dest = psValueToString(ctx.named['destination'] ?? ctx.positional[1] ?? '');
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    fs.copy(src, dest);
    return null;
  }
}

// ─── Move-Item ────────────────────────────────────────────────────────────

export class MoveItemCmdlet implements ICmdlet {
  readonly name = 'move-item';
  readonly parameters = ['Path', 'LiteralPath', 'Destination', 'Filter', 'Include', 'Exclude', 'Force', 'PassThru'] as const;
  readonly aliases = ['mv', 'move', 'mi'] as const;

  execute(ctx: CmdletContext): PSValue {
    const src  = psValueToString(ctx.named['path']        ?? ctx.positional[0] ?? '');
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
    const src     = psValueToString(ctx.named['path']    ?? ctx.positional[0] ?? '');
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
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
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
    const filePath = psValueToString(ctx.named['filepath'] ?? ctx.named['path'] ?? ctx.positional[0] ?? '');
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
    const path  = psValueToString(ctx.named['path']  ?? ctx.positional[0] ?? '');
    const name  = psValueToString(ctx.named['name']  ?? ctx.positional[1] ?? '');
    const raw   = ctx.named['value'] ?? ctx.positional[2];
    const value = typeof raw === 'number' ? raw : psValueToString(raw ?? '');
    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      return ctx.providers.registry.setItemProperty(path, name, value);
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
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[1] ?? '');
    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      return ctx.providers.registry.removeItemProperty(path, name);
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
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
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
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
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
    const path  = psValueToString(ctx.named['path']  ?? ctx.positional[0] ?? '');
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
      throw new PSRuntimeError('Set-Item on registry paths is not recognized in this provider context');
    }
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    fs.writeFile(path, value);
    return null;
  }
}

// ─── Get-Acl / Set-Acl ──────────────────────────────────────────────────────

export class GetAclCmdlet implements ICmdlet {
  readonly name = 'get-acl';
  readonly parameters = ['Path', 'LiteralPath', 'InputObject', 'Audit', 'Filter', 'Include', 'Exclude'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
    const fs = ctx.providers.filesystem;
    if (!fs || !path) { ctx.emitError("Get-Acl : Cannot bind argument to parameter 'Path' because it is an empty string."); return null; }
    if (!fs.exists(path)) { ctx.emitError(`Get-Acl : Cannot find path '${path}' because it does not exist.`); return null; }
    const acl = fs.getAcl(path);
    if (!acl) {
      ctx.emitError(`Get-Acl : Cannot retrieve ACL for '${path}'.`);
      return null;
    }
    // Match the columns Format-List would render for a real ACL.
    return {
      Path:  path,
      Owner: acl.owner,
      Group: 'BUILTIN\\Administrators',
      Access: acl.acl.map(a => ({
        FileSystemRights:  a.permissions.join(', '),
        AccessControlType: a.type === 'allow' ? 'Allow' : 'Deny',
        IdentityReference: a.principal,
        IsInherited:       false,
      })) as PSValue,
    } as Record<string, PSValue>;
  }
}

export class SetAclCmdlet implements ICmdlet {
  readonly name = 'set-acl';
  readonly parameters = ['Path', 'LiteralPath', 'AclObject', 'InputObject', 'Passthru'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    // Real Set-Acl takes a SecurityDescriptor argument — too complex to
    // simulate without parsing the full PSObject. We forward to the legacy
    // executor, which has a dedicated handler.
    throw new PSRuntimeError('Set-Acl is not recognized in this provider context');
  }
}
