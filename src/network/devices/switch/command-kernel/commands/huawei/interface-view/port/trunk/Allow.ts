import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiSwitchPortTrunkAllowPassCommand } from './allow/Pass';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `port trunk allow-pass` (Huawei VRP) — COMPOSITE (le vendeur exige
 * exactement `allow-pass vlan …`). Aucune autre sous-forme pour l'instant.
 */
export class HuaweiSwitchPortTrunkAllowCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'allow-pass',
    summary: 'Allow VLANs to pass through the trunk',
    usage: 'port trunk allow-pass <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['interface-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiSwitchPortTrunkAllowPassCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
