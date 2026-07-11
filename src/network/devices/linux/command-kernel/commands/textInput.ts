import { CommandContext } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';

export interface SplitLines {
  readonly lines: readonly string[];
  readonly hasTrailingNewline: boolean;
}

export function splitLines(content: string): SplitLines {
  const hasTrailingNewline = content.endsWith('\n');
  const lines = hasTrailingNewline ? content.slice(0, -1).split('\n') : content.split('\n');
  return { lines, hasTrailingNewline };
}

export function joinLines(selected: readonly string[], includesEnd: boolean, hasTrailingNewline: boolean): string {
  if (selected.length === 0) return '';
  const trailer = !includesEnd || hasTrailingNewline ? '\n' : '';
  return selected.join('\n') + trailer;
}

export async function readTextInput(ctx: CommandContext, files: readonly string[]): Promise<string> {
  if (files.length === 0) {
    return ctx.io.stdin.readAll();
  }
  const actor = toFileSystemActor(ctx.session.user);
  const parts: string[] = [];
  for (const file of files) {
    const path = ctx.machine.fs.resolve(ctx.session.cwd, file);
    parts.push(await ctx.machine.fs.readFile(path, actor));
  }
  return parts.join('');
}

export async function readPerFileInputs(
  ctx: CommandContext,
  files: readonly string[],
): Promise<Array<{ label: string; content: string }>> {
  if (files.length === 0) {
    return [{ label: '', content: await ctx.io.stdin.readAll() }];
  }
  const actor = toFileSystemActor(ctx.session.user);
  const out: Array<{ label: string; content: string }> = [];
  for (const file of files) {
    const path = ctx.machine.fs.resolve(ctx.session.cwd, file);
    out.push({ label: file, content: await ctx.machine.fs.readFile(path, actor) });
  }
  return out;
}
