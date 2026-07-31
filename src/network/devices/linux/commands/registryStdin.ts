import type { LinuxCommand } from './LinuxCommand';

/**
 * Route piped content to a registry command the way that command asked for.
 *
 * The bash interpreter hands standard input to an external command twice
 * over: appended to `argv` as a trailing word (the historical convention,
 * which every switch-based command still reads) and, since `ExternalRequest`
 * gained a `stdin` field, as the content itself. The two bridges into the
 * registry — `_registryCommandHook` and the network command runner — call
 * this to reconcile them:
 *
 * - a command declaring `readsStdin` gets the content on the `stdin`
 *   parameter, and the duplicate trailing word is removed from its argv;
 * - a command that doesn't gets exactly what it got before this existed —
 *   the trailing word, and no `stdin` parameter.
 *
 * The two bridges reach here with argv in different shapes (one has already
 * popped the trailing word, the other has not), which is why the trailing
 * word is compared rather than assumed present.
 */
export function splitRegistryStdin(
  cmd: LinuxCommand,
  args: string[],
  stdin?: string,
): { argv: string[]; input?: string } {
  if (stdin === undefined) return { argv: args };
  const trailing = args.length > 0 && args[args.length - 1] === stdin;
  if (cmd.readsStdin) {
    return { argv: trailing ? args.slice(0, -1) : args, input: stdin };
  }
  return { argv: trailing ? args : [...args, stdin] };
}
