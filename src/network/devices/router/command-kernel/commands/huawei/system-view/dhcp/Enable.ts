import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `dhcp enable` (Huawei VRP, system-view) — feuille standalone. Active
 * le service DHCP global via `RouterMachineApi.enableDhcp`. Silence
 * VRP en cas de succès.
 */
export class HuaweiRouterSysDhcpEnableCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'enable',
    summary: 'Enable global DHCP service',
    usage: 'dhcp enable',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    (ctx.machine as RouterMachineApi).enableDhcp();
    return EXIT_OK;
  }
}
