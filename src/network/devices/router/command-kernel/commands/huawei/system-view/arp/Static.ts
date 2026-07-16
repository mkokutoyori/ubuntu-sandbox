import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `arp static <ip> <mac>` (Huawei VRP, system-view) — feuille standalone.
 * Pose une entrée ARP statique via
 * `RouterMachineApi.router.addStaticArp`. Silence en cas de succès ;
 * message vendeur exact pour toute erreur de valeur.
 */
export class HuaweiRouterArpStaticCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'static',
    summary: 'Add a static ARP entry',
    usage: 'arp static <ip> <mac>',
    args: [
      { name: 'ip', type: 'string', required: true, description: 'IPv4 address' },
      { name: 'mac', type: 'string', required: true, description: 'MAC address' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const ip = ctx.args.get<string>('ip');
    const mac = ctx.args.get<string>('mac');
    const result = machine.router.addStaticArp(ip, mac);
    if (!result.ok) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
