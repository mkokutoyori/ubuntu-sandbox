import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CiscoSwitchShowCdpNeighborsCommand } from './cdp/Neighbors';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `cdp` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class CiscoSwitchShowCdpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'cdp',
    summary: 'CDP information',
    usage: 'show cdp {neighbors}',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };
  readonly allowedModes = ['user', 'privileged'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchShowCdpNeighborsCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
