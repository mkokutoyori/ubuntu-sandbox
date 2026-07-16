import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiRouterUndoIpCommand } from './undo/Ip';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo` (Huawei VRP, mode system-view) — commande COMPOSITE. Racine
 * des négations en system-view (`undo ip route-static`, plus tard
 * `undo sysname`, `undo dhcp enable`, `undo ipv6`, …). VRP utilise
 * `undo` au lieu du `no` Cisco.
 */
export class HuaweiRouterSysUndoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'undo',
    summary: 'Negate a command / restore its default',
    usage: 'undo <command>',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiRouterUndoIpCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
