import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `show running-config` (Cisco IOS routeur) — vue minimale mais utile
 * de la configuration courante depuis les seules données exposées par
 * la MachineApi (hostname, interfaces + IP/desc/admin/encap, routes
 * statiques).
 */
export class CiscoRouterShowRunningConfigCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'running-config', summary: 'Display the running configuration',
    usage: 'show running-config',
    args: [], options: [], privileges: ANY, category: 'router',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const lines: string[] = ['Building configuration...', '', '!'];
    lines.push(`hostname ${machine.hostname}`);
    lines.push('!');
    for (const iface of machine.router.interfaces()) {
      lines.push(`interface ${iface.name}`);
      if (iface.description) lines.push(` description ${iface.description}`);
      if (iface.encapsulation?.type === 'dot1q' && iface.encapsulation.vlan !== undefined) {
        const nat = iface.encapsulation.native ? ' native' : '';
        lines.push(` encapsulation dot1Q ${iface.encapsulation.vlan}${nat}`);
      }
      if (iface.ip) lines.push(` ip address ${iface.ip} ${iface.mask}`);
      else lines.push(' no ip address');
      lines.push(iface.adminUp ? ' no shutdown' : ' shutdown');
      lines.push('!');
    }
    for (const route of machine.router.routes()) {
      if (route.type === 'static' && route.nextHop) {
        lines.push(`ip route ${route.network} ${route.mask} ${route.nextHop}`);
      }
    }
    lines.push('!', 'end');
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
