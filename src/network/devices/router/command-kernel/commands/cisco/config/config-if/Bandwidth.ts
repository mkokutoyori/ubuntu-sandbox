import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

export class CiscoRouterConfigIfBandwidthCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'bandwidth', summary: 'Set interface bandwidth in kbps', usage: 'bandwidth <kbps>',
    args: [{ name: 'kbps', type: 'int', required: true, description: 'Bandwidth in kbps (1-10000000)' }],
    options: [], privileges: OP, category: 'router',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    const kbps = ctx.args.get<number>('kbps');
    if (!machine.router.setInterfaceBandwidthKbps(iface, kbps)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
