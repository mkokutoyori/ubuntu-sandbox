import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `ip address <A.B.C.D> <M.M.M.M>` (Cisco IOS, mode config-if) —
 * commande FEUILLE standalone. Configure l'IP primaire de l'interface
 * sélectionnée via `RouterMachineApi.router.setInterfaceIp`. Silence
 * en cas de succès ; message vendeur exact pour toute erreur.
 */
export class CiscoRouterIpAddressCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'address',
    summary: 'Set the IP address of an interface',
    usage: 'ip address <A.B.C.D> <M.M.M.M>',
    args: [
      { name: 'ip', type: 'string', required: true, description: 'IPv4 address' },
      { name: 'mask', type: 'string', required: true, description: 'Subnet mask (dotted decimal)' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) {
      await ctx.io.stderr.write('% No interface selected.\n');
      return 1;
    }
    const ip = ctx.args.get<string>('ip');
    const mask = ctx.args.get<string>('mask');
    const result = machine.router.setInterfaceIp(iface, ip, mask);
    if (!result.ok) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
