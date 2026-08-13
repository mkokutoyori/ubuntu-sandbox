import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

const SCP_USAGE = 'usage: scp [-346ABCOpqRrsTv] [-c cipher] [-D sftp_server_path] [-F ssh_config]\n' +
  '           [-i identity_file] [-J destination] [-l limit] [-o ssh_option]\n' +
  '           [-P port] [-S program] [-X sftp_option] source ... target';

/**
 * `scp` — the transfer runs through a genuine authenticated SSH session
 * (`runSshTransportAsync`), which is why this command is async: opening
 * one needs to await, and a synchronous dispatch could only ever fall
 * back to reading the remote machine's filesystem in memory.
 */
export const scpCommand: LinuxCommand = {
  name: 'scp',
  needsNetworkContext: true,
  manSection: 1,
  usage: SCP_USAGE,
  help: 'Copy files between hosts over SSH.',
  complete: makeArgCompleter({ flags: ['-r', '-p', '-P', '-i', '-o', '-q', '-v', '-C'] }),
  options: [
    { flag: '-r', description: 'Copy directories recursively.' },
    { flag: '-p', description: 'Preserve modification time and mode.' },
    { flag: '-P', description: 'Port to connect to on the remote host.', takesArg: true, argName: 'port' },
    { flag: '-i', description: 'Identity (private key) file.', takesArg: true, argName: 'file' },
    { flag: '-o', description: 'Pass an option to ssh.', takesArg: true, argName: 'option' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await ctx.executor.runSshTransportAsync('scp', args, '')).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return ctx.executor.runSshTransportAsync('scp', args, '');
  },
};
