import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { HuaweiRouterSysHttpServerCommand } from './http/Server';
import { HuaweiRouterSysHttpSecureServerCommand } from './http/SecureServer';
import { HuaweiRouterSysHttpServerPortCommand } from './http/ServerPort';
import { HuaweiRouterSysHttpTimeoutCommand } from './http/Timeout';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `http` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class HuaweiRouterSysHttpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'http',
    summary: 'HTTP(S) server configuration',
    usage: 'http <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiRouterSysHttpServerCommand());
    this.subRegistry.register(() => new HuaweiRouterSysHttpSecureServerCommand());
    this.subRegistry.register(() => new HuaweiRouterSysHttpServerPortCommand());
    this.subRegistry.register(() => new HuaweiRouterSysHttpTimeoutCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('Error: Incomplete command found at \'^\' position.\n');
    return 1;
  }
}
