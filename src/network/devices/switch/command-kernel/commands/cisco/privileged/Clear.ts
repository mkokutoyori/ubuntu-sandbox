import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CiscoSwitchClearCountersCommand } from './clear/Counters';
import { CiscoSwitchClearMacCommand } from './clear/Mac';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `clear` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class CiscoSwitchClearCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'clear',
    summary: 'Reset counters / MAC table',
    usage: 'clear <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['privileged'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchClearCountersCommand());
    this.subRegistry.register(() => new CiscoSwitchClearMacCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
