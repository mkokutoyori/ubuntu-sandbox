import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CiscoRouterConfigNtpAuthenticateCommand } from './ntp/Authenticate';
import { CiscoRouterConfigNtpAuthenticationKeyCommand } from './ntp/AuthenticationKey';
import { CiscoRouterNtpServerCommand } from './ntp/Server';
import { CiscoRouterConfigNtpTrustedKeyCommand } from './ntp/TrustedKey';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `ntp` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class CiscoRouterConfigNtpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ntp',
    summary: 'NTP configuration',
    usage: 'ntp {server <ip>}',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterNtpServerCommand());
    this.subRegistry.register(() => new CiscoRouterConfigNtpAuthenticateCommand());
    this.subRegistry.register(() => new CiscoRouterConfigNtpAuthenticationKeyCommand());
    this.subRegistry.register(() => new CiscoRouterConfigNtpTrustedKeyCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
