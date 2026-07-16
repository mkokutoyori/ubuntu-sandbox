import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchShowVlanBriefCommand } from './vlan/Brief';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `show vlan` (Cisco Catalyst) — commande COMPOSITE. Le vrai IOS accepte
 * `show vlan` seul (vue complète) et `show vlan brief` (vue tabulaire
 * réduite). Seule la vue `brief` est migrée pour l'instant : `show vlan`
 * seul renvoie « Incomplete command. » — signal explicite qu'il reste
 * la vue complète à migrer.
 */
export class CiscoSwitchShowVlanCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vlan',
    summary: 'VLAN information',
    usage: 'show vlan [brief]',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };
  readonly allowedModes = ['user', 'privileged'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchShowVlanBriefCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
