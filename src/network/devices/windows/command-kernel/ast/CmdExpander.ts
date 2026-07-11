import type { IExpander } from '@/command-kernel/ast/expander';
import type { Session } from '@/command-kernel/session/types';

/**
 * `%VAR%` expansion — reproduces `WindowsPC.expandEnvVars` exactly
 * (case-insensitive lookup uppercased, `%CD%` resolves to the live cwd,
 * an undefined variable is left untouched rather than erased). No `$`,
 * no `~`, no glob — cmd has none of those.
 */
export class CmdExpander implements IExpander {
  expand(word: string, session: Session): string[] {
    const result = word.replace(/%([^%]+)%/g, (match: string, name: string) => {
      const upper = name.toUpperCase();
      if (upper === 'CD') return session.cwd;
      return session.env.get(upper) ?? match;
    });
    return [result];
  }
}
