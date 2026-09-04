import { AAA_COMMAND_LEVEL_RANGE } from './CiscoSecurityCommands';

export type LineMethodListVerdict =
  | { tail: string }
  | { at: string }
  | { incomplete: true };

export function parseLineMethodList(
  args: readonly string[], kinds: readonly string[],
): LineMethodListVerdict {
  const kind = args[0];
  if (kind === undefined) return { incomplete: true };
  if (!kinds.includes(kind.toLowerCase())) return { at: kind };

  const words: string[] = [kind.toLowerCase()];
  let next = 1;
  if (kind.toLowerCase() === 'commands') {
    const level = args[1];
    if (level === undefined) return { incomplete: true };
    if (!/^\d+$/.test(level)) return { at: level };
    const value = Number(level);
    const [low, high] = AAA_COMMAND_LEVEL_RANGE;
    if (value < low || value > high) return { at: level };
    words.push(String(value));
    next = 2;
  }

  const list = args[next];
  if (list === undefined) return { incomplete: true };
  if (args[next + 1] !== undefined) return { at: args[next + 1] };
  words.push(list);
  return { tail: words.join(' ') };
}
