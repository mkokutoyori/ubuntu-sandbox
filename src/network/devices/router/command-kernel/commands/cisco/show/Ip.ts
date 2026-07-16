import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoRouterShowIpInterfaceCommand } from './ip/Interface';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `show ip` (Cisco IOS routeur) — commande COMPOSITE. Racine des
 * commandes L3 côté routeur (`ip interface`, `ip route`, `ip arp`, …).
 * `show ip` seul est incomplete — comportement identique au vrai IOS.
 *
 * Le sous-registre est construit ici, chaque nouvelle sous-commande L3
 * migrée s'y ajoute (règle : pas d'enregistrement à distance depuis un
 * autre fichier, on garde la composition locale et lisible).
 */
export class CiscoRouterShowIpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ip',
    summary: 'IP information',
    usage: 'show ip <subcommand>',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user', 'privileged'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterShowIpInterfaceCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
