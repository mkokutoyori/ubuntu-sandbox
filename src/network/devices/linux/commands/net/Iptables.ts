import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';
import { applyIptablesNatHook } from './IptablesNatHook';

export const iptablesCommand: LinuxCommand = {
  name: 'iptables',
  needsNetworkContext: true,
  usage: 'iptables [-t table] COMMAND [args...]',
  privilege: { satisfiedBy: Satisfy.root },
  run(ctx: LinuxCommandContext, args: string[]): string {
    applyIptablesNatHook(ctx.net, args);
    return ctx.executor.iptables.execute(args).output;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    applyIptablesNatHook(ctx.net, args);
    return Promise.resolve(ctx.executor.iptables.execute(args));
  },
};
