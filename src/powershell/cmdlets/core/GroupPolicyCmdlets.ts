/**
 * GroupPolicyCmdlets — the minimal `GroupPolicy` PowerShell surface
 * (PRD-Windows-Server.md §5 P10): `New-GPO`, `Get-GPO`, `New-GPLink`.
 * `gpupdate`/`gpresult` are native EXEs, not cmdlets — see
 * `WindowsPC.gpupdateForce()`/`cmdGpresult()`, dispatched from
 * `executeCmdCommand` like `dcdiag`/`nltest`.
 *
 * Provider: ctx.providers.gpo (IGpoProvider), populated only when this
 * device is a domain controller (`getDirectoryStore() !== null`) — see
 * `WindowsGpoAdapter`.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IGpoProvider, GpoInfo, GpLinkOptions } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireGpo(ctx: CmdletContext, cmdletName: string): IGpoProvider {
  if (!ctx.providers.gpo) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.gpo;
}

function gpoToPSObject(g: GpoInfo): Record<string, PSValue> {
  return { Id: g.id, DisplayName: g.name, Links: g.links.join('; ') };
}
function nameOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
}
function linkOptionsOf(ctx: CmdletContext): GpLinkOptions {
  const opts: GpLinkOptions = {};
  if (ctx.named['linkenabled'] !== undefined) opts.linkEnabled = /^(yes|true)$/i.test(psValueToString(ctx.named['linkenabled']));
  if (ctx.named['enforced'] !== undefined) opts.enforced = /^(yes|true)$/i.test(psValueToString(ctx.named['enforced']));
  if (ctx.named['order'] !== undefined) opts.order = Number(psValueToString(ctx.named['order']));
  return opts;
}

export class NewGPOCmdlet implements ICmdlet {
  readonly name = 'new-gpo';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'New-GPO');
    const name = nameOf(ctx);
    if (!name) { ctx.emitError('New-GPO : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    const res = gpo.newGpo(name);
    if (!res.ok) { ctx.emitError(`New-GPO : ${res.message}`); return null; }
    const created = gpo.getGpo(name);
    return created ? gpoToPSObject(created) : null;
  }
}

export class GetGPOCmdlet implements ICmdlet {
  readonly name = 'get-gpo';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'All'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Get-GPO');
    const name = nameOf(ctx);
    if (name) {
      const g = gpo.getGpo(name);
      if (!g) { ctx.emitError(`Get-GPO : A GPO with the name "${name}" cannot be found.`); return null; }
      return gpoToPSObject(g);
    }
    return gpo.listGpos().map(gpoToPSObject);
  }
}

export class NewGPLinkCmdlet implements ICmdlet {
  readonly name = 'new-gplink';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Target', 'LinkEnabled', 'Enforced', 'Order'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'New-GPLink');
    const name = nameOf(ctx);
    const target = psValueToString(ctx.named['target'] ?? '') || gpo.getDomainDn();
    if (!name) { ctx.emitError('New-GPLink : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    const res = gpo.newGPLink(name, target, linkOptionsOf(ctx));
    if (!res.ok) { ctx.emitError(`New-GPLink : ${res.message}`); return null; }
    return null;
  }
}

export class SetGPLinkCmdlet implements ICmdlet {
  readonly name = 'set-gplink';
  readonly displayName = 'Set-GPLink';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Target', 'LinkEnabled', 'Enforced', 'Order'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Set-GPLink');
    const name = nameOf(ctx);
    const target = psValueToString(ctx.named['target'] ?? '') || gpo.getDomainDn();
    if (!name) { ctx.emitError('Set-GPLink : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    const res = gpo.setGpLink(name, target, linkOptionsOf(ctx));
    if (!res.ok) { ctx.emitError(`Set-GPLink : ${res.message}`); return null; }
    return null;
  }
}

export class SetGPRegistryValueCmdlet implements ICmdlet {
  readonly name = 'set-gpregistryvalue';
  readonly displayName = 'Set-GPRegistryValue';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Key', 'ValueName', 'Type', 'Value'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Set-GPRegistryValue');
    const name = nameOf(ctx);
    const key = psValueToString(ctx.named['key'] ?? '');
    const valueName = psValueToString(ctx.named['valuename'] ?? '');
    const type = psValueToString(ctx.named['type'] ?? 'String');
    const value = psValueToString(ctx.named['value'] ?? '');
    if (!name || !key || !valueName) {
      ctx.emitError('Set-GPRegistryValue : Cannot process command because of one or more missing mandatory parameters: Name, Key, ValueName.');
      return null;
    }
    const res = gpo.setGpRegistryValue(name, key, valueName, type, value);
    if (!res.ok) { ctx.emitError(`Set-GPRegistryValue : ${res.message}`); return null; }
    return null;
  }
}

export class SetGPInheritanceCmdlet implements ICmdlet {
  readonly name = 'set-gpinheritance';
  readonly displayName = 'Set-GPInheritance';
  readonly aliases = [] as const;
  readonly parameters = ['Target', 'IsBlocked'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Set-GPInheritance');
    const target = psValueToString(ctx.named['target'] ?? '');
    if (!target) { ctx.emitError('Set-GPInheritance : Cannot process command because of one or more missing mandatory parameters: Target.'); return null; }
    const blocked = /^(yes|true)$/i.test(psValueToString(ctx.named['isblocked'] ?? ''));
    const res = gpo.setGpInheritance(target, blocked);
    if (!res.ok) { ctx.emitError(`Set-GPInheritance : ${res.message}`); return null; }
    return { Target: target, GpoInheritanceBlocked: blocked } as Record<string, PSValue>;
  }
}

export class GetGPInheritanceCmdlet implements ICmdlet {
  readonly name = 'get-gpinheritance';
  readonly displayName = 'Get-GPInheritance';
  readonly aliases = [] as const;
  readonly parameters = ['Target'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Get-GPInheritance');
    const target = psValueToString(ctx.named['target'] ?? '');
    if (!target) { ctx.emitError('Get-GPInheritance : Cannot process command because of one or more missing mandatory parameters: Target.'); return null; }
    const res = gpo.getGpInheritance(target);
    if (!res) { ctx.emitError(`Get-GPInheritance : Cannot find an object with distinguished name: '${target}'.`); return null; }
    return {
      Path: res.dn,
      GpoInheritanceBlocked: res.gpoInheritanceBlocked,
      GpoLinks: res.gpoLinks.map(l => ({
        DisplayName: l.displayName, Enabled: l.enabled, Enforced: l.enforced, Order: l.order,
      })) as PSValue[],
    } as Record<string, PSValue>;
  }
}
