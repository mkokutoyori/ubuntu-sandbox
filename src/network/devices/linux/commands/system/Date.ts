import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { cmdDate } from '../../system/SystemInfo';

export const dateCommand: LinuxCommand = {
  name: 'date',
  needsNetworkContext: true,
  usage: 'date [-d DATESPEC] [+FORMAT]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    return cmdDate(args, ctx.executor.identity.timezone);
  },
};
