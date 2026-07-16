import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** Convertit un CIDR (`24`) en masque décimal (`255.255.255.0`). Fonction
 *  pure locale — un `mask` VRP peut être écrit soit en décimal, soit en
 *  entier CIDR. */
function cidrToMask(cidr: number): string {
  const bits = cidr >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((s) => (mask >>> s) & 0xff).join('.');
}

/**
 * `ip address <A.B.C.D> <mask|cidr>` (Huawei VRP, mode interface-view) —
 * commande FEUILLE standalone. Configure l'IP primaire de l'interface
 * sélectionnée via `RouterMachineApi.router.setInterfaceIp`. Accepte le
 * masque en notation décimale (`255.255.255.0`) OU en préfixe CIDR
 * (`24`) — comportement VRP standard. Silence en cas de succès ;
 * message vendeur exact pour toute erreur.
 */
export class HuaweiRouterIfIpAddressCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'address',
    summary: 'Set the IP address of the interface',
    usage: 'ip address <A.B.C.D> <mask|cidr>',
    args: [
      { name: 'ip',   type: 'string', required: true, description: 'IPv4 address' },
      { name: 'mask', type: 'string', required: true, description: 'Subnet mask (decimal or CIDR)' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['interface-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) {
      await ctx.io.stderr.write("Error: No interface selected.\n");
      return 1;
    }
    const ip = ctx.args.get<string>('ip');
    const rawMask = ctx.args.get<string>('mask');
    const cidrMatch = /^\d+$/.test(rawMask) ? Number.parseInt(rawMask, 10) : null;
    const mask = cidrMatch !== null && cidrMatch >= 0 && cidrMatch <= 32
      ? cidrToMask(cidrMatch)
      : rawMask;
    const result = machine.router.setInterfaceIp(iface, ip, mask);
    if (!result.ok) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
