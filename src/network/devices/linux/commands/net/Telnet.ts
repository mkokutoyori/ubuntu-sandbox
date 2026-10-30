import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

const TELNET_USAGE = 'telnet [-4] [-6] [-8] [-E] [-L] [-a] [-d] [-e char] [-l user] [-n tracefile] [-b addr] [-r] [host-name [port]]';

export const telnetCommand: LinuxCommand = {
  name: 'telnet',
  needsNetworkContext: true,
  manSection: 1,
  usage: TELNET_USAGE,
  help: 'User interface to the TELNET protocol.',
  readsStdin: true,
  complete: makeArgCompleter({ flags: ['-4', '-6', '-8', '-E', '-L', '-a', '-b', '-d', '-e', '-l', '-n', '-r'] }),
  options: [
    { flag: '-l', description: 'Login name to pass to the remote system.', takesArg: true, argName: 'user' },
    { flag: '-a', description: 'Attempt automatic login.' },
    { flag: '-E', description: 'Disable the escape character.' },
    { flag: '-4', description: 'Force IPv4.' },
    { flag: '-6', description: 'Force IPv6.' },
    { flag: '-8', description: 'Request 8-bit operation (binary on both directions).' },
    { flag: '-L', description: 'Binary on output only.' },
    { flag: '-d', description: 'Set the initial value of the debug toggle to TRUE.' },
    { flag: '-e', description: 'Set the initial escape character.', takesArg: true, argName: 'escapechar' },
    { flag: '-n', description: 'Open tracefile for recording trace information.', takesArg: true, argName: 'tracefile' },
    { flag: '-b', description: 'Use a local address as the source of the connection.', takesArg: true, argName: 'addr' },
    { flag: '-r', description: 'Emulate rlogin(1).' },
  ],

  async run(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<string> {
    const result = await ctx.executor.runTelnetExecAsync(args, stdin);
    return result.interleaved ?? result.output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    return ctx.executor.runTelnetExecAsync(args, stdin);
  },
};
