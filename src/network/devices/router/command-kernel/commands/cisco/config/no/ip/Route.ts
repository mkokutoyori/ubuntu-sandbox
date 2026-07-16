import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `no ip route <net> <mask> [<nexthop>]` (Cisco IOS, mode config) —
 * commande FEUILLE standalone. Retire une route statique via
 * `RouterMachineApi.router.removeStaticRoute`. Le next-hop est
 * optionnel : sans lui, toutes les routes statiques (net, mask)
 * sont retirées.
 */
export class CiscoRouterNoIpRouteCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'route',
    summary: 'Remove a static route',
    usage: 'no ip route <A.B.C.D> <M.M.M.M> [<next-hop>]',
    args: [
      { name: 'network', type: 'string', required: true, description: 'Destination prefix' },
      { name: 'mask',    type: 'string', required: true, description: 'Destination prefix mask' },
      { name: 'nextHop', type: 'string', required: false, description: 'Next hop (optional)' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const nextHop = ctx.args.get<string | undefined>('nextHop');
    const result = machine.router.removeStaticRoute(
      ctx.args.get<string>('network'),
      ctx.args.get<string>('mask'),
      nextHop,
    );
    if (!result.ok) {
      // Cisco IOS reste silencieux si la route n'existe pas — ne pas
      // fabriquer d'erreur bruyante.
      return EXIT_OK;
    }
    return EXIT_OK;
  }
}
