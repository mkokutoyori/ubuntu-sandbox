import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { checkSudoersFile } from '../../iam/PwGrCheck';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

function targetPath(args: string[]): string {
  const fIdx = args.indexOf('-f');
  if (fIdx !== -1 && args[fIdx + 1]) return args[fIdx + 1];
  return '/etc/sudoers';
}

/**
 * Interactive `visudo` (no `-c`) is handled before this ever runs, by
 * `LinuxTerminalSession.tryVisudoEdit()` — it opens a real editor on a
 * temp copy of the target and only installs it once validated. That
 * interception only exists in the interactive terminal UI; this
 * fallback covers everywhere else a command can run headless (a bash
 * script, an SSH exec, a unit test driving `executeCommand` directly) —
 * exactly where real visudo would also have no TTY to edit through.
 */
function runChecked(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  if (!args.includes('-c')) {
    return {
      output: 'visudo: no terminal available for interactive editing; use -c to check syntax',
      exitCode: 1,
    };
  }
  const result = checkSudoersFile(ctx.executor.vfs, targetPath(args));
  return { output: result.lines.join('\n'), exitCode: result.exitCode };
}

export const visudoCommand: LinuxCommand = {
  name: 'visudo',
  needsNetworkContext: true,
  usage: 'visudo [-c] [-f file]',
  help: 'Edit or check the sudoers file(s) safely.',
  privilege: { satisfiedBy: Satisfy.root },
  run(ctx: LinuxCommandContext, args: string[]): string {
    return runChecked(ctx, args).output;
  },
  runWithStatusSync: (ctx: LinuxCommandContext, args: string[]) => runChecked(ctx, args),
  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return runChecked(ctx, args);
  },
};
