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
import type { INpsProvider, NasClientInfo, NetworkPolicyInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function requireNps(ctx: CmdletContext, cmdletName: string): INpsProvider {
  if (!ctx.providers.nps) {
    throw new PSRuntimeError(`${cmdletName} is not recognized as the name of a cmdlet, function, script file, or operable program`);
  }
  return ctx.providers.nps;
}

function nasClientToPSObject(c: NasClientInfo): Record<string, PSValue> {
  return { Name: c.name, Address: c.ipAddress };
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
  readonly parameters = ['Name', 'Address', 'SharedSecret'] as const;

  execute(ctx: CmdletContext): PSValue {
    const nps = requireNps(ctx, 'New-NpsRadiusClient');
    const name = nameOf(ctx);
    const address = psValueToString(ctx.named['address'] ?? '');
    const secret = psValueToString(ctx.named['sharedsecret'] ?? '');
    if (!name || !address || !secret) {
      ctx.emitError('New-NpsRadiusClient : Cannot process command because of one or more missing mandatory parameters: Name Address SharedSecret.');
      return null;
    }
    const res = nps.addNasClient(name, address, secret);
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
