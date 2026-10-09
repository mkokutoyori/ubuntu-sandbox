import type { LinuxCommand } from '../LinuxCommand';
import { runAulast } from '../../audit/tools/AulastTool';
import { auditLoginHost } from '../../audit/tools/LinuxAuditToolHost';

export const aulastCommand: LinuxCommand = {
  name: 'aulast',
  needsNetworkContext: false,
  usage: 'aulast [options]',
  options: [],
  readsStdin: true,
  run: (ctx, args, stdin) => {
    const result = runAulast(auditLoginHost(ctx.executor), args, stdin ?? null);
    return result.stdout + result.stderr;
  },
  runWithStatus: (ctx, args, stdin) => {
    const result = runAulast(auditLoginHost(ctx.executor), args, stdin ?? null);
    return Promise.resolve({ output: result.stdout, exitCode: result.exitCode, stderr: result.stderr, interleaved: result.interleaved });
  },
};
