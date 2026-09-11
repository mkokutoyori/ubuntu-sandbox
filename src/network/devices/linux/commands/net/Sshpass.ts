import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

const SSHPASS_USAGE = 'Usage: sshpass [-f|-d|-p|-e[env_var]] [-hV] command parameters';

const UNSUPPORTED =
  'sshpass: only `sshpass -p <pw> ssh|scp|sftp …` is supported in the simulator';

function splitSshpass(args: string[]): { password?: string; wrapped: string[] } {
  let password: string | undefined;
  let i = 0;
  while (i < args.length) {
    if (args[i] === '-p' && args[i + 1] !== undefined) {
      password = args[i + 1];
      i += 2;
      continue;
    }
    break;
  }
  return { password, wrapped: args.slice(i) };
}

export const sshpassCommand: LinuxCommand = {
  name: 'sshpass',
  needsNetworkContext: true,
  readsStdin: true,
  manSection: 1,
  usage: SSHPASS_USAGE,
  help: 'Run a command with a non-interactive ssh password.',
  complete: makeArgCompleter({ flags: ['-p', '-f', '-e'] }),
  options: [
    { flag: '-p', description: 'Password to supply to ssh.', takesArg: true, argName: 'password' },
  ],

  async run(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<string> {
    return (await this.runWithStatus!(ctx, args, stdin)).output;
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    const { password, wrapped } = splitSshpass(args);
    const verb = wrapped[0];
    if (verb === 'ssh') {
      return ctx.executor.runSshExecAsync(wrapped.slice(1), password);
    }
    if (verb === 'scp' || verb === 'sftp') {
      return ctx.executor.runSshTransportAsync(verb, wrapped.slice(1), password ?? '', stdin);
    }
    if (verb === 'rsync') {
      return ctx.executor.runSshTransport('rsync', wrapped.slice(1), stdin, password);
    }
    return { output: UNSUPPORTED, exitCode: 1 };
  },
};
