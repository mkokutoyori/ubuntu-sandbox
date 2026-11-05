import { COREUTILS_DOCS } from '../../coreutils/CoreutilsDocs';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const archCommand: LinuxCommand = {
  name: 'arch',
  needsNetworkContext: true,
  usage: 'arch',
  run(ctx: LinuxCommandContext, args: string[]): string {
    if (args[0] === '--help' || args[0] === '--version') return COREUTILS_DOCS.arch[args[0] === '--help' ? 'help' : 'version'];
    return ctx.executor.hardware.cpu.architecture;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return Promise.resolve({ output: this.run(ctx, args), exitCode: 0 });
  },
};
