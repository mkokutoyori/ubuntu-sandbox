import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

const SFTP_USAGE = 'usage: sftp [-46AaCfNpqrv] [-B buffer_size] [-b batchfile] [-c cipher]\n' +
  '            [-D sftp_server_command] [-F ssh_config] [-i identity_file]\n' +
  '            [-J destination] [-l limit] [-o ssh_option] [-P port]\n' +
  '            [-R num_requests] [-S program] [-s subsystem | sftp_server]\n' +
  '            [-X sftp_option] destination';

/**
 * `sftp` — same real session as `scp` (`runSshTransportAsync`). It reads
 * stdin because the batch of verbs can arrive on a pipe or a here-doc,
 * which is exactly the spelling that used to slip onto the synchronous
 * dispatch and browse the remote in memory.
 */
export const sftpCommand: LinuxCommand = {
  name: 'sftp',
  needsNetworkContext: true,
  readsStdin: true,
  manSection: 1,
  usage: SFTP_USAGE,
  help: 'Interactive file transfer over SSH.',
  complete: makeArgCompleter({ flags: ['-b', '-P', '-i', '-o', '-r', '-q', '-v'] }),
  options: [
    { flag: '-b', description: 'Read the verbs from this batch file.', takesArg: true, argName: 'batchfile' },
    { flag: '-P', description: 'Port to connect to on the remote host.', takesArg: true, argName: 'port' },
    { flag: '-i', description: 'Identity (private key) file.', takesArg: true, argName: 'file' },
    { flag: '-o', description: 'Pass an option to ssh.', takesArg: true, argName: 'option' },
    { flag: '-r', description: 'Copy directories recursively.' },
  ],

  async run(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<string> {
    return (await ctx.executor.runSshTransportAsync('sftp', args, '', stdin)).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    return ctx.executor.runSshTransportAsync('sftp', args, '', stdin);
  },
};
