/**
 * MiscCmdlets — Miscellaneous core cmdlets.
 *
 * New-Object, Get-Random, Invoke-Expression, Get-Command, Get-Help.
 * No system providers required (except Get-Command which reads the registry).
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

// ─── New-Object ───────────────────────────────────────────────────────────

export class NewObjectCmdlet implements ICmdlet {
  readonly name = 'new-object';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const tname = psValueToString(ctx.named['typename'] ?? ctx.positional[0] ?? '').toLowerCase();
    if (tname.includes('hashtable') || tname.includes('dictionary'))
      return {} as Record<string, PSValue>;
    if (tname.includes('arraylist') || tname.includes('list`1') || tname.includes('list<')) {
      // Real JS array with __list__ sentinel for getMember dispatch + Count getter for direct JS access
      const arr: PSValue[] = [];
      (arr as Record<string, PSValue>)['__list__'] = arr as unknown as PSValue;
      Object.defineProperty(arr, 'Count', { get: () => arr.length, enumerable: false, configurable: true });
      return arr as unknown as PSValue;
    }
    if (tname.includes('queue')) {
      const items: PSValue[] = [];
      const q: Record<string, PSValue> = { __type__: 'Queue', __items__: items as PSValue[] };
      Object.defineProperty(q, 'Count', { get: () => items.length, enumerable: false, configurable: true });
      return q as unknown as PSValue;
    }
    if (tname.includes('stack')) {
      const items: PSValue[] = [];
      const s: Record<string, PSValue> = { __type__: 'Stack', __items__: items as PSValue[] };
      Object.defineProperty(s, 'Count', { get: () => items.length, enumerable: false, configurable: true });
      return s as unknown as PSValue;
    }
    if (tname.includes('pscredential')) {
      const args = (ctx.named['argumentlist'] ?? ctx.positional.slice(1)) as PSValue[];
      const user = psValueToString(Array.isArray(args) ? args[0] : args ?? '');
      return { UserName: user, Password: null } as Record<string, PSValue>;
    }
    return {} as Record<string, PSValue>;
  }
}

// ─── Get-Random ───────────────────────────────────────────────────────────

export class GetRandomCmdlet implements ICmdlet {
  readonly name = 'get-random';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const max = ctx.named['maximum'] ?? ctx.positional[0] ?? null;
    const min = Number(ctx.named['minimum'] ?? 0);
    if (max !== null) return Math.floor(Math.random() * (Number(max) - min)) + min;
    return Math.random();
  }
}

// ─── Invoke-Expression ────────────────────────────────────────────────────

export class InvokeExpressionCmdlet implements ICmdlet {
  readonly name = 'invoke-expression';
  readonly aliases = ['iex'] as const;

  execute(ctx: CmdletContext): PSValue {
    const code = psValueToString(ctx.named['command'] ?? ctx.positional[0] ?? ctx.pipeInput ?? '');
    if (!code) return null;
    return ctx.runtime.executeForValue(code);
  }
}

// ─── ConvertTo-SecureString ───────────────────────────────────────────────

export class ConvertToSecureStringCmdlet implements ICmdlet {
  readonly name = 'convertto-securestring';
  readonly displayName = 'ConvertTo-SecureString';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const val = psValueToString(ctx.positional[0] ?? ctx.pipeInput ?? '');
    return { SecureString: val, Length: val.length } as Record<string, PSValue>;
  }
}

// ─── Get-Help ─────────────────────────────────────────────────────────────

export class GetHelpCmdlet implements ICmdlet {
  readonly name = 'get-help';
  readonly aliases = ['help'] as const;

  execute(ctx: CmdletContext): PSValue {
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) {
      ctx.emit('TOPIC\n    PowerShell Help System\n\nSHORT DESCRIPTION\n    Use Get-Help <cmdlet> for cmdlet help.');
      return null;
    }
    ctx.emit(`NAME\n    ${name}\n\nSYNTAX\n    ${name} [<CommonParameters>]\n\nDESCRIPTION\n    Displays help for the ${name} cmdlet.`);
    return null;
  }
}

// ─── Get-Command ──────────────────────────────────────────────────────────

export class GetCommandCmdlet implements ICmdlet {
  readonly name = 'get-command';
  readonly aliases = ['gcm'] as const;

  execute(ctx: CmdletContext): PSValue {
    // Enumerate every registered cmdlet — Get-Command's whole point is
    // discoverability, so we go straight to the registry instead of a
    // hard-coded subset. Each cmdlet supplies its own canonical
    // PascalCase displayName (open/closed: no central naming dictionary).
    const all = ctx.runtime.listCmdlets();

    type Row = {
      CommandType: 'Cmdlet' | 'Alias' | 'Function';
      Name: string;
      Version: string;
      Source: string;
      Definition?: string;
    };
    const rows: Row[] = [];
    for (const c of all) {
      const display = c.displayName ?? titleCaseCmdletName(c.name);
      const source  = c.module ?? 'Microsoft.PowerShell.Core';
      rows.push({
        CommandType: 'Cmdlet',
        Name: display,
        Version: '5.1.0',
        Source: source,
      });
      for (const a of c.aliases) {
        rows.push({
          CommandType: 'Alias',
          Name: a,
          Version: '',
          Source: '',
          Definition: display,
        });
      }
    }

    // -Name (positional or named): wildcard / exact, matched against the
    // display name. -Verb / -Noun split on the first dash.
    const nameRaw    = ctx.named['name'] ?? ctx.positional[0];
    const nameFilter = nameRaw !== undefined && nameRaw !== null && nameRaw !== ''
      ? psValueToString(nameRaw) : null;
    const verbFilter = ctx.named['verb'] ? psValueToString(ctx.named['verb']) : null;
    const nounFilter = ctx.named['noun'] ? psValueToString(ctx.named['noun']) : null;

    const nameMatches = (display: string): boolean => {
      const lower = display.toLowerCase();
      const dash  = display.indexOf('-');
      const verb  = dash > 0 ? display.slice(0, dash).toLowerCase() : '';
      const noun  = dash > 0 ? display.slice(dash + 1).toLowerCase() : lower;
      if (nameFilter && !wildcardLike(lower, nameFilter.toLowerCase())) return false;
      if (verbFilter && !wildcardLike(verb,  verbFilter.toLowerCase())) return false;
      if (nounFilter && !wildcardLike(noun,  nounFilter.toLowerCase())) return false;
      return true;
    };

    const filtered = (nameFilter || verbFilter || nounFilter)
      ? rows.filter(r => nameMatches(r.Name))
      : rows;

    // -CommandType filter
    const typeRaw = ctx.named['commandtype'];
    const typeFilter = typeRaw ? psValueToString(typeRaw).toLowerCase() : null;
    const byType = typeFilter
      ? filtered.filter(r => r.CommandType.toLowerCase() === typeFilter)
      : filtered;

    byType.sort((a, b) => a.Name.toLowerCase().localeCompare(b.Name.toLowerCase()));

    // De-duplicate by (CommandType, Name).
    const seen = new Set<string>();
    const unique = byType.filter(r => {
      const key = `${r.CommandType}::${r.Name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return unique as unknown as Record<string, PSValue>[];
  }
}

/** Convert a registry name like 'get-itemproperty' to 'Get-ItemProperty'. */
function titleCaseCmdletName(raw: string): string {
  return raw.split('-')
    .map(segment => segment.length === 0 ? '' :
      segment.replace(/(^|[^a-z])([a-z])/g, (_, prefix: string, ch: string) => prefix + ch.toUpperCase()))
    .join('-');
}

/** PowerShell-style match: literal substring OR `*?` wildcard (Like operator). */
function wildcardLike(value: string, pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return value === pattern;
  const re = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(re).test(value);
}

// ─── Get-Module ───────────────────────────────────────────────────────────

export class GetModuleCmdlet implements ICmdlet {
  readonly name = 'get-module';
  readonly aliases = [] as const;
  execute(ctx: CmdletContext): PSValue {
    const listAvail = ctx.named['listavailable'] === true || ctx.named['listavailable'] === 'true';
    if (listAvail) {
      return [
        { Name: 'Microsoft.PowerShell.Core',    Version: '5.1.0', ModuleType: 'Manifest' },
        { Name: 'Microsoft.PowerShell.Utility',  Version: '5.1.0', ModuleType: 'Manifest' },
        { Name: 'Microsoft.PowerShell.Management',Version: '5.1.0', ModuleType: 'Manifest' },
      ] as Record<string, PSValue>[];
    }
    return [] as PSValue[];
  }
}

// ─── Import-Module ────────────────────────────────────────────────────────

export class ImportModuleCmdlet implements ICmdlet {
  readonly name = 'import-module';
  readonly aliases = ['ipmo'] as const;
  execute(_ctx: CmdletContext): PSValue { return null; }
}

// ─── Invoke-Command ───────────────────────────────────────────────────────

export class InvokeCommandCmdlet implements ICmdlet {
  readonly name = 'invoke-command';
  readonly aliases = ['icm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const block = (ctx.named['scriptblock'] ?? ctx.positional[0]) as PSValue;
    if (!block) return null;
    return ctx.invokeBlock(block as never, null);
  }
}

// ─── Start-Job / Receive-Job / Wait-Job ───────────────────────────────────

let _jobCounter = 0;

export class StartJobCmdlet implements ICmdlet {
  readonly name = 'start-job';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const block = (ctx.named['scriptblock'] ?? ctx.positional[0]) as PSValue;
    const output = block ? ctx.invokeBlock(block as never, null) : null;
    const id = ++_jobCounter;
    return {
      Id: id, Name: `Job${id}`, State: 'Completed',
      Output: output === null ? [] : Array.isArray(output) ? output : [output],
      HasMoreData: true,
    } as Record<string, PSValue>;
  }
}

export class ReceiveJobCmdlet implements ICmdlet {
  readonly name = 'receive-job';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const job = (ctx.named['job'] ?? ctx.positional[0]) as Record<string, PSValue> | null;
    if (!job) return null;
    const out = job['Output'] as PSValue[];
    if (!out || out.length === 0) return null;
    return out.length === 1 ? out[0] : out;
  }
}

export class WaitJobCmdlet implements ICmdlet {
  readonly name = 'wait-job';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const job = (ctx.named['job'] ?? ctx.positional[0]) as Record<string, PSValue> | null;
    if (job) (job as Record<string, PSValue>)['State'] = 'Completed';
    return job;
  }
}

// ─── Set-Location ─────────────────────────────────────────────────────────

export class SetLocationCmdlet implements ICmdlet {
  readonly name = 'set-location';
  readonly aliases = ['cd', 'chdir', 'sl'] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
    const fs = ctx.providers.filesystem;
    if (fs && path) fs.setCwd(path);
    if (path) {
      ctx.runtime.setVariable('PWD', { Path: path, ProviderPath: path, Provider: 'FileSystem' } as Record<string, PSValue>);
    }
    return null;
  }
}

export class GetLocationCmdlet implements ICmdlet {
  readonly name = 'get-location';
  readonly aliases = ['pwd', 'gl'] as const;

  execute(ctx: CmdletContext): PSValue {
    const fs = ctx.providers.filesystem;
    const cwd = fs ? fs.getCwd() : 'C:\\';
    return { Path: cwd, ProviderPath: cwd, Provider: 'FileSystem' } as Record<string, PSValue>;
  }
}

// ─── New-PSDrive ──────────────────────────────────────────────────────────

export class NewPSDriveCmdlet implements ICmdlet {
  readonly name = 'new-psdrive';
  readonly displayName = 'New-PSDrive';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const root = psValueToString(ctx.named['root'] ?? '');
    const drive = { Name: name, Root: root, Used: 0, Free: 0 } as Record<string, PSValue>;
    // Register drive in global scope for Get-PSDrive to retrieve
    const existing = (ctx.runtime.getVariable('__drives__') as Record<string, PSValue> | null) ?? {};
    (existing as Record<string, PSValue>)[name.toLowerCase()] = drive;
    ctx.runtime.setVariable('__drives__', existing);
    return drive;
  }
}

// ─── Get-PSDrive ──────────────────────────────────────────────────────────

export class GetPSDriveCmdlet implements ICmdlet {
  readonly name = 'get-psdrive';
  readonly displayName = 'Get-PSDrive';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const nameFilter = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '').toLowerCase();
    const drives = (ctx.runtime.getVariable('__drives__') as Record<string, PSValue> | null) ?? {};
    const shape = (d: PSValue): Record<string, PSValue> => {
      const rec = d as Record<string, PSValue>;
      return {
        Name:     rec['Name'],
        Used:     rec['Used'] ?? '',
        Free:     rec['Free'] ?? '',
        Provider: rec['Provider'] ?? inferProvider(String(rec['Root'] ?? '')),
        Root:     rec['Root'],
      } as Record<string, PSValue>;
    };
    if (nameFilter) {
      const drive = drives[nameFilter];
      return drive ? shape(drive) : null;
    }
    return Object.values(drives).map(shape);
  }
}

function inferProvider(root: string): string {
  if (/^[A-Za-z]:\\?$/.test(root)) return 'FileSystem';
  if (/^HK/i.test(root))           return 'Registry';
  return '';
}

// ─── Clear-Host ───────────────────────────────────────────────────────────

export class ClearHostCmdlet implements ICmdlet {
  readonly name = 'clear-host';
  readonly aliases = ['cls', 'clear'] as const;
  execute(_ctx: CmdletContext): PSValue { return null; }
}

// ─── Get-Alias ────────────────────────────────────────────────────────────
//
// Returns the built-in alias map.  Real PowerShell ships dozens; we mirror
// every alias declared on a registered cmdlet so the listing stays in sync
// with whatever the interpreter actually accepts.  `Get-Alias <name>` and
// `Get-Alias -Name <pattern>` filter the result.

interface AliasEntry { Name: string; Definition: string; CommandType: string }

export class GetAliasCmdlet implements ICmdlet {
  readonly name = 'get-alias';
  readonly aliases = ['gal'] as const;

  execute(ctx: CmdletContext): PSValue {
    const filter = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '').trim();
    const all: AliasEntry[] = [];
    for (const cmdlet of ctx.runtime.listCmdlets()) {
      for (const a of cmdlet.aliases) {
        all.push({ Name: a, Definition: cmdlet.name, CommandType: 'Alias' });
      }
    }
    all.sort((a, b) => a.Name.localeCompare(b.Name));
    if (!filter) return all as unknown as PSValue;
    const pat = wildcardToRegex(filter);
    const matched = all.filter(e => pat.test(e.Name));
    if (matched.length === 0) {
      ctx.emitError(`Get-Alias : Cannot find alias because alias with name '${filter}' does not exist.`);
      return null;
    }
    return matched as unknown as PSValue;
  }
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

// ─── Get-PSProvider ───────────────────────────────────────────────────────

export class GetPSProviderCmdlet implements ICmdlet {
  readonly name = 'get-psprovider';
  readonly displayName = 'Get-PSProvider';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const filter = psValueToString(ctx.named['psprovider'] ?? ctx.positional[0] ?? '').trim();
    const providers = [
      { Name: 'Alias',       Capabilities: 'ShouldProcess',                         Drives: 'Alias' },
      { Name: 'Environment', Capabilities: 'ShouldProcess',                         Drives: 'Env'   },
      { Name: 'FileSystem',  Capabilities: 'Filter, ShouldProcess, Credentials',    Drives: 'C, D'  },
      { Name: 'Function',    Capabilities: 'ShouldProcess',                         Drives: 'Function' },
      { Name: 'Registry',    Capabilities: 'ShouldProcess, Transactions',           Drives: 'HKLM, HKCU' },
      { Name: 'Variable',    Capabilities: 'ShouldProcess',                         Drives: 'Variable' },
    ];
    if (!filter) return providers as unknown as PSValue;
    const pat = wildcardToRegex(filter);
    const matched = providers.filter(p => pat.test(p.Name));
    return matched as unknown as PSValue;
  }
}
