import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

export class HuaweiSwitchDisplayCurrentConfigurationCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'current-configuration',
    summary: 'Display the running configuration',
    usage: 'display current-configuration',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const lines: string[] = ['#', `sysname ${machine.hostname}`, '#'];

    for (const v of machine.switch.vlans()) {
      lines.push(`vlan ${v.id}`);
      const defaultName = `VLAN${String(v.id).padStart(4, '0')}`;
      if (v.name && v.name !== defaultName && v.name !== 'default') {
        lines.push(` name ${v.name}`);
      }
      lines.push('#');
    }

    for (const info of machine.switch.interfaces()) {
      lines.push(`interface ${info.name}`);
      if (info.description) lines.push(` description ${info.description}`);
      if (info.mode === 'access') {
        lines.push(' port link-type access');
        if (info.accessVlan !== 1) lines.push(` port default vlan ${info.accessVlan}`);
      } else if (info.mode === 'trunk') {
        lines.push(' port link-type trunk');
        if (info.trunkAllowedVlans.length) {
          lines.push(` port trunk allow-pass vlan ${info.trunkAllowedVlans.join(' ')}`);
        }
        if (info.trunkNativeVlan !== 1) lines.push(` port trunk pvid vlan ${info.trunkNativeVlan}`);
      }
      if (!info.adminUp) lines.push(' shutdown');
      lines.push('#');
    }
    lines.push('return');

    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
