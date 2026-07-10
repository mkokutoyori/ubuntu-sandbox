import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { cmdUptime } from '../../system/SystemInfo';

export const uptimeCommand: LinuxCommand = {
  name: 'uptime',
  needsNetworkContext: true,
  usage: 'uptime [options]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    return cmdUptime(args, ctx.executor.lifecycle);
  },
};
