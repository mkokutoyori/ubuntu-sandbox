import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CiscoSwitchConfigVtpDomainCommand } from './vtp/Domain';
import { CiscoSwitchConfigVtpModeCommand } from './vtp/Mode';
import { CiscoSwitchConfigVtpPasswordCommand } from './vtp/Password';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `vtp` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class CiscoSwitchConfigVtpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vtp',
    summary: 'VTP configuration',
    usage: 'vtp {domain|mode|password}',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchConfigVtpDomainCommand());
    this.subRegistry.register(() => new CiscoSwitchConfigVtpModeCommand());
    this.subRegistry.register(() => new CiscoSwitchConfigVtpPasswordCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
