import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** `show running-config` (Cisco Catalyst) — vue minimale MachineApi. */
export class CiscoSwitchShowRunningConfigCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'running-config', summary: 'Display the running configuration',
    usage: 'show running-config',
    args: [], options: [], privileges: ANY, category: 'switch',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const lines: string[] = ['Building configuration...', '', '!'];
    lines.push(`hostname ${machine.hostname}`);
    lines.push('!');
    for (const v of machine.switch.vlans()) {
      if (v.id === 1) continue;
      lines.push(`vlan ${v.id}`);
      lines.push(` name ${v.name}`);
      lines.push('!');
    }
    for (const iface of machine.switch.interfaces()) {
      lines.push(`interface ${iface.name}`);
      if (iface.description) lines.push(` description ${iface.description}`);
      if (iface.mode === 'access') lines.push(' switchport mode access');
      else if (iface.mode === 'trunk') lines.push(' switchport mode trunk');
      if (iface.mode === 'access' && iface.accessVlan !== 1) lines.push(` switchport access vlan ${iface.accessVlan}`);
      if (iface.portSecurity.enabled) {
        lines.push(' switchport port-security');
        if (iface.portSecurity.maxMac !== 1) lines.push(` switchport port-security maximum ${iface.portSecurity.maxMac}`);
        if (iface.portSecurity.violationMode !== 'shutdown') lines.push(` switchport port-security violation ${iface.portSecurity.violationMode}`);
        if (iface.portSecurity.sticky) lines.push(' switchport port-security mac-address sticky');
      }
      if (iface.voiceVlan !== undefined) lines.push(` switchport voice vlan ${iface.voiceVlan}`);
      if (iface.lacpGroupId !== undefined) lines.push(` channel-group ${iface.lacpGroupId} mode on`);
      lines.push(iface.adminUp ? ' no shutdown' : ' shutdown');
      lines.push('!');
    }
    lines.push('end');
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
