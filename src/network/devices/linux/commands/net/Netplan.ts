import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

function runNetplan(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  const sub = args[0];
  if (sub === 'apply') {
    const { warnings, failed } = ctx.netConfig.applyNetplan(ctx.net);
    return { output: warnings.join('\n'), exitCode: failed ? 1 : 0 };
  }
  if (sub === 'try') return { output: ctx.netConfig.tryNetplan(ctx.net), exitCode: 0 };
  if (sub === 'status') return { output: ctx.netConfig.networkctlStatus(ctx.net), exitCode: 0 };
  if (sub === 'generate') return { output: '', exitCode: 0 };
  return { output: `netplan: unrecognized command '${sub ?? ''}'\nAvailable commands: apply, try, status, generate`, exitCode: 1 };
}

export const netplanCommand: LinuxCommand = {
  name: 'netplan',
  package: 'netplan.io',
  needsNetworkContext: true,
  usage: 'netplan [ apply | try | status ]',
  runWithStatusSync: (ctx, args) => runNetplan(ctx, args),
  run: (ctx, args) => runNetplan(ctx, args).output,
};
