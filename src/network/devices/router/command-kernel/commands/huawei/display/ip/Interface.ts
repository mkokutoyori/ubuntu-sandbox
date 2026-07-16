import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiRouterDisplayIpInterfaceBriefCommand } from './interface/Brief';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `display ip interface` (Huawei VRP routeur) — commande COMPOSITE.
 * Racine des affichages par interface (`brief`, plus tard `<name>` pour
 * le détail complet). `display ip interface` seul est incomplete (au
 * niveau du noyau — le vrai VRP l'accepte comme équivalent à
 * `display ip interface` avec liste, à porter au fil des migrations).
 */
export class HuaweiRouterDisplayIpInterfaceCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'interface',
    summary: 'IP interface information',
    usage: 'display ip interface <subcommand>',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiRouterDisplayIpInterfaceBriefCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
