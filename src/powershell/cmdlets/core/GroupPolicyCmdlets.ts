import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IGpoProvider, GpoInfo, GpLinkOptions, GpRegistryValueInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import { jobInfoToPS } from './MiscCmdlets';

function requireGpo(ctx: CmdletContext, cmdletName: string): IGpoProvider {
  if (!ctx.providers.gpo) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.gpo;
}

function gpoToPSObject(g: GpoInfo): Record<string, PSValue> {
  return { Id: g.id, DisplayName: g.name, Description: g.description, Links: g.links.join('; ') };
}

function registryValueToPSObject(v: GpRegistryValueInfo): Record<string, PSValue> {
  const hive = /^(HKEY_LOCAL_MACHINE|HKLM)/i.test(v.key) ? 'LocalMachine' : 'CurrentUser';
  const keyPath = v.key.replace(/^(HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKLM|HKCU):?\\?/i, '');
  const numeric = v.type === 'DWord' || v.type === 'QWord';
  return {
    FullKeyPath: v.key, Hive: hive, KeyPath: keyPath, ValueName: v.valueName, Type: v.type,
    Value: numeric ? Number(v.value) : v.value, PolicyState: 'Set',
  };
}

function nameOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
}

const YES_NO = new Map([['yes', true], ['true', true], ['no', false], ['false', false]]);

function yesNo(ctx: CmdletContext, cmdlet: string, parameter: string, enumType: string): boolean | undefined | 'invalid' {
  const raw = ctx.named[parameter.toLowerCase()];
  if (raw === undefined) return undefined;
  const text = psValueToString(raw);
  const parsed = YES_NO.get(text.toLowerCase());
  if (parsed !== undefined) return parsed;
  ctx.emitError(`${cmdlet} : Cannot process argument transformation on parameter '${parameter}'. Cannot convert value "${text}" to type "Microsoft.GroupPolicy.${enumType}". Error: "Unable to match the identifier name ${text} to a valid enumerator name. Specify one of the following enumerator names and try again: No, Yes"`);
  return 'invalid';
}

function linkOptionsOf(ctx: CmdletContext, cmdlet: string): GpLinkOptions | 'invalid' {
  const opts: GpLinkOptions = {};
  const enabled = yesNo(ctx, cmdlet, 'LinkEnabled', 'EnableLink');
  const enforced = yesNo(ctx, cmdlet, 'Enforced', 'EnforceLink');
  if (enabled === 'invalid' || enforced === 'invalid') return 'invalid';
  if (enabled !== undefined) opts.linkEnabled = enabled;
  if (enforced !== undefined) opts.enforced = enforced;
  if (ctx.named['order'] !== undefined) {
    const order = Number(psValueToString(ctx.named['order']));
    if (!Number.isInteger(order) || order < 1) {
      ctx.emitError(`${cmdlet} : Cannot validate argument on parameter 'Order'. The ${psValueToString(ctx.named['order'])} argument is less than the minimum allowed range of 1.`);
      return 'invalid';
    }
    opts.order = order;
  }
  return opts;
}

function domainMatches(ctx: CmdletContext, gpo: IGpoProvider, cmdlet: string): boolean {
  const domain = psValueToString(ctx.named['domain'] ?? '');
  if (domain === '' || domain.toLowerCase() === gpo.getDomainName().toLowerCase()) return true;
  ctx.emitError(`${cmdlet} : The domain "${domain}" cannot be reached: this domain controller serves "${gpo.getDomainName()}".`);
  return false;
}

export class NewGPOCmdlet implements ICmdlet {
  readonly name = 'new-gpo';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Comment', 'Domain', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'New-GPO');
    const name = nameOf(ctx);
    if (!name) { ctx.emitError('New-GPO : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    if (!domainMatches(ctx, gpo, 'New-GPO')) return null;
    const comment = ctx.named['comment'] !== undefined ? psValueToString(ctx.named['comment']) : undefined;
    const res = gpo.newGpo(name, comment);
    if (!res.ok) { ctx.emitError(`New-GPO : ${res.message}`); return null; }
    const created = gpo.getGpo(name);
    return created ? gpoToPSObject(created) : null;
  }
}

export class GetGPOCmdlet implements ICmdlet {
  readonly name = 'get-gpo';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'All', 'Domain', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Get-GPO');
    if (!domainMatches(ctx, gpo, 'Get-GPO')) return null;
    const name = nameOf(ctx);
    if (name) {
      const g = gpo.getGpo(name);
      if (!g) { ctx.emitError(`Get-GPO : A GPO with the name "${name}" cannot be found.`); return null; }
      return gpoToPSObject(g);
    }
    return gpo.listGpos().map(gpoToPSObject);
  }
}

export class RemoveGPOCmdlet implements ICmdlet {
  readonly name = 'remove-gpo';
  readonly displayName = 'Remove-GPO';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'KeepLinks', 'Domain', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Remove-GPO');
    const name = nameOf(ctx);
    if (!name) { ctx.emitError('Remove-GPO : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    if (!domainMatches(ctx, gpo, 'Remove-GPO')) return null;
    const res = gpo.removeGpo(name, ctx.named['keeplinks'] === true);
    if (!res.ok) ctx.emitError(`Remove-GPO : ${res.message}`);
    return null;
  }
}

export class RenameGPOCmdlet implements ICmdlet {
  readonly name = 'rename-gpo';
  readonly displayName = 'Rename-GPO';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'TargetName', 'Domain', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Rename-GPO');
    const name = nameOf(ctx);
    const target = psValueToString(ctx.named['targetname'] ?? '');
    if (!name || !target) { ctx.emitError('Rename-GPO : Cannot process command because of one or more missing mandatory parameters: Name, TargetName.'); return null; }
    if (!domainMatches(ctx, gpo, 'Rename-GPO')) return null;
    const res = gpo.renameGpo(name, target);
    if (!res.ok) { ctx.emitError(`Rename-GPO : ${res.message}`); return null; }
    const renamed = gpo.getGpo(target);
    return renamed ? gpoToPSObject(renamed) : null;
  }
}

export class NewGPLinkCmdlet implements ICmdlet {
  readonly name = 'new-gplink';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Target', 'LinkEnabled', 'Enforced', 'Order', 'Domain', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'New-GPLink');
    const name = nameOf(ctx);
    const target = psValueToString(ctx.named['target'] ?? '') || gpo.getDomainDn();
    if (!name) { ctx.emitError('New-GPLink : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    if (!domainMatches(ctx, gpo, 'New-GPLink')) return null;
    const options = linkOptionsOf(ctx, 'New-GPLink');
    if (options === 'invalid') return null;
    const res = gpo.newGPLink(name, target, options);
    if (!res.ok) { ctx.emitError(`New-GPLink : ${res.message}`); return null; }
    return null;
  }
}

export class SetGPLinkCmdlet implements ICmdlet {
  readonly name = 'set-gplink';
  readonly displayName = 'Set-GPLink';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Target', 'LinkEnabled', 'Enforced', 'Order', 'Domain', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Set-GPLink');
    const name = nameOf(ctx);
    const target = psValueToString(ctx.named['target'] ?? '') || gpo.getDomainDn();
    if (!name) { ctx.emitError('Set-GPLink : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    if (!domainMatches(ctx, gpo, 'Set-GPLink')) return null;
    const options = linkOptionsOf(ctx, 'Set-GPLink');
    if (options === 'invalid') return null;
    const res = gpo.setGpLink(name, target, options);
    if (!res.ok) { ctx.emitError(`Set-GPLink : ${res.message}`); return null; }
    return null;
  }
}

export class RemoveGPLinkCmdlet implements ICmdlet {
  readonly name = 'remove-gplink';
  readonly displayName = 'Remove-GPLink';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Target', 'Domain', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Remove-GPLink');
    const name = nameOf(ctx);
    const target = psValueToString(ctx.named['target'] ?? '');
    if (!name || !target) { ctx.emitError('Remove-GPLink : Cannot process command because of one or more missing mandatory parameters: Name, Target.'); return null; }
    if (!domainMatches(ctx, gpo, 'Remove-GPLink')) return null;
    const res = gpo.removeGpLink(name, target);
    if (!res.ok) ctx.emitError(`Remove-GPLink : ${res.message}`);
    return null;
  }
}

export class SetGPRegistryValueCmdlet implements ICmdlet {
  readonly name = 'set-gpregistryvalue';
  readonly displayName = 'Set-GPRegistryValue';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Key', 'ValueName', 'Type', 'Value', 'Domain', 'Server'] as const;

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
    if (!domainMatches(ctx, gpo, 'Set-GPRegistryValue')) return null;
    const res = gpo.setGpRegistryValue(name, key, valueName, type, value);
    if (!res.ok) { ctx.emitError(`Set-GPRegistryValue : ${res.message}`); return null; }
    return null;
  }
}

export class GetGPRegistryValueCmdlet implements ICmdlet {
  readonly name = 'get-gpregistryvalue';
  readonly displayName = 'Get-GPRegistryValue';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Key', 'ValueName', 'Domain', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Get-GPRegistryValue');
    const name = nameOf(ctx);
    const key = psValueToString(ctx.named['key'] ?? '');
    const valueName = psValueToString(ctx.named['valuename'] ?? '');
    if (!name || !key) { ctx.emitError('Get-GPRegistryValue : Cannot process command because of one or more missing mandatory parameters: Name, Key.'); return null; }
    if (!domainMatches(ctx, gpo, 'Get-GPRegistryValue')) return null;
    const values = gpo.getGpRegistryValues(name, key, valueName);
    if (values === null) { ctx.emitError(`Get-GPRegistryValue : A GPO with the name "${name}" cannot be found.`); return null; }
    if (values.length === 0) {
      ctx.emitError(`Get-GPRegistryValue : The following Group Policy registry setting was not found: ${key}${valueName ? `\\${valueName}` : ''}`);
      return null;
    }
    return values.map(registryValueToPSObject) as PSValue;
  }
}

export class RemoveGPRegistryValueCmdlet implements ICmdlet {
  readonly name = 'remove-gpregistryvalue';
  readonly displayName = 'Remove-GPRegistryValue';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Key', 'ValueName', 'Domain', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Remove-GPRegistryValue');
    const name = nameOf(ctx);
    const key = psValueToString(ctx.named['key'] ?? '');
    const valueName = psValueToString(ctx.named['valuename'] ?? '');
    if (!name || !key) { ctx.emitError('Remove-GPRegistryValue : Cannot process command because of one or more missing mandatory parameters: Name, Key.'); return null; }
    if (!domainMatches(ctx, gpo, 'Remove-GPRegistryValue')) return null;
    const res = gpo.removeGpRegistryValue(name, key, valueName);
    if (!res.ok) ctx.emitError(`Remove-GPRegistryValue : ${res.message}`);
    return null;
  }
}

export class SetGPInheritanceCmdlet implements ICmdlet {
  readonly name = 'set-gpinheritance';
  readonly displayName = 'Set-GPInheritance';
  readonly aliases = [] as const;
  readonly parameters = ['Target', 'IsBlocked', 'Domain', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Set-GPInheritance');
    const target = psValueToString(ctx.named['target'] ?? '');
    if (!target) { ctx.emitError('Set-GPInheritance : Cannot process command because of one or more missing mandatory parameters: Target.'); return null; }
    if (!domainMatches(ctx, gpo, 'Set-GPInheritance')) return null;
    const blocked = yesNo(ctx, 'Set-GPInheritance', 'IsBlocked', 'BlockInheritance');
    if (blocked === 'invalid') return null;
    const res = gpo.setGpInheritance(target, blocked === true);
    if (!res.ok) { ctx.emitError(`Set-GPInheritance : ${res.message}`); return null; }
    return { Target: target, GpoInheritanceBlocked: blocked === true } as Record<string, PSValue>;
  }
}

export class GetGPInheritanceCmdlet implements ICmdlet {
  readonly name = 'get-gpinheritance';
  readonly displayName = 'Get-GPInheritance';
  readonly aliases = [] as const;
  readonly parameters = ['Target', 'Domain', 'Server'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Get-GPInheritance');
    const target = psValueToString(ctx.named['target'] ?? '');
    if (!target) { ctx.emitError('Get-GPInheritance : Cannot process command because of one or more missing mandatory parameters: Target.'); return null; }
    if (!domainMatches(ctx, gpo, 'Get-GPInheritance')) return null;
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

export class InvokeGPUpdateCmdlet implements ICmdlet {
  readonly name = 'invoke-gpupdate';
  readonly aliases = [] as const;
  readonly parameters = ['Computer', 'Target', 'Force', 'Boot', 'LogOff', 'RandomDelayInMinutes', 'Sync', 'AsJob'] as const;

  execute(ctx: CmdletContext): PSValue {
    const gpo = requireGpo(ctx, 'Invoke-GPUpdate');
    const wanted = ctx.named['target'] !== undefined ? psValueToString(ctx.named['target']).toLowerCase() : 'both';
    if (!['both', 'computer', 'user'].includes(wanted)) {
      ctx.emitError(`Invoke-GPUpdate : Cannot validate argument on parameter 'Target'. The argument "${wanted}" does not belong to the set "Computer,User".`);
      return null;
    }
    const maxDelay = ctx.named['randomdelayinminutes'] !== undefined ? Number(psValueToString(ctx.named['randomdelayinminutes'])) : 10;
    if (!Number.isInteger(maxDelay) || maxDelay < 0) {
      ctx.emitError('Invoke-GPUpdate : Cannot validate argument on parameter \'RandomDelayInMinutes\'. The value must be a non-negative integer.');
      return null;
    }
    const delay = gpo.refreshDelayMinutes(maxDelay);
    const computers = ctx.named['computer'] !== undefined
      ? (Array.isArray(ctx.named['computer']) ? ctx.named['computer'] : [ctx.named['computer']]).map(psValueToString).filter(c => c !== '')
      : [];
    const remoting = ctx.providers.remoting;
    const own = remoting?.localComputerName().toLowerCase() ?? '';
    const remote = computers.filter(c => !['.', 'localhost', '127.0.0.1', '::1'].includes(c.toLowerCase())
      && c.toLowerCase() !== own && !c.toLowerCase().startsWith(`${own}.`));
    if (remote.length > 0 && remoting) {
      for (const computer of remote) {
        const outcome = remoting.refreshPolicy(computer, wanted as 'both' | 'computer' | 'user', delay);
        if (!outcome.ok) ctx.emitError(`Invoke-GPUpdate : Cannot connect to ${computer}: ${outcome.error ?? 'Access is denied.'}`);
        else if ((outcome.output ?? '') !== '') ctx.emitError(`Invoke-GPUpdate : ${computer}: ${(outcome.output ?? '').trim()}`);
      }
      return null;
    }
    gpo.waitMinutes(delay);
    const result = gpo.applyPolicy(wanted as 'both' | 'computer' | 'user');
    if (!result.ok) {
      ctx.emitError(`Invoke-GPUpdate : ${result.message}`);
      return null;
    }
    if (ctx.named['asjob'] === true && ctx.providers.jobs) return jobInfoToPS(ctx.providers.jobs.startJob(undefined, [], 0));
    return null;
  }
}
