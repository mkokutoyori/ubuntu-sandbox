import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import {
  CiscoSwitchPortSecurityViolationProtectCommand,
  CiscoSwitchPortSecurityViolationRestrictCommand,
  CiscoSwitchPortSecurityViolationShutdownCommand,
} from './violation/violation-leaf';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport port-security violation` (composite). */
export class CiscoSwitchPortSecurityViolationCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'violation',
    summary: 'Violation action on port security',
    usage: 'switchport port-security violation {protect|restrict|shutdown}',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchPortSecurityViolationShutdownCommand());
    this.subRegistry.register(() => new CiscoSwitchPortSecurityViolationRestrictCommand());
    this.subRegistry.register(() => new CiscoSwitchPortSecurityViolationProtectCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
