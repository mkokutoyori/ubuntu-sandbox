import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo arp <ip>` (Huawei VRP, system-view) — feuille standalone.
 * Retire l'entrée ARP (dynamique OU statique) pour l'IP donnée via
 * `RouterMachineApi.router.removeArp`. VRP accepte aussi la forme
 * `undo arp static <ip>` — même dispatch (le mot `static` est un
 * marqueur, l'implémentation ne dépend pas du type).
 */
export class HuaweiRouterUndoArpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'arp',
    summary: 'Remove an ARP entry (dynamic or static)',
    usage: 'undo arp [static] <ip>',
    args: [
      { name: 'ip', type: 'string', required: true, description: 'IPv4 address or literal `static`' },
      { name: 'ipIfStatic', type: 'string', required: false, description: 'IPv4 address when preceded by `static`' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const first = ctx.args.get<string>('ip');
    const second = ctx.args.get<string | undefined>('ipIfStatic');
    const ip = first === 'static' && second ? second : first;
    if (!machine.router.removeArp(ip)) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
