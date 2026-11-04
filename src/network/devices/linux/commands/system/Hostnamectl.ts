import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { runHostnamectl } from '../../hostnamed/HostnamectlTool';
import { linuxHostnamectlHost } from '../../hostnamed/LinuxHostnamedPlatform';
import { commandResultOf, completeLinesResultOf } from '../ToolOutputShape';

const outcome = (ctx: LinuxCommandContext, args: string[]) => runHostnamectl(ctx.invokedAs ?? 'hostnamectl', args, linuxHostnamectlHost(ctx));

export const hostnamectlCommand: LinuxCommand = {
  name: 'hostnamectl',
  package: 'systemd',
  needsNetworkContext: true,
  ownsHelpOption: true,
  manSection: 1,
  usage: 'hostnamectl [OPTIONS...] COMMAND ...',
  help: 'hostnamectl - query or change system hostname',
  run: async (ctx, args) => commandResultOf(await outcome(ctx, args)).interleaved,
  runWithStatus: async (ctx, args) => completeLinesResultOf(await outcome(ctx, args)),
};
