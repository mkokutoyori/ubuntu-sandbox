import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

export const sshAddCommand: LinuxCommand = {
  name: 'ssh-add',
  needsNetworkContext: true,
  opensWireSession: true,
  manSection: 1,
  usage: 'ssh-add [-cDdKkLlqvXx] [-E fingerprint_hash] [-H hostkey_file] [-h destination_constraint] [-S provider] [-t life] [file ...]',
  help: 'Add private key identities to the OpenSSH authentication agent.',
  complete: makeArgCompleter({ flags: ['-l', '-L', '-d', '-D', '-q', '-E'] }),
  options: [
    { flag: '-l', description: 'List fingerprints of all identities currently represented by the agent.' },
    { flag: '-L', description: 'List public key parameters of all identities currently represented by the agent.' },
    { flag: '-d', description: 'Remove the identity from the agent.' },
    { flag: '-D', description: 'Delete all identities from the agent.' },
    { flag: '-q', description: 'Be quiet after a successful operation.' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await ctx.executor.runSshAddAsync(args)).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return ctx.executor.runSshAddAsync(args);
  },
};
