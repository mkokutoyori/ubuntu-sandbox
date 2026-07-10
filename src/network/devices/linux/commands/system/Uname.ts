import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { cmdUname } from '../../system/SystemInfo';

export const unameCommand: LinuxCommand = {
  name: 'uname',
  needsNetworkContext: true,
  usage: 'uname [options]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    const hostname = (ctx.executor.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
    return cmdUname(args, hostname, ctx.executor.identity.kernel);
  },
};
