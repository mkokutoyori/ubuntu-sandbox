import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `encapsulation dot1Q <vid> [native]` (Cisco IOS, mode config-if) —
 * commande FEUILLE standalone. Configure l'encapsulation dot1Q d'une
 * sous-interface. Refuse si l'interface courante n'est pas une
 * sous-interface (la façade porte cette règle).
 *
 * Le nom canonique de la sous-commande est `dot1Q` (majuscule) mais
 * la résolution est insensible à la casse — donc `dot1q` fonctionne
 * aussi (comportement Cisco).
 */
export class CiscoRouterEncapsulationDot1qCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'dot1Q',
    aliases: ['dot1q'],
    summary: 'IEEE 802.1Q Virtual LAN',
    usage: 'encapsulation dot1Q <vlan-id> [native]',
    args: [
      { name: 'vlan', type: 'int', required: true, description: 'IEEE 802.1Q VLAN identifier' },
      { name: 'native', type: 'string', required: false, description: 'Optional keyword: native' },
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
    const vlan = ctx.args.get<number>('vlan');
    const nativeToken = ctx.args.get<string | undefined>('native');
    if (nativeToken !== undefined && nativeToken.toLowerCase() !== 'native') {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    const native = nativeToken !== undefined;
    const result = machine.router.setInterfaceEncapsulation(iface, 'dot1Q', vlan, native);
    if (!result.ok) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
