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
    SubnetMask: s.subnetMask, LeaseDuration: s.leaseDuration, State: 'Active',
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
    const scopeId = scopeIdOf(ctx);
    if (!scopeId) {
      ctx.emitError('Set-DhcpServerv4OptionValue : Cannot process command because of one or more missing mandatory parameters: ScopeId.');
      return null;
    }
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
