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
  readonly displayName = 'Get-ChildItem';
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
    let content: string;
    try { content = fs.readFile(path); }
    catch { return null; }
    const tail       = ctx.named['tail']       !== undefined ? Number(ctx.named['tail'])       : undefined;
    const totalCount = ctx.named['totalcount'] !== undefined ? Number(ctx.named['totalcount']) : undefined;
    if (tail !== undefined || totalCount !== undefined) {
      const lines = content.split(/\r?\n/);
      // Trailing empty token from final newline — drop so slicing matches user
      // intent (`-Tail 2` on "1\n2\n3\n4\n5\n" returns ["4","5"]).
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      if (tail !== undefined)       return lines.slice(Math.max(0, lines.length - tail)) as unknown as PSValue;
      if (totalCount !== undefined) return lines.slice(0, totalCount) as unknown as PSValue;
    }
    return content;
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

// ─── Rename-Item ─────────────────────────────────────────────────────────
// Same provider call as Move-Item but with a sibling-name new path.

export class RenameItemCmdlet implements ICmdlet {
  readonly name = 'rename-item';
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
  readonly displayName = 'Get-ItemProperty';
  readonly aliases = ['gp'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = joinPathPositionals(ctx);
    const name = ctx.named['name'] ? psValueToString(ctx.named['name']) : undefined;
    if (isRegistryPath(path)) {
      if (!ctx.providers.registry) requireRegistryProvider(path);
      return ctx.providers.registry.getItemProperty(path, name);
    }
    requireRegistryProvider(path); // throws "not recognized" — fallback to executor for FS attrs
    return null;
  }
}

export class SetItemPropertyCmdlet implements ICmdlet {
  readonly name = 'set-itemproperty';
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

// ─── Get-Item / Set-Item ────────────────────────────────────────────────────
// Read / overwrite a filesystem entry. Registry paths fall through to the
// existing item-property cmdlets.

export class GetItemCmdlet implements ICmdlet {
  readonly name = 'get-item';
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
    return {
      Name:          baseName,
      FullName:      path,
      PSIsContainer: isDir,
      Mode:          isDir ? 'd-----' : '-a----',
      Length:        isDir ? 0 : (fs.readFile(path) || '').length,
    } as Record<string, PSValue>;
  }
}

export class SetItemCmdlet implements ICmdlet {
  readonly name = 'set-item';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path  = psValueToString(ctx.named['path']  ?? ctx.positional[0] ?? '');
    const value = psValueToString(ctx.named['value'] ?? ctx.positional[1] ?? '');
    if (!path) { ctx.emitError('Set-Item requires -Path'); return null; }
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
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    // Real Set-Acl takes a SecurityDescriptor argument — too complex to
    // simulate without parsing the full PSObject. We forward to the legacy
    // executor, which has a dedicated handler.
    throw new PSRuntimeError('Set-Acl is not recognized in this provider context');
  }
}
