/**
 * DhcpServerCmdlets — the `DhcpServer` PowerShell module (PRD-Windows-
 * Server.md §5 P8): Add-DhcpServerv4Scope, Add-DhcpServerv4ExclusionRange,
 * Add-DhcpServerv4Reservation, Set-DhcpServerv4OptionValue, Get-
 * DhcpServerv4Lease, Get-DhcpServerv4Scope, plus `Add-DhcpServerInDC` for
 * the PRD's simulated AD authorization flag.
 *
 * Provider: ctx.providers.dhcp (IDhcpServerProvider), populated only for a
 * `WindowsServer` device with the DHCP role installed — see
 * `WindowsDhcpServerAdapter`.
 *
 * Simplification: real Windows identifies a scope by its network-address
 * `ScopeId` (distinct from the friendly `-Name`) — our façade keys scopes
 * by the single `-Name` given at creation, and every other cmdlet's
 * `-ScopeId` parameter is looked up against that same name.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IDhcpServerProvider, DhcpScopeInfo, DhcpLeaseInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function requireDhcp(ctx: CmdletContext, cmdletName: string): IDhcpServerProvider {
  if (!ctx.providers.dhcp) {
    throw new PSRuntimeError(`${cmdletName} is not recognized as the name of a cmdlet, function, script file, or operable program`);
  }
  return ctx.providers.dhcp;
}

function scopeToPSObject(s: DhcpScopeInfo): Record<string, PSValue> {
  return {
    ScopeId: s.name, Name: s.name, StartRange: s.startRange, EndRange: s.endRange,
    SubnetMask: s.subnetMask, LeaseDuration: s.leaseDuration, State: s.state,
  };
}
function leaseToPSObject(l: DhcpLeaseInfo): Record<string, PSValue> {
  return {
    IPAddress: l.ipAddress, ClientId: l.clientId, ScopeId: l.scopeName,
    LeaseExpiryTime: new Date(l.leaseExpiration).toString(),
    AddressState: l.type === 'manual' ? 'ActiveReservation' : 'Active',
  };
}
function scopeIdOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['scopeid'] ?? ctx.named['name'] ?? '');
}
function valuesOf(ctx: CmdletContext): string[] {
  const raw = ctx.named['value'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)];
}

// ── Scopes ───────────────────────────────────────────────────────────────

export class AddDhcpServerv4ScopeCmdlet implements ICmdlet {
  readonly name = 'add-dhcpserverv4scope';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'StartRange', 'EndRange', 'SubnetMask', 'LeaseDuration', 'State'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Add-DhcpServerv4Scope');
    const name = psValueToString(ctx.named['name'] ?? '');
    const startRange = psValueToString(ctx.named['startrange'] ?? '');
    const endRange = psValueToString(ctx.named['endrange'] ?? '');
    const subnetMask = psValueToString(ctx.named['subnetmask'] ?? '');
    if (!name || !startRange || !endRange || !subnetMask) {
      ctx.emitError('Add-DhcpServerv4Scope : Cannot process command because of one or more missing mandatory parameters: Name StartRange EndRange SubnetMask.');
      return null;
    }
    const leaseDuration = ctx.named['leaseduration'] !== undefined ? Number(psValueToString(ctx.named['leaseduration'])) : undefined;
    const res = dhcp.addScope(name, startRange, endRange, subnetMask, leaseDuration);
    if (!res.ok) { ctx.emitError(`Add-DhcpServerv4Scope : ${res.message}`); return null; }
    return null;
  }
}

export class GetDhcpServerv4ScopeCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv4scope';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Get-DhcpServerv4Scope');
    const scopeId = scopeIdOf(ctx);
    if (scopeId) {
      const s = dhcp.getScope(scopeId);
      if (!s) { ctx.emitError(`Get-DhcpServerv4Scope : The scope, ${scopeId}, does not exist on the DHCP server.`); return null; }
      return scopeToPSObject(s);
    }
    return dhcp.listScopes().map(scopeToPSObject);
  }
}

// ── Exclusions ───────────────────────────────────────────────────────────

export class AddDhcpServerv4ExclusionRangeCmdlet implements ICmdlet {
  readonly name = 'add-dhcpserverv4exclusionrange';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId', 'StartRange', 'EndRange'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Add-DhcpServerv4ExclusionRange');
    const startRange = psValueToString(ctx.named['startrange'] ?? '');
    const endRange = psValueToString(ctx.named['endrange'] ?? '');
    if (!startRange || !endRange) {
      ctx.emitError('Add-DhcpServerv4ExclusionRange : Cannot process command because of one or more missing mandatory parameters: StartRange EndRange.');
      return null;
    }
    const res = dhcp.addExclusionRange(startRange, endRange);
    if (!res.ok) { ctx.emitError(`Add-DhcpServerv4ExclusionRange : ${res.message}`); return null; }
    return null;
  }
}

// ── Reservations ─────────────────────────────────────────────────────────

export class AddDhcpServerv4ReservationCmdlet implements ICmdlet {
  readonly name = 'add-dhcpserverv4reservation';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId', 'IPAddress', 'ClientId', 'Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Add-DhcpServerv4Reservation');
    const scopeId = scopeIdOf(ctx);
    const ip = psValueToString(ctx.named['ipaddress'] ?? '');
    const clientId = psValueToString(ctx.named['clientid'] ?? '');
    if (!scopeId || !ip || !clientId) {
      ctx.emitError('Add-DhcpServerv4Reservation : Cannot process command because of one or more missing mandatory parameters: ScopeId IPAddress ClientId.');
      return null;
    }
    const res = dhcp.addReservation(scopeId, ip, clientId);
    if (!res.ok) { ctx.emitError(`Add-DhcpServerv4Reservation : ${res.message}`); return null; }
    return null;
  }
}

// ── Options ──────────────────────────────────────────────────────────────

export class SetDhcpServerv4OptionValueCmdlet implements ICmdlet {
  readonly name = 'set-dhcpserverv4optionvalue';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId', 'OptionId', 'Value', 'Router', 'DnsServer', 'DnsDomain'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Set-DhcpServerv4OptionValue');
    const scopeId = scopeIdOf(ctx) || undefined;
    const namedOptions: Array<{ id: number; values: string[] }> = [];
    if (ctx.named['router'] !== undefined) {
      const raw = ctx.named['router'];
      namedOptions.push({ id: 3, values: Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)] });
    }
    if (ctx.named['dnsserver'] !== undefined) {
      const raw = ctx.named['dnsserver'];
      namedOptions.push({ id: 6, values: Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)] });
    }
    if (ctx.named['dnsdomain'] !== undefined) {
      namedOptions.push({ id: 15, values: [psValueToString(ctx.named['dnsdomain'])] });
    }
    if (namedOptions.length === 0) {
      const optionId = ctx.named['optionid'] !== undefined ? Number(psValueToString(ctx.named['optionid'])) : NaN;
      if (Number.isNaN(optionId)) {
        ctx.emitError('Set-DhcpServerv4OptionValue : Cannot process command because of one or more missing mandatory parameters: OptionId.');
        return null;
      }
      namedOptions.push({ id: optionId, values: valuesOf(ctx) });
    }
    for (const opt of namedOptions) {
      const res = dhcp.setOptionValue(scopeId, opt.id, opt.values);
      if (!res.ok) { ctx.emitError(`Set-DhcpServerv4OptionValue : ${res.message}`); return null; }
    }
    return null;
  }
}

// ── Leases ───────────────────────────────────────────────────────────────

export class GetDhcpServerv4LeaseCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv4lease';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Get-DhcpServerv4Lease');
    const scopeId = scopeIdOf(ctx);
    return dhcp.getLeases(scopeId || undefined).map(leaseToPSObject);
  }
}

// ── AD authorization (simulated flag) ─────────────────────────────────────

export class AddDhcpServerInDCCmdlet implements ICmdlet {
  readonly name = 'add-dhcpserverindc';
  readonly aliases = [] as const;
  readonly parameters = ['DnsName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Add-DhcpServerInDC');
    const res = dhcp.authorizeInDC();
    if (!res.ok) { ctx.emitError(`Add-DhcpServerInDC : ${res.message}`); return null; }
    return null;
  }
}

export class SetDhcpServerv4ScopeCmdlet implements ICmdlet {
  readonly name = 'set-dhcpserverv4scope';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId', 'Name', 'LeaseDuration', 'State'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Set-DhcpServerv4Scope');
    const scopeId = psValueToString(ctx.named['scopeid'] ?? '');
    if (!scopeId) {
      ctx.emitError('Set-DhcpServerv4Scope : Cannot process command because of one or more missing mandatory parameters: ScopeId.');
      return null;
    }
    const changes: { newName?: string; leaseDuration?: number; state?: 'Active' | 'Inactive' } = {};
    if (ctx.named['name'] !== undefined) changes.newName = psValueToString(ctx.named['name']);
    if (ctx.named['leaseduration'] !== undefined) {
      changes.leaseDuration = Number(psValueToString(ctx.named['leaseduration']));
    }
    if (ctx.named['state'] !== undefined) {
      const state = psValueToString(ctx.named['state']);
      if (state !== 'Active' && state !== 'Inactive') {
        ctx.emitError(`Set-DhcpServerv4Scope : Cannot validate argument on parameter 'State'. The argument "${state}" does not belong to the set "Active,Inactive".`);
        return null;
      }
      changes.state = state;
    }
    const res = dhcp.setScope(scopeId, changes);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class RemoveDhcpServerv4ScopeCmdlet implements ICmdlet {
  readonly name = 'remove-dhcpserverv4scope';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId', 'Force'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Remove-DhcpServerv4Scope');
    const res = dhcp.removeScope(scopeIdOf(ctx));
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class GetDhcpServerv4ReservationCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv4reservation';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId', 'IPAddress'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Get-DhcpServerv4Reservation');
    const scopeId = scopeIdOf(ctx);
    const wanted = psValueToString(ctx.named['ipaddress'] ?? '');
    return dhcp.listReservations(scopeId || undefined)
      .filter(r => !wanted || r.ipAddress === wanted)
      .map(r => ({
        ScopeId: r.scopeName, IPAddress: r.ipAddress,
        ClientId: r.clientId.replace(/:/g, '-'), AddressState: 'ActiveReservation',
      }));
  }
}

export class RemoveDhcpServerv4ReservationCmdlet implements ICmdlet {
  readonly name = 'remove-dhcpserverv4reservation';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId', 'IPAddress'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Remove-DhcpServerv4Reservation');
    const res = dhcp.removeReservation(scopeIdOf(ctx), psValueToString(ctx.named['ipaddress'] ?? ''));
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class GetDhcpServerv4ExclusionRangeCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv4exclusionrange';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Get-DhcpServerv4ExclusionRange');
    const scopeId = scopeIdOf(ctx);
    return dhcp.listExclusionRanges().map(r => ({
      ScopeId: scopeId, StartRange: r.start, EndRange: r.end,
    }));
  }
}

export class RemoveDhcpServerv4ExclusionRangeCmdlet implements ICmdlet {
  readonly name = 'remove-dhcpserverv4exclusionrange';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId', 'StartRange', 'EndRange'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Remove-DhcpServerv4ExclusionRange');
    const res = dhcp.removeExclusionRange(
      psValueToString(ctx.named['startrange'] ?? ''),
      psValueToString(ctx.named['endrange'] ?? ''));
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class GetDhcpServerv4OptionValueCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv4optionvalue';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId', 'OptionId'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Get-DhcpServerv4OptionValue');
    const scopeId = scopeIdOf(ctx);
    const wanted = ctx.named['optionid'] !== undefined
      ? Number(psValueToString(ctx.named['optionid'])) : null;
    return dhcp.listOptionValues(scopeId || undefined)
      .filter(o => wanted === null || o.optionId === wanted)
      .map(o => ({
        ScopeId: scopeId, OptionId: o.optionId, Name: o.name, Value: o.values.join(', '),
      }));
  }
}

export class RemoveDhcpServerv4OptionValueCmdlet implements ICmdlet {
  readonly name = 'remove-dhcpserverv4optionvalue';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId', 'OptionId'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Remove-DhcpServerv4OptionValue');
    const scopeId = scopeIdOf(ctx);
    const optionId = Number(psValueToString(ctx.named['optionid'] ?? ''));
    if (!Number.isFinite(optionId)) {
      ctx.emitError('Remove-DhcpServerv4OptionValue : Cannot process command because of one or more missing mandatory parameters: OptionId.');
      return null;
    }
    const res = dhcp.removeOptionValue(scopeId || undefined, optionId);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class RemoveDhcpServerv4LeaseCmdlet implements ICmdlet {
  readonly name = 'remove-dhcpserverv4lease';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId', 'IPAddress'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Remove-DhcpServerv4Lease');
    const res = dhcp.removeLease(psValueToString(ctx.named['ipaddress'] ?? ''));
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class GetDhcpServerv4ScopeStatisticsCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv4scopestatistics';
  readonly aliases = [] as const;
  readonly parameters = ['ScopeId'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Get-DhcpServerv4ScopeStatistics');
    const scopeId = scopeIdOf(ctx);
    const noms = scopeId ? [scopeId] : dhcp.listScopes().map(s => s.name);
    const out: Record<string, PSValue>[] = [];
    for (const nom of noms) {
      const stats = dhcp.scopeStatistics(nom);
      if (!stats) continue;
      out.push({
        ScopeId: nom, Free: stats.free, InUse: stats.inUse,
        PercentageInUse: stats.percentInUse, AddressesInUse: stats.inUse,
        AddressesFree: stats.free, Reserved: 0, Pending: 0, Total: stats.total,
      });
    }
    return out;
  }
}

export class GetDhcpServerv4StatisticsCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverv4statistics';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Get-DhcpServerv4Statistics');
    const stats = dhcp.serverStatistics();
    return {
      Scopes: stats.scopes, TotalScopes: stats.scopes,
      TotalAddresses: stats.totalAddresses,
      AddressesInUse: stats.inUse, AddressesAvailable: stats.free,
      PercentageInUse: stats.totalAddresses === 0
        ? 0 : Math.round((stats.inUse / stats.totalAddresses) * 100),
    };
  }
}

export class GetDhcpServerInDCCmdlet implements ICmdlet {
  readonly name = 'get-dhcpserverindc';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Get-DhcpServerInDC');
    if (!dhcp.isRegisteredInDC()) return [];
    return [{ IPAddress: dhcp.serverAddress(), DnsName: dhcp.serverName() }];
  }
}

export class RemoveDhcpServerInDCCmdlet implements ICmdlet {
  readonly name = 'remove-dhcpserverindc';
  readonly aliases = [] as const;
  readonly parameters = ['DnsName', 'IPAddress'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dhcp = requireDhcp(ctx, 'Remove-DhcpServerInDC');
    const res = dhcp.revokeInDC();
    if (!res.ok) { ctx.emitError(`Remove-DhcpServerInDC : ${res.message}`); return null; }
    return null;
  }
}
