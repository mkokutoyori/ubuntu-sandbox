/**
 * NpsCmdlets — the NPS (RADIUS) PowerShell surface (PRD-Windows-Server.md
 * §5 P9): `New-NpsRadiusClient`/`Get-NpsRadiusClient`/`Remove-
 * NpsRadiusClient` for NAS clients (shared secret), and `New-
 * NpsNetworkPolicy`/`Get-NpsNetworkPolicy`/`Remove-NpsNetworkPolicy` for
 * the simple group-condition → VLAN/Session-Timeout policies.
 *
 * Provider: ctx.providers.nps (INpsProvider), populated only for a
 * `WindowsServer` device with the NPAS role installed — see
 * `WindowsNpsAdapter`.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type {
  INpsProvider, NasClientInfo, NetworkPolicyInfo, ConnectionRequestPolicyInfo,
} from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireNps(ctx: CmdletContext, cmdletName: string): INpsProvider {
  if (!ctx.providers.nps) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.nps;
}

function nasClientToPSObject(c: NasClientInfo): Record<string, PSValue> {
  return { Name: c.name, Address: c.ipAddress, NasType: c.nasType ?? '' };
}
function crpToPSObject(p: ConnectionRequestPolicyInfo): Record<string, PSValue> {
  return {
    PolicyName: p.name,
    UserGroups: p.conditions.group ?? '',
    NasType: p.conditions.nasType ?? '',
    ClientIpAddress: p.conditions.clientIpAddress ?? '',
    Days: p.conditions.daysAndTimes ? p.conditions.daysAndTimes.days.join(',') : '',
    StartHour: p.conditions.daysAndTimes?.startHour ?? '',
    EndHour: p.conditions.daysAndTimes?.endHour ?? '',
  };
}
function policyToPSObject(p: NetworkPolicyInfo): Record<string, PSValue> {
  return {
    PolicyName: p.name, Condition: p.group,
    VlanId: p.vlanId ?? '', SessionTimeout: p.sessionTimeoutSec ?? '',
  };
}
function nameOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
}

// ── NAS clients (New/Get/Remove-NpsRadiusClient) ─────────────────────────

export class NewNpsRadiusClientCmdlet implements ICmdlet {
  readonly name = 'new-npsradiusclient';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Address', 'SharedSecret', 'NasType'] as const;

  execute(ctx: CmdletContext): PSValue {
    const nps = requireNps(ctx, 'New-NpsRadiusClient');
    const name = nameOf(ctx);
    const address = psValueToString(ctx.named['address'] ?? '');
    const secret = psValueToString(ctx.named['sharedsecret'] ?? '');
    const nasType = ctx.named['nastype'] !== undefined ? psValueToString(ctx.named['nastype']) : undefined;
    if (!name || !address || !secret) {
      ctx.emitError('New-NpsRadiusClient : Cannot process command because of one or more missing mandatory parameters: Name Address SharedSecret.');
      return null;
    }
    const res = nps.addNasClient(name, address, secret, nasType);
    if (!res.ok) { ctx.emitError(`New-NpsRadiusClient : ${res.message}`); return null; }
    return null;
  }
}

export class GetNpsRadiusClientCmdlet implements ICmdlet {
  readonly name = 'get-npsradiusclient';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const nps = requireNps(ctx, 'Get-NpsRadiusClient');
    const name = nameOf(ctx);
    if (name) {
      const c = nps.getNasClient(name);
      if (!c) { ctx.emitError(`Get-NpsRadiusClient : A RADIUS client named "${name}" does not exist.`); return null; }
      return nasClientToPSObject(c);
    }
    return nps.listNasClients().map(nasClientToPSObject);
  }
}

export class RemoveNpsRadiusClientCmdlet implements ICmdlet {
  readonly name = 'remove-npsradiusclient';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const nps = requireNps(ctx, 'Remove-NpsRadiusClient');
    const name = nameOf(ctx);
    const res = nps.removeNasClient(name);
    if (!res.ok) { ctx.emitError(`Remove-NpsRadiusClient : ${res.message}`); return null; }
    return null;
  }
}

// ── Network policies (New/Get/Remove-NpsNetworkPolicy) ───────────────────

export class NewNpsNetworkPolicyCmdlet implements ICmdlet {
  readonly name = 'new-npsnetworkpolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Group', 'VlanId', 'SessionTimeout'] as const;

  execute(ctx: CmdletContext): PSValue {
    const nps = requireNps(ctx, 'New-NpsNetworkPolicy');
    const name = nameOf(ctx);
    const group = psValueToString(ctx.named['group'] ?? '');
    if (!name || !group) {
      ctx.emitError('New-NpsNetworkPolicy : Cannot process command because of one or more missing mandatory parameters: Name Group.');
      return null;
    }
    const vlanId = ctx.named['vlanid'] !== undefined ? Number(psValueToString(ctx.named['vlanid'])) : undefined;
    const sessionTimeoutSec = ctx.named['sessiontimeout'] !== undefined ? Number(psValueToString(ctx.named['sessiontimeout'])) : undefined;
    const res = nps.addNetworkPolicy(name, group, vlanId, sessionTimeoutSec);
    if (!res.ok) { ctx.emitError(`New-NpsNetworkPolicy : ${res.message}`); return null; }
    return null;
  }
}

export class GetNpsNetworkPolicyCmdlet implements ICmdlet {
  readonly name = 'get-npsnetworkpolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const nps = requireNps(ctx, 'Get-NpsNetworkPolicy');
    const name = nameOf(ctx);
    const all = nps.listNetworkPolicies();
    const filtered = name ? all.filter(p => p.name === name) : all;
    return filtered.map(policyToPSObject);
  }
}

export class RemoveNpsNetworkPolicyCmdlet implements ICmdlet {
  readonly name = 'remove-npsnetworkpolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const nps = requireNps(ctx, 'Remove-NpsNetworkPolicy');
    const name = nameOf(ctx);
    const res = nps.removeNetworkPolicy(name);
    if (!res.ok) { ctx.emitError(`Remove-NpsNetworkPolicy : ${res.message}`); return null; }
    return null;
  }
}

// ── Connection request policies (PRD-Windows-Server-Advanced.md §5 P22) ─────
// Simplification (documented per PRD §2.2): real NPS's `-DayAndTime`
// condition is a full weekly schedule grid; this simulator takes a
// simpler `-Days` (comma-separated `Date.getDay()` numbers, 0=Sunday) +
// `-StartHour`/`-EndHour` window instead.

function parseDays(raw: string): number[] {
  return raw.split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n));
}

export class NewNpsConnectionRequestPolicyCmdlet implements ICmdlet {
  readonly name = 'new-npsconnectionrequestpolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'UserGroups', 'NasType', 'ClientIpAddress', 'Days', 'StartHour', 'EndHour'] as const;
  readonly displayName = 'New-NpsConnectionRequestPolicy';

  execute(ctx: CmdletContext): PSValue {
    const nps = requireNps(ctx, 'New-NpsConnectionRequestPolicy');
    const name = nameOf(ctx);
    if (!name) {
      ctx.emitError('New-NpsConnectionRequestPolicy : Cannot process command because of one or more missing mandatory parameters: Name.');
      return null;
    }
    const group = ctx.named['usergroups'] !== undefined ? psValueToString(ctx.named['usergroups']) : undefined;
    const nasType = ctx.named['nastype'] !== undefined ? psValueToString(ctx.named['nastype']) : undefined;
    const clientIpAddress = ctx.named['clientipaddress'] !== undefined ? psValueToString(ctx.named['clientipaddress']) : undefined;
    const daysRaw = ctx.named['days'] !== undefined ? psValueToString(ctx.named['days']) : undefined;
    const startHour = ctx.named['starthour'] !== undefined ? Number(psValueToString(ctx.named['starthour'])) : undefined;
    const endHour = ctx.named['endhour'] !== undefined ? Number(psValueToString(ctx.named['endhour'])) : undefined;
    const daysAndTimes = daysRaw !== undefined && startHour !== undefined && endHour !== undefined
      ? { days: parseDays(daysRaw), startHour, endHour } : undefined;

    const res = nps.addConnectionRequestPolicy(name, { group, nasType, clientIpAddress, daysAndTimes });
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

export class GetNpsConnectionRequestPolicyCmdlet implements ICmdlet {
  readonly name = 'get-npsconnectionrequestpolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;
  readonly displayName = 'Get-NpsConnectionRequestPolicy';

  execute(ctx: CmdletContext): PSValue {
    const nps = requireNps(ctx, 'Get-NpsConnectionRequestPolicy');
    const name = nameOf(ctx);
    const all = nps.listConnectionRequestPolicies();
    const filtered = name ? all.filter(p => p.name === name) : all;
    return filtered.map(crpToPSObject);
  }
}

export class RemoveNpsConnectionRequestPolicyCmdlet implements ICmdlet {
  readonly name = 'remove-npsconnectionrequestpolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;
  readonly displayName = 'Remove-NpsConnectionRequestPolicy';

  execute(ctx: CmdletContext): PSValue {
    const nps = requireNps(ctx, 'Remove-NpsConnectionRequestPolicy');
    const name = nameOf(ctx);
    const res = nps.removeConnectionRequestPolicy(name);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── SQL accounting (PRD-Windows-Server-Advanced.md §5 P22) ──────────────────

export class SetNpsAccountingConfigurationCmdlet implements ICmdlet {
  readonly name = 'set-npsaccountingconfiguration';
  readonly aliases = [] as const;
  readonly parameters = ['SqlLogging'] as const;
  readonly displayName = 'Set-NpsAccountingConfiguration';

  execute(ctx: CmdletContext): PSValue {
    const nps = requireNps(ctx, 'Set-NpsAccountingConfiguration');
    const raw = ctx.named['sqllogging'];
    const enabled = raw === undefined ? true : psValueToString(raw).toLowerCase() !== 'false' && raw !== false;
    const res = nps.setSqlAccounting(enabled);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}
