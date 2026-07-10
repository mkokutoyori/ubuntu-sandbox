import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const timedatectlCommand: LinuxCommand = {
  name: 'timedatectl',
  needsNetworkContext: true,
  usage: 'timedatectl',
  run(ctx: LinuxCommandContext): string {
    return ctx.executor.identity.toTimedatectl();
  },
};
