import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { HuaweiRouterAaaHwtacacsTemplatePushCommand } from './hwtacacs-server/Template';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

export class HuaweiRouterAaaHwtacacsServerCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'hwtacacs-server',
    summary: 'HWTACACS server configuration',
    usage: 'hwtacacs-server <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['aaa-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiRouterAaaHwtacacsTemplatePushCommand());
  }

  async execute(_ctx: CommandContext): Promise<ExitCode> {
    return EXIT_OK;
  }
}
