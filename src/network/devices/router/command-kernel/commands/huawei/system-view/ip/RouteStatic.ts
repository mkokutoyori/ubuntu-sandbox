import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `ip route-static <net> <mask> <next-hop>` (Huawei VRP, mode system-view)
 * — commande FEUILLE standalone. Ajoute une route statique via
 * `RouterMachineApi.router.addStaticRoute`. Silence en cas de succès ;
 * message vendeur exact pour toute erreur.
 */
export class HuaweiRouterIpRouteStaticCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'route-static',
    summary: 'Configure a static route',
    usage: 'ip route-static <A.B.C.D> <mask> <next-hop>',
    args: [
      { name: 'network', type: 'string', required: true, description: 'Destination prefix' },
      { name: 'mask',    type: 'string', required: true, description: 'Destination mask (decimal or CIDR)' },
      { name: 'nextHop', type: 'string', required: true, description: 'Next hop address' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const rawMask = ctx.args.get<string>('mask');
    const cidr = /^\d+$/.test(rawMask) ? Number.parseInt(rawMask, 10) : null;
    const mask = cidr !== null && cidr >= 0 && cidr <= 32 ? cidrToMask(cidr) : rawMask;
    const result = machine.router.addStaticRoute(
      ctx.args.get<string>('network'),
      mask,
      ctx.args.get<string>('nextHop'),
    );
    if (!result.ok) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}

function cidrToMask(cidr: number): string {
  const bits = cidr >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((s) => (mask >>> s) & 0xff).join('.');
}
