import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

function maskToCidr(mask: string): number {
  const parts = mask.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, o) => acc + o.toString(2).split('1').length - 1, 0);
}

/**
 * `show interfaces [name]` (Cisco IOS routeur) — feuille standalone.
 * Facultatif : nom d'interface pour filtrer.
 */
export class CiscoRouterShowInterfacesCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'interfaces', summary: 'Display interface state', usage: 'show interfaces [name]',
    args: [{ name: 'name', type: 'string', required: false, description: 'Interface name (optional)' }],
    options: [], privileges: ANY, category: 'router',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const name = ctx.args.get<string | undefined>('name');
    const targets = name
      ? [machine.router.interface(name)].filter((i) => i !== null) as ReturnType<typeof machine.router.interfaces>
      : machine.router.interfaces();
    if (name && targets.length === 0) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    const lines: string[] = [];
    for (const iface of targets) {
      const admin = iface.adminUp ? 'up' : 'administratively down';
      const proto = iface.linkUp ? 'up' : 'down';
      lines.push(`${iface.name} is ${admin}, line protocol is ${proto}`);
      lines.push(`  Hardware is Ethernet, address is ${iface.mac}`);
      if (iface.description) lines.push(`  Description: ${iface.description}`);
      if (iface.ip) lines.push(`  Internet address is ${iface.ip}/${maskToCidr(iface.mask)}`);
      lines.push(`  MTU ${iface.mtu} bytes`);
    }
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
