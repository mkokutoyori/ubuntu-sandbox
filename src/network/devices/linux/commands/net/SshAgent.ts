import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const sshAgentCommand: LinuxCommand = {
  name: 'ssh-agent',
  package: 'openssh-client',
  needsNetworkContext: true,
  opensWireSession: true,
  manSection: 1,
  usage: 'ssh-agent [-c | -s] [-Dd] [-a bind_address] [-E fingerprint_hash] [-P allowed_providers] [-t life] [command [arg ...]]',
  help: 'OpenSSH authentication agent.',

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await ctx.executor.runSshAgentAsync(args)).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return ctx.executor.runSshAgentAsync(args);
  },
};
