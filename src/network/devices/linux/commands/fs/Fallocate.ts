import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandExecutor } from '../../LinuxCommandExecutor';
import { parseTruncateSize } from './Truncate';

const FALLOCATE_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-l', aliases: ['--length'], dest: 'length', takesArg: true, argName: 'LEN', description: 'Specifies the length of the range, in bytes' },
  { flag: '-o', aliases: ['--offset'], dest: 'offset', takesArg: true, argName: 'OFF', description: 'Specifies the beginning offset of the range, in bytes' },
];

/**
 * `fallocate` reserve la place d'un fichier sans l'ecrire. La taille
 * passe par le meme joint que `truncate` et `dd` — `declaredSizeBytes` —
 * pour que `ls -l`, `du`, `stat` et `df` lisent un seul nombre.
 */
export function runFallocate(
  exec: LinuxCommandExecutor, args: string[],
): { output: string; exitCode: number } {
  let length: string | undefined;
  let offset = 0;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-l' || a === '--length') { length = args[++i]; continue; }
    if (a === '-o' || a === '--offset') { offset = parseTruncateSize(args[++i]) ?? 0; continue; }
    if (a.startsWith('--length=')) { length = a.slice(9); continue; }
    if (a.startsWith('-')) {
      return { output: `fallocate: unrecognized option '${a}'`, exitCode: 1 };
    }
    files.push(a);
  }

  if (length === undefined) {
    return { output: 'fallocate: no length argument specified', exitCode: 1 };
  }
  const size = parseTruncateSize(length);
  if (size === null) {
    return { output: `fallocate: invalid length value specified: ${length}`, exitCode: 1 };
  }
  if (files.length === 0) {
    return { output: 'fallocate: no filename specified', exitCode: 1 };
  }

  for (const p of files) {
    const abs = exec.vfs.normalizePath(p, exec.getCwd());
    exec.publishAuditFsAccess(abs, 'w', 'fallocate');
    exec.publishAuditSyscall('fallocate', abs);
    const ok = exec.vfs.writeFile(
      abs, exec.vfs.readFile(abs) ?? '',
      exec.userMgr.currentUid, exec.userMgr.currentGid, exec.getUmask(),
      false, offset + size,
    );
    if (!ok) {
      return { output: `fallocate: fallocate failed: No space left on device`, exitCode: 1 };
    }
  }
  return { output: '', exitCode: 0 };
}

export const fallocateCommand: LinuxCommand = {
  name: 'fallocate',
  package: 'util-linux',
  needsNetworkContext: false,
  usage: 'fallocate [-o OFFSET] -l LENGTH FILE...',
  options: FALLOCATE_OPTIONS,
  help: 'Preallocate or deallocate space to a file.',
  run: (ctx, args) => runFallocate(ctx.executor, args).output,
  runWithStatusSync: (ctx, args) => runFallocate(ctx.executor, args),
  runWithStatus: (ctx, args) => Promise.resolve(runFallocate(ctx.executor, args)),
};
