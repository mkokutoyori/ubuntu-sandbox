import { CommandContext, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileSystemError } from '@/command-kernel/errors';

/**
 * cmd.exe prints filesystem errors bare, with no "cmd: " prefix — unlike
 * Executor's automatic ShellError formatting (a bash convention). Every
 * migrated cmd file command catches `FileSystemError` itself and reports it
 * through this helper instead of letting it escape uncaught, which would
 * pick up the bash-style prefix.
 */
export async function reportLegacyFsError(ctx: CommandContext, err: unknown): Promise<ExitCode> {
  if (err instanceof FileSystemError) {
    await ctx.io.stdout.write(`${err.message}\n`);
    return EXIT_OK;
  }
  throw err;
}
