import type { LinuxCommand } from '../LinuxCommand';
import { runAulastlog } from '../../audit/tools/AulastlogTool';
import { auditLoginHost } from '../../audit/tools/LinuxAuditToolHost';

export const aulastlogCommand: LinuxCommand = {
  name: 'aulastlog',
  needsNetworkContext: false,
  usage: 'aulastlog [options]',
  options: [],
  readsStdin: true,
  run: (ctx, args, stdin) => {
    const result = runAulastlog(auditLoginHost(ctx.executor), args, stdin ?? null);
    return result.stdout + result.stderr;
  },
  runWithStatus: (ctx, args, stdin) => {
    const result = runAulastlog(auditLoginHost(ctx.executor), args, stdin ?? null);
    return Promise.resolve({ output: result.stdout, exitCode: result.exitCode, stderr: result.stderr, interleaved: result.interleaved });
  },
};
