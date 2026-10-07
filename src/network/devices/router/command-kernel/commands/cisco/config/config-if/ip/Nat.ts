import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CiscoRouterConfigIfIpNatInsideCommand } from './nat/Inside';
import { CiscoRouterConfigIfIpNatOutsideCommand } from './nat/Outside';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `nat` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class CiscoRouterConfigIfIpNatCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'nat',
    summary: 'NAT interface role',
    usage: 'ip nat {inside|outside}',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterConfigIfIpNatInsideCommand());
    this.subRegistry.register(() => new CiscoRouterConfigIfIpNatOutsideCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
