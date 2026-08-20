import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const archCommand: LinuxCommand = {
  name: 'arch',
  needsNetworkContext: true,
  usage: 'arch',
  run(ctx: LinuxCommandContext, args: string[]): string {
    if (args.length > 0) return `arch: extra operand '${args[0]}'`;
    return ctx.executor.hardware.cpu.architecture;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    if (args.length > 0) return Promise.resolve({ output: `arch: extra operand '${args[0]}'`, exitCode: 1 });
    return Promise.resolve({ output: ctx.executor.hardware.cpu.architecture, exitCode: 0 });
  },
};
