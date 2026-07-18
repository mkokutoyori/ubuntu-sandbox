import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CiscoRouterConfigIfStandbyIpCommand } from './standby/Ip';
import { CiscoRouterConfigIfStandbyPriorityCommand } from './standby/Priority';
import { CiscoRouterConfigIfStandbyPreemptCommand } from './standby/Preempt';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `standby` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class CiscoRouterConfigIfStandbyCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'standby',
    summary: 'HSRP standby group config',
    usage: 'standby {ip|priority|preempt|name} ...',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterConfigIfStandbyIpCommand());
    this.subRegistry.register(() => new CiscoRouterConfigIfStandbyPriorityCommand());
    this.subRegistry.register(() => new CiscoRouterConfigIfStandbyPreemptCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
