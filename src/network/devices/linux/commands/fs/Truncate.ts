/**
 * `truncate` — set a file's size.
 *
 * `-s` used to be parsed out of the argument list inside
 * `LinuxCommandExecutor`'s switch and then IGNORED, so `truncate -s 1G
 * big` created an empty file. That left the simulator with no way at all
 * to occupy space, which is how an operator actually fills a disk — and
 * therefore no way to stage docs/PRD-Pannes.md §F9.1.
 *
 * The size is carried by `writeFile`'s `declaredSizeBytes`, the same seam
 * RMAN already uses for backup pieces whose logical size dwarfs the
 * placeholder actually stored: `ls -l`, `du`, `stat` and `df` all read
 * `inode.size`, so one number serves every reader.
 */

import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandExecutor } from '../../LinuxCommandExecutor';
import { asDispatch } from '../../coreutils/CoreutilsKit';
import { runTruncate as runTruncateCommand } from '../../coreutils/TruncateCommand';

const TRUNCATE_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-s', aliases: ['--size'], dest: 'size', takesArg: true, argName: 'SIZE', description: 'Set or adjust the file size to SIZE bytes' },
  { flag: '-c', aliases: ['--no-create'], dest: 'noCreate', description: 'Do not create any files' },
];

/**
 * A `-s` size with coreutils' own suffixes: K/M/G/T are its 1024-based
 * units, KB/MB/GB/TB its 1000-based ones, a bare number is bytes.
 */
export function parseTruncateSize(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(kb|mb|gb|tb|k|m|g|t)?$/i.exec(raw.trim());
  if (!m) return null;
  const factor: Record<string, number> = {
    '': 1,
    k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4,
    kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
  };
  return Math.round(parseFloat(m[1]) * factor[(m[2] ?? '').toLowerCase()]);
}

/**
 * The single implementation, taking the executor directly so the
 * `LinuxCommand` below and `LinuxCommandExecutor`'s own dispatch call the
 * same code — a userspace command is documented by the registry but still
 * executed from the switch, so the two must not be able to drift.
 */
export function runTruncate(
  exec: LinuxCommandExecutor, args: string[],
): { output: string; exitCode: number; stderr?: string; interleaved?: string } {
  return asDispatch(runTruncateCommand(exec.ctx(), args, (abs) => {
    exec.publishAuditFsAccess(abs, 'w', 'truncate');
    exec.publishAuditSyscall('truncate', abs);
  }));
}

export const truncateCommand: LinuxCommand = {
  name: 'truncate',
  needsNetworkContext: false,
  usage: 'truncate -s SIZE FILE...',
  options: TRUNCATE_OPTIONS,
  run: (ctx, args) => runTruncate(ctx.executor, args).output,
  runWithStatusSync: (ctx, args) => runTruncate(ctx.executor, args),
  runWithStatus: (ctx, args) => Promise.resolve(runTruncate(ctx.executor, args)),
};
