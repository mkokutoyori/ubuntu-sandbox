import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `ip route <net> <mask> <nexthop>` (Cisco IOS, mode config) — commande
 * FEUILLE standalone. Ajoute une route statique via
 * `RouterMachineApi.router.addStaticRoute`. Silence en cas de succès,
 * message vendeur exact (`% Invalid input detected at '^' marker.`)
 * pour toute erreur de valeur ou table pleine.
 */
export class CiscoRouterIpRouteCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'route',
    summary: 'Establish static routes',
    usage: 'ip route <A.B.C.D> <M.M.M.M> <next-hop>',
    args: [
      { name: 'network', type: 'string', required: true, description: 'Destination prefix' },
      { name: 'mask',    type: 'string', required: true, description: 'Destination prefix mask' },
      { name: 'nextHop', type: 'string', required: true, description: 'Next hop address' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const result = machine.router.addStaticRoute(
      ctx.args.get<string>('network'),
      ctx.args.get<string>('mask'),
      ctx.args.get<string>('nextHop'),
    );
    if (!result.ok) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
