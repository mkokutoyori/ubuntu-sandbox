import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { checkGrpck } from '../../iam/PwGrCheck';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

function runChecked(ctx: LinuxCommandContext): { output: string; exitCode: number } {
  const result = checkGrpck(ctx.executor.vfs);
  return { output: result.lines.join('\n'), exitCode: result.exitCode };
}

export const grpckCommand: LinuxCommand = {
  name: 'grpck',
  needsNetworkContext: true,
  usage: 'grpck [-r] [-q]',
  help: 'Verify integrity of /etc/group and /etc/gshadow.',
  privilege: { satisfiedBy: Satisfy.root },
  run(ctx: LinuxCommandContext): string {
    return runChecked(ctx).output;
  },
  runWithStatusSync: (ctx: LinuxCommandContext) => runChecked(ctx),
  async runWithStatus(ctx: LinuxCommandContext) {
    return runChecked(ctx);
  },
};
