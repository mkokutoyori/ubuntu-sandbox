import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { HuaweiSwitchIfStpBpduCommand } from './stp/Bpdu';
import { HuaweiSwitchIfStpEdgedPortCommand } from './stp/EdgedPort';
import { HuaweiSwitchIfStpPriorityCommand } from './stp/Priority';
import { HuaweiSwitchIfStpCostCommand } from './stp/Cost';
import { HuaweiSwitchIfStpBpduFilterCommand } from './stp/BpduFilter';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `stp` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class HuaweiSwitchIfStpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'stp',
    summary: 'STP per-interface configuration',
    usage: 'stp <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['interface-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiSwitchIfStpBpduCommand());
    this.subRegistry.register(() => new HuaweiSwitchIfStpEdgedPortCommand());
    this.subRegistry.register(() => new HuaweiSwitchIfStpPriorityCommand());
    this.subRegistry.register(() => new HuaweiSwitchIfStpCostCommand());
    this.subRegistry.register(() => new HuaweiSwitchIfStpBpduFilterCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('Error: Incomplete command found at \'^\' position.\n');
    return 1;
  }
}
