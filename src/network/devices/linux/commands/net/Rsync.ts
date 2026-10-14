import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

export const rsyncCommand: LinuxCommand = {
  name: 'rsync',
  needsNetworkContext: true,
  opensWireSession: true,
  manSection: 1,
  usage: 'rsync [OPTION]... SRC [SRC]... [USER@]HOST:DEST',
  help: 'A fast, versatile, remote (and local) file-copying tool.',
  complete: makeArgCompleter({ flags: ['-a', '-v', '-z', '-r', '-e', '-n'] }),
  options: [
    { flag: '-a', description: 'Archive mode.' },
    { flag: '-v', description: 'Increase verbosity.' },
    { flag: '-z', description: 'Compress file data during the transfer.' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await ctx.executor.runRsyncAsync(args)).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return ctx.executor.runRsyncAsync(args);
  },
};
