import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CiscoRouterShowNtpStatusCommand } from './ntp/Status';
import { CiscoRouterShowNtpAssociationsCommand } from './ntp/Associations';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `ntp` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class CiscoRouterShowNtpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ntp',
    summary: 'NTP status/associations',
    usage: 'show ntp {status|associations}',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user', 'privileged'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterShowNtpStatusCommand());
    this.subRegistry.register(() => new CiscoRouterShowNtpAssociationsCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
