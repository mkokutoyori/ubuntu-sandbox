import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

export const sshCopyIdCommand: LinuxCommand = {
  name: 'ssh-copy-id',
  needsNetworkContext: true,
  opensWireSession: true,
  manSection: 1,
  usage: 'Usage: /usr/bin/ssh-copy-id [-h|-?|-f|-n|-s] [-i [identity_file]] [-p port] [-F alternative ssh_config file] [[-o <ssh -o options>] ...] [user@]hostname',
  help: 'Use locally available keys to authorise logins on a remote machine.',
  complete: makeArgCompleter({ flags: ['-f', '-n', '-s', '-i', '-p', '-o', '-F'] }),
  options: [
    { flag: '-f', description: 'Force mode: install the keys without checking whether they are already there.' },
    { flag: '-n', description: 'Dry run: print the keys that would be installed.' },
    { flag: '-s', description: 'Install the keys through the SFTP subsystem.' },
    { flag: '-i', description: 'Public key file to install.', takesArg: true, argName: 'identity_file' },
    { flag: '-p', description: 'Port to connect to on the remote host.', takesArg: true, argName: 'port' },
    { flag: '-o', description: 'Pass an option to ssh.', takesArg: true, argName: 'option' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await ctx.executor.runSshCopyIdAsync(args, '')).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return ctx.executor.runSshCopyIdAsync(args, '');
  },
};
