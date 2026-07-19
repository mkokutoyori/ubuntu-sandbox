import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { checkPwck } from '../../iam/PwGrCheck';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

function runChecked(ctx: LinuxCommandContext): { output: string; exitCode: number } {
  const result = checkPwck(ctx.executor.vfs);
  return { output: result.lines.join('\n'), exitCode: result.exitCode };
}

export const pwckCommand: LinuxCommand = {
  name: 'pwck',
  needsNetworkContext: true,
  usage: 'pwck [-r] [-q]',
  help: 'Verify integrity of /etc/passwd and /etc/shadow.',
  privilege: { satisfiedBy: Satisfy.root },
  run(ctx: LinuxCommandContext): string {
    return runChecked(ctx).output;
  },
  runWithStatusSync: (ctx: LinuxCommandContext) => runChecked(ctx),
  async runWithStatus(ctx: LinuxCommandContext) {
    return runChecked(ctx);
  },
};
