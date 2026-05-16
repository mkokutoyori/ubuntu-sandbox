/**
 * VariableCmdlets — Get/Set/Clear/Remove/New-Variable.
 *
 * These cmdlets manipulate the PowerShell variable scope chain.
 * No system providers required.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

// ─── Set-Variable ──────────────────────────────────────────────────────────

export class SetVariableCmdlet implements ICmdlet {
  readonly name = 'set-variable';
  readonly parameters = ['Name', 'Value', 'Description', 'Option', 'Force', 'Visibility', 'PassThru', 'Scope'] as const;
  readonly aliases = ['sv'] as const;

  execute(ctx: CmdletContext): PSValue {
    const vname = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const val   = ctx.named['value'] ?? ctx.positional[1] ?? null;
    if (vname) ctx.env.set(vname, val);
    return null;
  }
}

// ─── Get-Variable ─────────────────────────────────────────────────────────

export class GetVariableCmdlet implements ICmdlet {
  readonly name = 'get-variable';
  readonly parameters = ['Name', 'ValueOnly', 'Include', 'Exclude', 'Scope'] as const;
  readonly aliases = ['gv'] as const;

  execute(ctx: CmdletContext): PSValue {
    const vname = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!vname) return null;
    const val = ctx.env.get(vname);
    if (ctx.named['valueonly'] === true) return val ?? null;
    return { Name: vname, Value: val ?? null } as Record<string, PSValue>;
  }
}

// ─── Clear-Variable ────────────────────────────────────────────────────────

export class ClearVariableCmdlet implements ICmdlet {
  readonly name = 'clear-variable';
  readonly parameters = ['Name', 'Include', 'Exclude', 'Force', 'PassThru', 'Scope'] as const;
  readonly aliases = ['clv'] as const;

  execute(ctx: CmdletContext): PSValue {
    const vname = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (vname) ctx.env.set(vname, null);
    return null;
  }
}

// ─── Remove-Variable ──────────────────────────────────────────────────────

export class RemoveVariableCmdlet implements ICmdlet {
  readonly name = 'remove-variable';
  readonly parameters = ['Name', 'Include', 'Exclude', 'Force', 'Scope'] as const;
  readonly aliases = ['rv'] as const;

  execute(ctx: CmdletContext): PSValue {
    const vname = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (vname) ctx.env.deleteInScope(vname);
    return null;
  }
}

// ─── New-Variable ─────────────────────────────────────────────────────────

export class NewVariableCmdlet implements ICmdlet {
  readonly name = 'new-variable';
  readonly parameters = ['Name', 'Value', 'Description', 'Option', 'Visibility', 'Force', 'PassThru', 'Scope'] as const;
  readonly aliases = ['nv'] as const;

  execute(ctx: CmdletContext): PSValue {
    const vname = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const val   = ctx.named['value'] ?? ctx.positional[1] ?? null;
    if (vname) ctx.env.set(vname, val);
    return null;
  }
}
