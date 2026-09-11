import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

const SSH_USAGE = 'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]\n'
  + '           [-b bind_address] [-c cipher_spec] [-D [bind_address:]port]\n'
  + '           [-E log_file] [-e escape_char] [-F configfile] [-I pkcs11]\n'
  + '           [-i identity_file] [-J destination] [-L address] [-l login_name]\n'
  + '           [-m mac_spec] [-O ctl_cmd] [-o option] [-p port] [-Q query_option]\n'
  + '           [-R address] [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]\n'
  + '           destination [command [argument ...]]';

export const sshCommand: LinuxCommand = {
  name: 'ssh',
  needsNetworkContext: true,
  manSection: 1,
  usage: SSH_USAGE,
  help: 'OpenSSH remote login client.',
  complete: makeArgCompleter({
    flags: ['-p', '-i', '-o', '-l', '-t', '-T', '-q', '-v', '-N', '-L', '-R', '-D', '-J', '-A'],
  }),
  options: [
    { flag: '-p', description: 'Port to connect to on the remote host.', takesArg: true, argName: 'port' },
    { flag: '-i', description: 'Identity (private key) file.', takesArg: true, argName: 'file' },
    { flag: '-o', description: 'Set an option in the ssh_config format.', takesArg: true, argName: 'option' },
    { flag: '-l', description: 'Login name on the remote machine.', takesArg: true, argName: 'login_name' },
    { flag: '-t', description: 'Force pseudo-terminal allocation.' },
    { flag: '-T', description: 'Disable pseudo-terminal allocation.' },
    { flag: '-q', description: 'Quiet mode.' },
    { flag: '-N', description: 'Do not execute a remote command.' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await ctx.executor.runSshExecAsync(args)).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return ctx.executor.runSshExecAsync(args);
  },
};
