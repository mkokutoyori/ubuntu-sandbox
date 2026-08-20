import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { cmdChown } from '../../LinuxPermCommands';
import { Satisfy, Deny } from '../../iam/policy/CommandPrivilegePolicy';

const CHOWN_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-R', aliases: ['--recursive'], dest: 'recursive', description: 'Operate on files and directories recursively' },
  { flag: '-v', aliases: ['--verbose'], dest: 'verbose', description: 'Output a diagnostic for every file processed' },
  { flag: '-c', aliases: ['--changes'], dest: 'changes', description: 'Like verbose, but report only when a change is made' },
  { flag: '-f', aliases: ['--silent', '--quiet'], dest: 'silent', description: 'Suppress most error messages' },
  { flag: '--reference', dest: 'reference', takesArg: true, argName: 'RFILE', description: 'Use RFILE\'s owner and group instead of specifying values' },
  { flag: '-h', aliases: ['--no-dereference'], dest: 'noDereference', description: "Affect a symbolic link's own owner, not the file it points to" },
];

function run(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  const cwd = ctx.executor.ctx().cwd;
  for (const p of args.filter((a) => !a.startsWith('-') && !a.includes(':') && a.startsWith('/'))) {
    const abs = ctx.executor.vfs.normalizePath(p, cwd);
    ctx.executor.publishAuditFsAccess(abs, 'a', 'chown');
    ctx.executor.publishAuditSyscall('chown', abs);
  }
  const out = cmdChown(ctx.executor.ctx(), args);
  return { output: out, exitCode: out.startsWith('chown:') ? 1 : 0 };
}

export const chownCommand: LinuxCommand = {
  name: 'chown',
  needsNetworkContext: false,
  usage: 'chown [OWNER][:GROUP] FILE...',
  options: CHOWN_OPTIONS,
  privilege: { satisfiedBy: Satisfy.rootOrGroup('sudo', 'wheel'), deny: Deny.operationNotPermitted },
  run: (ctx, args) => run(ctx, args).output,
  runWithStatus: (ctx, args) => Promise.resolve(run(ctx, args)),
};
