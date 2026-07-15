import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoShowVersionCommand } from './ShowVersion';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** Sous-registre de `show` — chaque sous-commande (`version`,
 *  `running-config`, `ip route`…) migrée s'y enregistre au fil du
 *  temps. L'interpréteur descend automatiquement dedans quand il
 *  rencontre `show <sub>`. */
const SHOW_SUB = new CommandRegistry();
SHOW_SUB.register(() => new CiscoShowVersionCommand());

/**
 * `show` (Cisco IOS) — commande composite hiérarchique. Elle N'exécute
 * PAS elle-même : elle sert de porte d'entrée pour l'interpréteur, qui
 * consulte `subRegistry` pour trouver la sous-commande réelle (`show
 * version`, `show ip route`…). Chaque sous-commande est autonome (son
 * propre descripteur, sa propre politique de privilèges).
 *
 * `show` seul (sans sous-mot) est une commande incomplete — vrai IOS
 * répond « % Incomplete command. ».
 */
export class CiscoShowCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'show',
    aliases: ['sh'],
    summary: 'Display running system information',
    usage: 'show <subcommand>',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user', 'privileged'];
  readonly subRegistry = SHOW_SUB;

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
