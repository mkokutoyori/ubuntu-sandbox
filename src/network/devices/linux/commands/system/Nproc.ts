import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const nprocCommand: LinuxCommand = {
  name: 'nproc',
  needsNetworkContext: true,
  usage: 'nproc',
  run(ctx: LinuxCommandContext): string {
    return String(ctx.executor.hardware.cpu.logicalCpus);
  },
};
