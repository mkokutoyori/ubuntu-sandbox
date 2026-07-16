import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiSwitchPortTrunkPvidVlanCommand } from './pvid/Vlan';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `port trunk pvid` (Huawei VRP, interface-view) — COMPOSITE. Une seule
 * sous-forme : `pvid vlan <id>` (le VRP exige littéralement le mot
 * `vlan` avant l'id).
 */
export class HuaweiSwitchPortTrunkPvidCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'pvid',
    summary: 'Set the trunk PVID (native VLAN)',
    usage: 'port trunk pvid vlan <id>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['interface-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiSwitchPortTrunkPvidVlanCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
