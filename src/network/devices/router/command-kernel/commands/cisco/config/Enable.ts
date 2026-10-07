import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CiscoRouterConfigEnableSecretCommand } from './enable/Secret';
import { CiscoRouterConfigEnablePasswordCommand } from './enable/Password';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `enable` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class CiscoRouterConfigEnableCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'enable',
    summary: 'Configure privileged-EXEC access',
    usage: 'enable {secret|password} <text>',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterConfigEnableSecretCommand());
    this.subRegistry.register(() => new CiscoRouterConfigEnablePasswordCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
