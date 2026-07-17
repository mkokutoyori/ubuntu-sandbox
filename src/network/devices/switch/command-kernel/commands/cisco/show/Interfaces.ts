import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CiscoSwitchShowInterfacesStatusCommand } from './interfaces/Status';
import { CiscoSwitchShowInterfacesTrunkCommand } from './interfaces/Trunk';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `interfaces` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class CiscoSwitchShowInterfacesCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'interfaces',
    summary: 'Display interface status/trunk',
    usage: 'show interfaces {status|trunk|<name>}',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };
  readonly allowedModes = ['user', 'privileged'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchShowInterfacesStatusCommand());
    this.subRegistry.register(() => new CiscoSwitchShowInterfacesTrunkCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
