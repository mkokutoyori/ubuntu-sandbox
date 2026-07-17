import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { HuaweiRouterDisplayBgpPeerCommand } from './bgp/Peer';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `bgp` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class HuaweiRouterDisplayBgpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'bgp',
    summary: 'Display BGP information',
    usage: 'display bgp <subcommand>',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiRouterDisplayBgpPeerCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('Error: Incomplete command found at \'^\' position.\n');
    return 1;
  }
}
