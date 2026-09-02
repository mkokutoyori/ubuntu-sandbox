import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const netplanCommand: LinuxCommand = {
  name: 'netplan',
  package: 'netplan.io',
  needsNetworkContext: true,
  usage: 'netplan [ apply | try | status ]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    const sub = args[0];
    if (sub === 'apply') {
      const { applied, warnings } = ctx.netConfig.applyNetplan(ctx.net);
      return [...warnings, ...(applied.length === 0 ? [] : [])].join('\n');
    }
    if (sub === 'try') {
      return ctx.netConfig.tryNetplan(ctx.net);
    }
    if (sub === 'status') {
      return ctx.netConfig.networkctlStatus(ctx.net);
    }
    if (sub === 'generate') {
      return '';
    }
    return `netplan: unrecognized command '${sub ?? ''}'\nAvailable commands: apply, try, status, generate`;
  },
};
