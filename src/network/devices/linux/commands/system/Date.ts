import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { runDate } from '../../coreutils/DateCommand';

function execute(ctx: LinuxCommandContext, args: string[], stdin?: string) {
  const executor = ctx.executor;
  const vfs = executor.vfs;
  const absolute = (name: string): string => vfs.normalizePath(name, executor.getCwd());
  const result = runDate(args, executor.localZone(), {
    nowMs: executor.simulatedDate().getTime(),
    mayStepClock: executor.userMgr.currentUid === 0,
    setClock: (epochMs) => executor.setSystemTime(epochMs),
    fileMtimeMs: (name) => vfs.resolveInode(absolute(name))?.mtime ?? null,
    readLines: (name) => {
      const text = name === '-' ? (stdin ?? '') : vfs.readFile(absolute(name));
      if (text === null) return null;
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines;
    },
  });
  return { output: result.stdout, exitCode: result.exitCode, stderr: result.stderr, interleaved: result.interleaved };
}

export const dateCommand: LinuxCommand = {
  name: 'date',
  needsNetworkContext: true,
  readsStdin: true,
  usage: 'date [-d DATESPEC] [-s DATESPEC] [-u] [+FORMAT]',
  run: (ctx, args, stdin) => execute(ctx, args, stdin).output,
  runWithStatusSync: execute,
  runWithStatus: (ctx, args, stdin) => Promise.resolve(execute(ctx, args, stdin)),
};
