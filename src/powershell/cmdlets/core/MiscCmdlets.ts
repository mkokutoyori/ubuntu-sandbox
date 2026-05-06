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
    const nameFilter = ctx.positional[0] ? psValueToString(ctx.positional[0]) : null;
    // Return a minimal list — full list comes from registry when wired
    const stubs = [
      'Write-Host', 'Write-Output', 'Write-Error', 'Write-Warning',
      'ForEach-Object', 'Where-Object', 'Select-Object', 'Sort-Object',
      'Measure-Object', 'Group-Object', 'Format-Table', 'Format-List',
      'ConvertTo-Json', 'ConvertFrom-Json', 'Get-Date', 'Set-Variable',
      'Get-Variable', 'Remove-Variable', 'Invoke-Expression', 'Test-Path',
    ];
    const filtered = nameFilter
      ? stubs.filter(n => n.toLowerCase().includes(nameFilter.toLowerCase()))
      : stubs;
    return filtered.map(n => ({ Name: n, CommandType: 'Cmdlet', Source: '' }) as Record<string, PSValue>);
  }
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

// ─── New-PSDrive ──────────────────────────────────────────────────────────

export class NewPSDriveCmdlet implements ICmdlet {
  readonly name = 'new-psdrive';
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
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const nameFilter = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '').toLowerCase();
    const drives = (ctx.runtime.getVariable('__drives__') as Record<string, PSValue> | null) ?? {};
    if (nameFilter) {
      const drive = drives[nameFilter];
      if (drive) {
        const d = drive as Record<string, PSValue>;
        ctx.emit(`${d['Name']}  ${d['Root']}`);
        return drive;
      }
      return null;
    }
    const all = Object.values(drives);
    for (const d of all) ctx.emit(`${(d as Record<string, PSValue>)['Name']}  ${(d as Record<string, PSValue>)['Root']}`);
    return all.length === 1 ? all[0] : all;
  }
}

// ─── Clear-Host ───────────────────────────────────────────────────────────

export class ClearHostCmdlet implements ICmdlet {
  readonly name = 'clear-host';
  readonly aliases = ['cls', 'clear'] as const;
  execute(_ctx: CmdletContext): PSValue { return null; }
}
