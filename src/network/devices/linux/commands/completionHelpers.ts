import type { LinuxCommand } from './LinuxCommand';
import type { LinuxCommandContext } from './LinuxCommandContext';

type CompleteFn = NonNullable<LinuxCommand['complete']>;

export interface ArgCompletionSpec {
  readonly flags?: readonly string[];
  readonly firstWords?: readonly string[];
  readonly wordsAfter?: Readonly<Record<string, readonly string[]>>;
  readonly interfacesAfter?: readonly string[];
  readonly hostsAtBarePosition?: boolean;
}

function interfaceNames(ctx: LinuxCommandContext): string[] {
  return Array.from(ctx.net.getPorts().keys());
}

function knownHosts(ctx: LinuxCommandContext): string[] {
  return Array.from(ctx.net.getArpTable().keys());
}

export function makeArgCompleter(spec: ArgCompletionSpec): CompleteFn {
  return (ctx: LinuxCommandContext, args: string[]): string[] => {
    const partial = args[args.length - 1] ?? '';
    const prev = args.length >= 2 ? (args[args.length - 2] ?? '') : '';

    if (spec.interfacesAfter?.includes(prev)) {
      return interfaceNames(ctx).filter((n) => n.startsWith(partial));
    }
    const wordsForPrev = spec.wordsAfter?.[prev];
    if (wordsForPrev) {
      return wordsForPrev.filter((w) => w.startsWith(partial));
    }
    if (partial.startsWith('-') && spec.flags) {
      return spec.flags.filter((f) => f.startsWith(partial));
    }
    if (args.length === 1 && spec.firstWords) {
      return spec.firstWords.filter((w) => w.startsWith(partial));
    }
    if (spec.hostsAtBarePosition && !partial.startsWith('-')) {
      return knownHosts(ctx).filter((h) => h.startsWith(partial));
    }
    return [];
  };
}
