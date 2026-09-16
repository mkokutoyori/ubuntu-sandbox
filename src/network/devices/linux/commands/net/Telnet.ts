import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

const TELNET_USAGE = 'usage: telnet host-name [port]';

export const telnetCommand: LinuxCommand = {
  name: 'telnet',
  needsNetworkContext: true,
  manSection: 1,
  usage: TELNET_USAGE,
  help: 'User interface to the TELNET protocol.',
  complete: makeArgCompleter({ flags: ['-l', '-a', '-E', '-4', '-6'] }),
  options: [
    { flag: '-l', description: 'Login name to pass to the remote system.', takesArg: true, argName: 'user' },
    { flag: '-a', description: 'Attempt automatic login.' },
    { flag: '-E', description: 'Disable the escape character.' },
    { flag: '-4', description: 'Force IPv4.' },
    { flag: '-6', description: 'Force IPv6.' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await ctx.executor.runTelnetExecAsync(args)).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return ctx.executor.runTelnetExecAsync(args);
  },
};
