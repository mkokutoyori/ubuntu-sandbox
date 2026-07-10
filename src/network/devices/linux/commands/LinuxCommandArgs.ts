/**
 * Declarative argument→attribute mapping for `LinuxCommand` implementations.
 *
 * Given the same `options` metadata a command already declares for
 * `--help`/`man` rendering (`LinuxCommandHelp.ts`), `mapArgsToAttributes`
 * walks the raw argv and produces a plain attribute bag plus the leftover
 * positional arguments — so commands don't each hand-roll their own
 * flag-parsing loop.
 */

import type { LinuxCommandOption } from './LinuxCommand';

export interface MappedArgs {
  readonly attrs: Record<string, string | boolean>;
  readonly positionals: string[];
}

function destOf(opt: LinuxCommandOption): string {
  return opt.dest ?? opt.flag.replace(/^-+/, '');
}

function findOption(options: readonly LinuxCommandOption[], arg: string): LinuxCommandOption | undefined {
  return options.find((o) => o.flag === arg || (o.aliases?.includes(arg) ?? false));
}

/**
 * Parse `args` against a command's declarative `options` array.
 *
 * - A flag matching `takesArg: true` consumes the following argv element
 *   as its string value.
 * - A flag matching `takesArg: false`/unset is stored as boolean `true`.
 * - Anything not matching a known flag is collected into `positionals`
 *   (in encounter order).
 */
export function mapArgsToAttributes(options: readonly LinuxCommandOption[], args: string[]): MappedArgs {
  const attrs: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const opt = findOption(options, arg);
    if (!opt) {
      positionals.push(arg);
      continue;
    }
    if (opt.takesArg) {
      attrs[destOf(opt)] = args[++i] ?? '';
    } else {
      attrs[destOf(opt)] = true;
    }
  }

  return { attrs, positionals };
}
