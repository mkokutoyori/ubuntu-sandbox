import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * Sous-registre de `configure` — pour l'instant seule `terminal` y est
 * enregistrée (le seul sous-mot supporté est `configure terminal`). Le
 * jour où `configure replace` / `configure memory` seront migrés, ils
 * s'ajoutent ici — c'est LE point d'extension du dispatch hiérarchique.
 */
const CONFIGURE_SUB = new CommandRegistry();

class TerminalSubCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'terminal',
    aliases: ['t'],
    summary: 'Configure from the terminal',
    usage: 'configure terminal',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'cli-mode',
  };

  protected targetMode(_ctx: CommandContext): string {
    return 'config';
  }
}
CONFIGURE_SUB.register(() => new TerminalSubCommand());

/**
 * `configure` (Cisco IOS) — commande composite : `configure terminal`
 * pousse le mode `config`. La commande racine ne fait rien elle-même ;
 * elle expose son sous-registre pour que l'interpréteur y descende.
 * Écrire `configure` seul (sans sous-mot) est une erreur métier propre.
 */
export class CiscoConfigureCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'configure',
    aliases: ['conf', 'config'],
    summary: 'Enter configuration mode',
    usage: 'configure <sub>',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'cli-mode',
  };
  readonly allowedModes = ['privileged'];
  readonly subRegistry = CONFIGURE_SUB;

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    // Ce point n'est atteint que si l'interpréteur n'a PAS trouvé de
    // sous-mot (donc `configure` tapé seul, sans `terminal`).
    await ctx.io.stderr.write('% Incomplete command.\n');
    return false;
  }

  // Requis par `PushModeCommand` mais jamais atteint : `prepare()`
  // retourne toujours `false` (commande incomplete).
  protected targetMode(_ctx: CommandContext): string {
    return 'config';
  }
}
