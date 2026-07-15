import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import type { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `show` (Cisco IOS) — commande racine composite. Sémantique commune à
 * TOUS les équipements Cisco (routeur, switch) : nom `show`, alias
 * `sh`, disponible en mode user et privileged, `show` seul = incomplete.
 *
 * Seul le sous-registre change par équipement : routeur enregistre
 * `version`/`ip route`/`running-config`/… (matériel + L3), switch
 * enregistre `version`/`vlan`/`mac-address-table`/`interfaces`/… (L2).
 * Cette factory prend le sous-registre en paramètre pour éviter la
 * duplication de la mécanique.
 */
export function createCiscoShowCommand(subRegistry: CommandRegistry): CiscoShowCommand {
  return new CiscoShowCommand(subRegistry);
}

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

  constructor(public readonly subRegistry: CommandRegistry) {
    super();
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
