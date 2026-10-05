import type { WinFileCommandContext } from './WinFileCommands';

export async function askLine(
  ctx: WinFileCommandContext, output: string[], text: string,
): Promise<string | null> {
  const preceding = output.length > 0 ? output.splice(0).join('\n') : undefined;
  const asked = await ctx.ask(text, preceding);
  if (!asked.flushed) output.push(...(preceding === undefined ? [] : [preceding]), text);
  return asked.answer;
}
