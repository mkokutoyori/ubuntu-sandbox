import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoRouterEncapsulationDot1qCommand } from './encapsulation/Dot1q';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `encapsulation` (Cisco IOS, mode config-if) — commande COMPOSITE.
 * Racine des encapsulations à l'interface (`dot1Q`, plus tard `isl`,
 * `ppp`, `hdlc`, …). `encapsulation` seul est incomplete.
 */
export class CiscoRouterEncapsulationCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'encapsulation',
    summary: 'Set encapsulation type for an interface',
    usage: 'encapsulation <type> [args...]',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterEncapsulationDot1qCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
