import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi, RouterInterfaceInfo } from '../../../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

const VIRTUAL_IF = /^(Tunnel|Loopback|Vlan|BVI|Bundle-Ether|Port-channel)/i;

function statusFor(info: RouterInterfaceInfo): { status: string; proto: string } {
  if (!info.adminUp) return { status: 'administratively down', proto: 'down' };
  if (VIRTUAL_IF.test(info.name)) return { status: 'up', proto: 'up' };
  if (info.linkUp) return { status: 'up', proto: 'up' };
  return { status: 'down', proto: 'down' };
}

/**
 * `show ip interface brief` (Cisco IOS routeur) — commande FEUILLE
 * standalone. Lit UNIQUEMENT `RouterMachineApi.router.interfaces()` et
 * produit elle-même la mise en forme tabulaire vendeur (largeurs de
 * colonnes IOS : 27/16/4/7/22/proto).
 */
export class CiscoRouterShowIpInterfaceBriefCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'brief',
    summary: 'Brief summary of interface status and configuration',
    usage: 'show ip interface brief',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const lines = [
      'Interface                  IP-Address      OK? Method Status                Protocol',
    ];
    for (const info of machine.router.interfaces()) {
      const ip = info.ip === '' ? 'unassigned' : info.ip;
      const { status, proto } = statusFor(info);
      lines.push(
        `${info.name.padEnd(27)}${ip.padEnd(16)}YES manual ${status.padEnd(22)}${proto}`,
      );
    }
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
