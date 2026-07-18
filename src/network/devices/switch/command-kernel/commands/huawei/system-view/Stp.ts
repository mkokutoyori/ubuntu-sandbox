import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { HuaweiSwitchSysStpEnableCommand } from './stp/Enable';
import { HuaweiSwitchSysStpModeCommand } from './stp/Mode';
import { HuaweiSwitchStpRootCommand } from './stp/Root';
import { HuaweiSwitchStpPriorityCommand } from './stp/Priority';
import { HuaweiSwitchSysStpRegionConfigurationCommand } from './stp/RegionConfiguration';
import { HuaweiSwitchSysStpBpduProtectionCommand } from './stp/BpduProtection';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `stp` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class HuaweiSwitchSysStpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'stp',
    summary: 'STP configuration',
    usage: 'stp <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['system-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiSwitchSysStpEnableCommand());
    this.subRegistry.register(() => new HuaweiSwitchSysStpModeCommand());
    this.subRegistry.register(() => new HuaweiSwitchStpRootCommand());
    this.subRegistry.register(() => new HuaweiSwitchStpPriorityCommand());
    this.subRegistry.register(() => new HuaweiSwitchSysStpRegionConfigurationCommand());
    this.subRegistry.register(() => new HuaweiSwitchSysStpBpduProtectionCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('Error: Incomplete command found at \'^\' position.\n');
    return 1;
  }
}
