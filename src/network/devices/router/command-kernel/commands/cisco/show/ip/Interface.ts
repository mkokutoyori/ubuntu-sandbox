import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoRouterShowIpInterfaceBriefCommand } from './interface/Brief';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `show ip interface` (Cisco IOS routeur) — commande COMPOSITE. Point
 * d'entrée des vues d'interfaces IP (`brief`, plus tard `<name>`).
 * `show ip interface` seul = incomplete (le vrai IOS renvoie un résumé
 * détaillé de TOUTES les interfaces — non migré tant qu'un test rouge
 * ne l'exige pas).
 */
export class CiscoRouterShowIpInterfaceCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'interface',
    summary: 'IP interface status and configuration',
    usage: 'show ip interface [brief | <name>]',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user', 'privileged'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterShowIpInterfaceBriefCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
