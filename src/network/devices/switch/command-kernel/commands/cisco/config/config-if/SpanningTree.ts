import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CiscoSwitchSpanningTreePortfastCommand } from './spanning-tree/Portfast';
import { CiscoSwitchSpanningTreeBpduguardCommand } from './spanning-tree/Bpduguard';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `spanning-tree` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class CiscoSwitchConfigIfSpanningTreeCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'spanning-tree',
    summary: 'Spanning tree per-interface configuration',
    usage: 'spanning-tree {portfast|bpduguard <mode>|bpdufilter <mode>|cost <n>|priority <n>}',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchSpanningTreePortfastCommand());
    this.subRegistry.register(() => new CiscoSwitchSpanningTreeBpduguardCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
