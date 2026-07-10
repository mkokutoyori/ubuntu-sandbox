import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

export const ip6tablesCommand: LinuxCommand = {
  name: 'ip6tables',
  needsNetworkContext: true,
  usage: 'ip6tables [-t table] COMMAND [args...]',
  privilege: { satisfiedBy: Satisfy.root },
  run(ctx: LinuxCommandContext, args: string[]): string {
    return ctx.executor.ip6tables.execute(args).output;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return Promise.resolve(ctx.executor.ip6tables.execute(args));
  },
};
