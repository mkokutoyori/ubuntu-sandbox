import type { LinuxCommand } from '../LinuxCommand';
import { runAusyscall } from '../../audit/tools/AusyscallTool';

export const ausyscallCommand: LinuxCommand = {
  name: 'ausyscall',
  needsNetworkContext: false,
  usage: 'ausyscall [arch] name | number | --dump | --exact',
  options: [
    { flag: '--dump', dest: 'dump', description: 'Dump the whole syscall table of the architecture' },
    { flag: '--exact', dest: 'exact', description: 'Look the name up exactly instead of searching for a substring' },
  ],
  run: (ctx, args) => {
    const result = runAusyscall({ machine: () => ctx.executor.identity.kernel.machine }, args);
    return result.stdout + result.stderr;
  },
  runWithStatus: (ctx, args) => {
    const result = runAusyscall({ machine: () => ctx.executor.identity.kernel.machine }, args);
    return Promise.resolve({ output: result.stdout, exitCode: result.exitCode, stderr: result.stderr, interleaved: result.interleaved });
  },
};
