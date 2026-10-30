import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

export const ipsetCommand: LinuxCommand = {
  name: 'ipset',
  package: 'ipset',
  needsNetworkContext: true,
  readsStdin: true,
  usage: 'ipset [options] COMMAND',
  privilege: { satisfiedBy: Satisfy.root },
  run(ctx: LinuxCommandContext, args: string[], stdin?: string): string {
    return ctx.executor.ipset.execute(args, stdin).output;
  },
  runWithStatusSync(ctx: LinuxCommandContext, args: string[], stdin?: string): { output: string; exitCode: number } {
    return ctx.executor.ipset.execute(args, stdin);
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<{ output: string; exitCode: number }> {
    return Promise.resolve(ctx.executor.ipset.execute(args, stdin));
  },
};
