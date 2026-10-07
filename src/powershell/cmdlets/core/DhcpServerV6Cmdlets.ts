import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IDhcpServerV6Provider } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { makeTimeSpan } from '@/powershell/runtime/dotnetTimeSpan';
import { isSwitchOn, timeSpanSeconds } from './DnsServerCmdlets';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import type { DhcpV6ScopeInfo, DhcpV6ScopeRequest } from '@/network/devices/windows/server/dhcp/WindowsDhcpv6';

function requireV6(ctx: CmdletContext, cmdletName: string): IDhcpServerV6Provider {
  const dhcp = ctx.providers.dhcp;
  if (!dhcp) throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  return dhcp.v6();
}

function text(ctx: CmdletContext, name: string): string {
  return ctx.named[name] === undefined ? '' : psValueToString(ctx.named[name]);
}

function list(raw: PSValue | undefined): string[] {
  if (raw === undefined || raw === null) return [];
  return Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)];
}

function scopeObject(scope: DhcpV6ScopeInfo): Record<string, PSValue> {
  return {
    Prefix: scope.prefix, Name: scope.name, Description: scope.description, State: scope.state,
    Preference: scope.preference,
    PreferredLifetime: makeTimeSpan(scope.preferredLifetime * 1000),
    ValidLifetime: makeTimeSpan(scope.validLifetime * 1000),
    T1: makeTimeSpan(scope.t1 * 1000), T2: makeTimeSpan(scope.t2 * 1000),
  };
}

function fail(ctx: CmdletContext, cmdletName: string, message: string): null {
  ctx.emitError(`${cmdletName} : ${message}`);
  return null;
}

function scopeFields(ctx: CmdletContext, parameter: (name: string) => number | undefined): Partial<DhcpV6ScopeRequest> {
  const fields: Partial<DhcpV6ScopeRequest> = {};
  const preferred = parameter('preferredlifetime');
  const valid = parameter('validlifetime');
  const t1 = parameter('t1');
  const t2 = parameter('t2');
  if (preferred !== undefined) fields.preferredLifetime = preferred;
  if (valid !== undefined) fields.validLifetime = valid;
  if (t1 !== undefined) fields.t1 = t1;
  if (t2 !== undefined) fields.t2 = t2;
  if (ctx.named['description'] !== undefined) fields.description = text(ctx, 'description');
  if (ctx.named['state'] !== undefined) fields.state = text(ctx, 'state').toLowerCase() === 'active' ? 'Active' : 'InActive';
  if (ctx.named['preference'] !== undefined) fields.preference = Number(text(ctx, 'preference'));
  return fields;
}

function spans(ctx: CmdletContext): (name: string) => number | undefined {
  return name => (ctx.named[name] === undefined ? undefined : timeSpanSeconds(ctx.named[name], name));
}

const SCOPE_PARAMETERS = ['Prefix', 'Name', 'Description', 'PreferredLifetime', 'ValidLifetime', 'T1', 'T2', 'State', 'Preference', 'PassThru'] as const;

export class AddDhcpServerv6ScopeCmdlet implements ICmdlet {
  readonly name = 'add-dhcpserverv6scope';
  readonly displayName = 'Add-DhcpServerv6Scope';
  readonly aliases = [] as const;
  readonly parameters = SCOPE_PARAMETERS;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    const prefix = text(ctx, 'prefix');
    const name = text(ctx, 'name');
    if (!prefix || !name) {
      return fail(ctx, this.displayName, 'Cannot process command because of one or more missing mandatory parameters: Prefix Name.');
    }
    const result = v6.addScope({ prefix, name, ...scopeFields(ctx, spans(ctx)) });
    if (!result.ok) return fail(ctx, this.displayName, result.message);
    return isSwitchOn(ctx.named['passthru']) ? scopeObject(v6.getScope(prefix)!) : null;
  }
}

export class GetDhcpServerv6ScopeCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv6scope';
  readonly displayName = 'Get-DhcpServerv6Scope';
  readonly aliases = [] as const;
  readonly parameters = ['Prefix'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    const prefix = text(ctx, 'prefix');
    if (!prefix) return v6.listScopes().map(scopeObject);
    const scope = v6.getScope(prefix);
    return scope ? scopeObject(scope) : fail(ctx, this.displayName, `The scope with prefix ${prefix} does not exist on the DHCP server.`);
  }
}

export class SetDhcpServerv6ScopeCmdlet implements ICmdlet {
  readonly name = 'set-dhcpserverv6scope';
  readonly displayName = 'Set-DhcpServerv6Scope';
  readonly aliases = [] as const;
  readonly parameters = [...SCOPE_PARAMETERS, 'NewName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    const prefix = text(ctx, 'prefix');
    if (!prefix) return fail(ctx, this.displayName, 'Cannot process command because of one or more missing mandatory parameters: Prefix.');
    const changes = { ...scopeFields(ctx, spans(ctx)), newName: ctx.named['newname'] === undefined ? undefined : text(ctx, 'newname') };
    const result = v6.setScope(prefix, changes);
    if (!result.ok) return fail(ctx, this.displayName, result.message);
    return isSwitchOn(ctx.named['passthru']) ? scopeObject(v6.getScope(prefix)!) : null;
  }
}

export class RemoveDhcpServerv6ScopeCmdlet implements ICmdlet {
  readonly name = 'remove-dhcpserverv6scope';
  readonly displayName = 'Remove-DhcpServerv6Scope';
  readonly aliases = [] as const;
  readonly parameters = ['Prefix', 'Force'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    const prefix = text(ctx, 'prefix');
    if (!prefix) return fail(ctx, this.displayName, 'Cannot process command because of one or more missing mandatory parameters: Prefix.');
    const result = v6.removeScope(prefix);
    return result.ok ? null : fail(ctx, this.displayName, result.message);
  }
}

export class AddDhcpServerv6ExclusionRangeCmdlet implements ICmdlet {
  readonly name = 'add-dhcpserverv6exclusionrange';
  readonly displayName = 'Add-DhcpServerv6ExclusionRange';
  readonly aliases = [] as const;
  readonly parameters = ['Prefix', 'StartRange', 'EndRange'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    const prefix = text(ctx, 'prefix');
    const start = text(ctx, 'startrange');
    const end = text(ctx, 'endrange');
    if (!prefix || !start || !end) {
      return fail(ctx, this.displayName, 'Cannot process command because of one or more missing mandatory parameters: Prefix StartRange EndRange.');
    }
    const result = v6.addExclusionRange(prefix, start, end);
    return result.ok ? null : fail(ctx, this.displayName, result.message);
  }
}

export class GetDhcpServerv6ExclusionRangeCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv6exclusionrange';
  readonly displayName = 'Get-DhcpServerv6ExclusionRange';
  readonly aliases = [] as const;
  readonly parameters = ['Prefix'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    return v6.listExclusionRanges(text(ctx, 'prefix') || undefined)
      .map(range => ({ Prefix: range.prefix, StartRange: range.startRange, EndRange: range.endRange }));
  }
}

export class AddDhcpServerv6ReservationCmdlet implements ICmdlet {
  readonly name = 'add-dhcpserverv6reservation';
  readonly displayName = 'Add-DhcpServerv6Reservation';
  readonly aliases = [] as const;
  readonly parameters = ['Prefix', 'IPAddress', 'ClientDuid', 'Iaid', 'Name', 'Description'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    const prefix = text(ctx, 'prefix');
    const address = text(ctx, 'ipaddress');
    const duid = text(ctx, 'clientduid');
    const iaid = text(ctx, 'iaid');
    if (!prefix || !address || !duid || iaid === '') {
      return fail(ctx, this.displayName, 'Cannot process command because of one or more missing mandatory parameters: Prefix IPAddress ClientDuid Iaid.');
    }
    const result = v6.addReservation(prefix, address, duid, Number(iaid), text(ctx, 'name'));
    return result.ok ? null : fail(ctx, this.displayName, result.message);
  }
}

export class GetDhcpServerv6ReservationCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv6reservation';
  readonly displayName = 'Get-DhcpServerv6Reservation';
  readonly aliases = [] as const;
  readonly parameters = ['Prefix'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    return v6.listReservations(text(ctx, 'prefix') || undefined).map(r => ({
      IPAddress: r.ipAddress, ClientDuid: r.clientDuid, Iaid: r.iaid, Name: r.name, ScopeId: r.prefix,
    }));
  }
}

export class RemoveDhcpServerv6ReservationCmdlet implements ICmdlet {
  readonly name = 'remove-dhcpserverv6reservation';
  readonly displayName = 'Remove-DhcpServerv6Reservation';
  readonly aliases = [] as const;
  readonly parameters = ['Prefix', 'IPAddress'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    const result = v6.removeReservation(text(ctx, 'prefix'), text(ctx, 'ipaddress'));
    return result.ok ? null : fail(ctx, this.displayName, result.message);
  }
}

export class SetDhcpServerv6OptionValueCmdlet implements ICmdlet {
  readonly name = 'set-dhcpserverv6optionvalue';
  readonly displayName = 'Set-DhcpServerv6OptionValue';
  readonly aliases = [] as const;
  readonly parameters = ['Prefix', 'OptionId', 'Value', 'DnsServer', 'DomainSearchList'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    const prefix = text(ctx, 'prefix') || undefined;
    const settings: Array<{ id: number; values: string[] }> = [];
    if (ctx.named['dnsserver'] !== undefined) settings.push({ id: 23, values: list(ctx.named['dnsserver']) });
    if (ctx.named['domainsearchlist'] !== undefined) settings.push({ id: 24, values: list(ctx.named['domainsearchlist']) });
    if (settings.length === 0) {
      const id = ctx.named['optionid'] === undefined ? NaN : Number(text(ctx, 'optionid'));
      if (Number.isNaN(id)) {
        return fail(ctx, this.displayName, 'Cannot process command because of one or more missing mandatory parameters: OptionId.');
      }
      settings.push({ id, values: list(ctx.named['value']) });
    }
    for (const setting of settings) {
      const result = v6.setOptionValue(prefix, setting.id, setting.values);
      if (!result.ok) return fail(ctx, this.displayName, result.message);
    }
    return null;
  }
}

export class GetDhcpServerv6OptionValueCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv6optionvalue';
  readonly displayName = 'Get-DhcpServerv6OptionValue';
  readonly aliases = [] as const;
  readonly parameters = ['Prefix'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    return v6.getOptionValues(text(ctx, 'prefix') || undefined)
      .map(option => ({ OptionId: option.optionId, Name: option.name, Value: option.value }));
  }
}

export class GetDhcpServerv6LeaseCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv6lease';
  readonly displayName = 'Get-DhcpServerv6Lease';
  readonly aliases = [] as const;
  readonly parameters = ['Prefix'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    return v6.getLeases(text(ctx, 'prefix') || undefined).map(lease => ({
      IPAddress: lease.ipAddress, ClientDuid: lease.clientDuid, Iaid: lease.iaid,
      ScopeId: lease.prefix, LeaseExpiryTime: new Date(lease.leaseExpiration),
    }));
  }
}

export class RemoveDhcpServerv6LeaseCmdlet implements ICmdlet {
  readonly name = 'remove-dhcpserverv6lease';
  readonly displayName = 'Remove-DhcpServerv6Lease';
  readonly aliases = [] as const;
  readonly parameters = ['IPAddress'] as const;

  execute(ctx: CmdletContext): PSValue {
    const v6 = requireV6(ctx, this.displayName);
    const address = text(ctx, 'ipaddress');
    if (!address) return fail(ctx, this.displayName, 'Cannot process command because of one or more missing mandatory parameters: IPAddress.');
    const result = v6.removeLease(address);
    return result.ok ? null : fail(ctx, this.displayName, result.message);
  }
}
