import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoRouterShowIpBgpCommand } from './ip/Bgp';
import { CiscoRouterShowIpCefCommand } from './ip/Cef';
import { CiscoRouterShowIpRipCommand } from './ip/Rip';
import { CiscoRouterShowIpEigrpCommand } from './ip/Eigrp';
import { CiscoRouterShowIpInterfaceCommand } from './ip/Interface';
import { CiscoRouterShowIpNatCommand } from './ip/Nat';
import { CiscoRouterShowIpOspfCommand } from './ip/Ospf';
import { CiscoRouterShowIpProtocolsCommand } from './ip/Protocols';
import { CiscoRouterShowIpRouteCommand } from './ip/Route';

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
    this.subRegistry.register(() => new CiscoRouterShowIpRouteCommand());
    this.subRegistry.register(() => new CiscoRouterShowIpProtocolsCommand());
    this.subRegistry.register(() => new CiscoRouterShowIpOspfCommand());
    this.subRegistry.register(() => new CiscoRouterShowIpBgpCommand());
    this.subRegistry.register(() => new CiscoRouterShowIpEigrpCommand());
    this.subRegistry.register(() => new CiscoRouterShowIpNatCommand());
    this.subRegistry.register(() => new CiscoRouterShowIpCefCommand());
    this.subRegistry.register(() => new CiscoRouterShowIpRipCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
