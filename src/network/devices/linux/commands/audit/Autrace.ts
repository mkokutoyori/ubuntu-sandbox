import type { LinuxCommand } from '../LinuxCommand';

export const autraceCommand: LinuxCommand = {
  name: 'autrace',
  needsNetworkContext: false,
  usage: 'autrace [-r] program',
  options: [
    { flag: '-r', dest: 'threat', description: 'Trace only the system calls that matter for a threat analysis' },
  ],
  run: (ctx, args) => ctx.executor.handleAutrace(args).output,
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.handleAutrace(args)),
};
