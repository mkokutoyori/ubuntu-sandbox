/**
 * PathCmdlets — Split-Path, Join-Path, Test-Path, Resolve-Path.
 *
 * Test-Path delegates to the filesystem provider (or testPathHook via runtime).
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
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
  readonly aliases = ['ls', 'dir', 'gci'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path    = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '.');
    const filter  = ctx.named['filter']  ? psValueToString(ctx.named['filter'])  : null;
    const recurse = ctx.named['recurse'] === true || ctx.named['recurse'] === 'true';

    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      // Returns a formatted listing string; the cmdlet layer wraps strings
      // transparently so callers see a familiar Get-ChildItem output.
      return ctx.providers.registry.getChildItem(path);
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
        Length: e.size,
        Mode: e.isDirectory ? 'd----' : '-a---',
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
    return items;
  }
}

// ─── Get-Content ─────────────────────────────────────────────────────────

export class GetContentCmdlet implements ICmdlet {
  readonly name = 'get-content';
  readonly aliases = ['cat', 'type', 'gc'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    try { return fs.readFile(path); }
    catch { return null; }
  }
}

// ─── Set-Content ─────────────────────────────────────────────────────────

export class SetContentCmdlet implements ICmdlet {
  readonly name = 'set-content';
  readonly aliases = ['sc'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path  = psValueToString(ctx.named['path']  ?? ctx.positional[0] ?? '');
    const value = psValueToString(ctx.named['value'] ?? ctx.positional[1] ?? ctx.pipeInput ?? '');
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    fs.writeFile(path, value);
    return null;
  }
}

// ─── Add-Content ─────────────────────────────────────────────────────────

export class AddContentCmdlet implements ICmdlet {
  readonly name = 'add-content';
  readonly aliases = ['ac'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path  = psValueToString(ctx.named['path']  ?? ctx.positional[0] ?? '');
    const value = psValueToString(ctx.named['value'] ?? ctx.positional[1] ?? ctx.pipeInput ?? '');
    const fs = ctx.providers.filesystem;
    if (!fs) return null;
    fs.appendFile(path, value);
    return null;
  }
}

// ─── New-Item ─────────────────────────────────────────────────────────────

export class NewItemCmdlet implements ICmdlet {
  readonly name = 'new-item';
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
    if (itemType === 'directory' || itemType === 'dir') {
      fs.createDir(path);
    } else {
      fs.createFile(path);
      if (value !== null) fs.writeFile(path, value);
    }
    return { Name: path, FullName: path, ItemType: itemType } as Record<string, PSValue>;
  }
}

// ─── Remove-Item ─────────────────────────────────────────────────────────

export class RemoveItemCmdlet implements ICmdlet {
  readonly name = 'remove-item';
  readonly aliases = ['rm', 'del', 'ri', 'rmdir', 'erase', 'rd'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path    = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
    const recurse = ctx.named['recurse'] === true;

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

// ─── Out-File ─────────────────────────────────────────────────────────────

export class OutFileCmdlet implements ICmdlet {
  readonly name = 'out-file';
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
