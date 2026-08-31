import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type {
  INetworkProvider, NicTeamInfo, NicTeamMemberInfo,
} from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function requireTeaming(ctx: CmdletContext): INetworkProvider {
  const net = ctx.providers.network;
  if (!net || !net.getNicTeams) {
    throw new PSRuntimeError('The term \'NetLbfo\' is not recognized as the name of a cmdlet on this system');
  }
  return net;
}

function names(value: PSValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(psValueToString);
}

function matchesPattern(candidate: string, pattern: string): boolean {
  const rx = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$', 'i');
  return rx.test(candidate);
}

function teamToPSObject(t: NicTeamInfo): Record<string, PSValue> {
  return {
    Name: t.name,
    Members: t.members as unknown as PSValue,
    TeamNics: t.teamNics as unknown as PSValue,
    TeamingMode: t.teamingMode,
    LoadBalancingAlgorithm: t.loadBalancingAlgorithm,
    LacpTimer: t.lacpTimer,
    Status: t.status,
  };
}

function memberToPSObject(m: NicTeamMemberInfo): Record<string, PSValue> {
  return {
    Name: m.name,
    InterfaceDescription: m.interfaceDescription,
    Team: m.team,
    AdministrativeMode: m.administrativeMode,
    OperationalStatus: m.operationalStatus,
    TransmitLinkSpeed: m.transmitLinkSpeed,
    ReceiveLinkSpeed: m.receiveLinkSpeed,
    FailureReason: m.failureReason,
  };
}

export class GetNetLbfoTeamCmdlet implements ICmdlet {
  readonly name = 'get-netlbfoteam';
  readonly displayName = 'Get-NetLbfoTeam';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireTeaming(ctx);
    const teams = net.getNicTeams!();
    const demandes = names(ctx.named['name'] ?? ctx.positional[0]);
    if (demandes.length === 0) return teams.map(teamToPSObject) as PSValue;
    const out: NicTeamInfo[] = [];
    for (const n of demandes) {
      const trouves = teams.filter(t => matchesPattern(t.name, n));
      if (trouves.length === 0) ctx.emitError(`No MSFT_NetLbfoTeam objects found with property 'Name' equal to '${n}'.`);
      out.push(...trouves);
    }
    return out.map(teamToPSObject) as PSValue;
  }
}

export class NewNetLbfoTeamCmdlet implements ICmdlet {
  readonly name = 'new-netlbfoteam';
  readonly displayName = 'New-NetLbfoTeam';
  readonly aliases = [] as const;
  readonly parameters = [
    'Name', 'TeamMembers', 'TeamNicName', 'TeamingMode',
    'LoadBalancingAlgorithm', 'LacpTimer', 'Confirm',
  ] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireTeaming(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const membres = names(ctx.named['teammembers'] ?? ctx.positional[1]);
    if (!name || membres.length === 0) {
      throw new PSRuntimeError('Cannot process command because of one or more missing mandatory parameters: Name TeamMembers.');
    }
    const erreur = net.newNicTeam!({
      name,
      teamMembers: membres,
      teamNicName: ctx.named['teamnicname'] !== undefined
        ? psValueToString(ctx.named['teamnicname']) : undefined,
      teamingMode: ctx.named['teamingmode'] !== undefined
        ? psValueToString(ctx.named['teamingmode']) : undefined,
      loadBalancingAlgorithm: ctx.named['loadbalancingalgorithm'] !== undefined
        ? psValueToString(ctx.named['loadbalancingalgorithm']) : undefined,
      lacpTimer: ctx.named['lacptimer'] !== undefined
        ? psValueToString(ctx.named['lacptimer']) : undefined,
    });
    if (erreur) { ctx.emitError(erreur); return null; }
    return net.getNicTeams!().filter(t => t.name === name).map(teamToPSObject) as PSValue;
  }
}

export class SetNetLbfoTeamCmdlet implements ICmdlet {
  readonly name = 'set-netlbfoteam';
  readonly displayName = 'Set-NetLbfoTeam';
  readonly aliases = [] as const;
  readonly parameters = [
    'Name', 'TeamingMode', 'LoadBalancingAlgorithm', 'LacpTimer', 'Confirm',
  ] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireTeaming(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const erreur = net.setNicTeam!(name, {
      teamingMode: ctx.named['teamingmode'] !== undefined
        ? psValueToString(ctx.named['teamingmode']) : undefined,
      loadBalancingAlgorithm: ctx.named['loadbalancingalgorithm'] !== undefined
        ? psValueToString(ctx.named['loadbalancingalgorithm']) : undefined,
      lacpTimer: ctx.named['lacptimer'] !== undefined
        ? psValueToString(ctx.named['lacptimer']) : undefined,
    });
    if (erreur) ctx.emitError(erreur);
    return null;
  }
}

export class RemoveNetLbfoTeamCmdlet implements ICmdlet {
  readonly name = 'remove-netlbfoteam';
  readonly displayName = 'Remove-NetLbfoTeam';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireTeaming(ctx);
    const demandes = names(ctx.named['name'] ?? ctx.positional[0]);
    const pipeline = Array.isArray(ctx.pipeInput) ? ctx.pipeInput
      : (ctx.pipeInput === null || ctx.pipeInput === undefined ? [] : [ctx.pipeInput]);
    for (const entree of pipeline) {
      const nom = (entree as Record<string, PSValue> | null)?.['Name'];
      if (nom !== undefined && nom !== null) demandes.push(psValueToString(nom));
    }
    for (const n of demandes) {
      const erreur = net.removeNicTeam!(n);
      if (erreur) ctx.emitError(erreur);
    }
    return null;
  }
}

export class GetNetLbfoTeamMemberCmdlet implements ICmdlet {
  readonly name = 'get-netlbfoteammember';
  readonly displayName = 'Get-NetLbfoTeamMember';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Team'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireTeaming(ctx);
    const team = ctx.named['team'] !== undefined
      ? psValueToString(ctx.named['team']) : undefined;
    let membres = net.getNicTeamMembers!(team);
    const demandes = names(ctx.named['name'] ?? ctx.positional[0]);
    if (demandes.length > 0) {
      membres = membres.filter(m => demandes.some(n => matchesPattern(m.name, n)));
    }
    return membres.map(memberToPSObject) as PSValue;
  }
}

export class GetNetLbfoTeamNicCmdlet implements ICmdlet {
  readonly name = 'get-netlbfoteamnic';
  readonly displayName = 'Get-NetLbfoTeamNic';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Team'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireTeaming(ctx);
    if (!net.getNicTeamNics) return [] as unknown as PSValue;
    const team = ctx.named['team'] !== undefined
      ? psValueToString(ctx.named['team']) : undefined;
    let nics = net.getNicTeamNics(team);
    const demandes = names(ctx.named['name'] ?? ctx.positional[0]);
    if (demandes.length > 0) {
      nics = nics.filter(n => demandes.some(d => matchesPattern(n.name, d)));
    }
    return nics.map(n => ({
      Name: n.name,
      Team: n.team,
      VlanID: n.vlanId,
      Primary: n.primary,
      Default: n.isDefault,
    })) as PSValue;
  }
}

export class AddNetLbfoTeamMemberCmdlet implements ICmdlet {
  readonly name = 'add-netlbfoteammember';
  readonly displayName = 'Add-NetLbfoTeamMember';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Team', 'AdministrativeMode', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireTeaming(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const team = psValueToString(ctx.named['team'] ?? ctx.positional[1] ?? '');
    const mode = ctx.named['administrativemode'] ?? ctx.named['am'];
    const erreur = net.addNicTeamMember!(team, name,
      mode !== undefined ? psValueToString(mode) : undefined);
    if (erreur) ctx.emitError(erreur);
    return null;
  }
}

export class SetNetLbfoTeamMemberCmdlet implements ICmdlet {
  readonly name = 'set-netlbfoteammember';
  readonly displayName = 'Set-NetLbfoTeamMember';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'AdministrativeMode', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireTeaming(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const mode = ctx.named['administrativemode'] ?? ctx.named['am'] ?? ctx.positional[1];
    if (mode === undefined) {
      throw new PSRuntimeError('Cannot process command because of one or more missing mandatory parameters: AdministrativeMode.');
    }
    const erreur = net.setNicTeamMember!(name, psValueToString(mode));
    if (erreur) ctx.emitError(erreur);
    return null;
  }
}

export class RemoveNetLbfoTeamMemberCmdlet implements ICmdlet {
  readonly name = 'remove-netlbfoteammember';
  readonly displayName = 'Remove-NetLbfoTeamMember';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Team', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireTeaming(ctx);
    for (const n of names(ctx.named['name'] ?? ctx.positional[0])) {
      const erreur = net.removeNicTeamMember!(n);
      if (erreur) ctx.emitError(erreur);
    }
    return null;
  }
}
