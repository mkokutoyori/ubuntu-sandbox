/**
 * LinuxCommand - Unit of simulation for a single Linux shell command.
 *
 * One file = one command. Each command is a plain object implementing this
 * interface. Commands are registered into a `LinuxCommandRegistry` which
 * dispatches them from `LinuxMachine.executeCommand()`.
 *
 * See `linux_gap.md` §7.2.
 */

import type { LinuxCommandContext } from './LinuxCommandContext';
import type { PrivilegeRequirement } from '../iam/policy/CommandPrivilegePolicy';

/**
 * Declarative specification of a single command-line option / flag.
 * Used to auto-generate `--help` and `man` output (via
 * `LinuxCommandHelp.renderHelp` / `renderManPage`).
 */
export interface LinuxCommandOption {
  /** The flag as typed on the command line (e.g. `-c`, `--verbose`). */
  readonly flag: string;

  /** Short human-readable description for help/man output. */
  readonly description: string;

  /** True if the flag consumes the next argument (e.g. `-c 5`). Default: false. */
  readonly takesArg?: boolean;

  /** Placeholder name for the argument (e.g. `count`, `ttl`). Required when `takesArg` is true. */
  readonly argName?: string;

  /** Other flag spellings that map to this same option (e.g. `--maxdays` for `-M`). */
  readonly aliases?: readonly string[];

  /**
   * Attribute name this option's value is stored under when parsed via
   * `mapArgsToAttributes` (see `LinuxCommandArgs.ts`). Defaults to `flag`
   * with its leading dashes stripped.
   */
  readonly dest?: string;
}

export interface LinuxCommand {
  /** Primary name as typed in the shell (first switch key). */
  readonly name: string;

  /** Optional aliases (e.g. `"ip6tables"` → handled by `"iptables"`). */
  readonly aliases?: readonly string[];

  /**
   * If true, the command needs access to the network kernel (ping,
   * traceroute, dhclient, ...) and must be routed directly by
   * `LinuxMachine`, bypassing the bash interpreter inside
   * `LinuxCommandExecutor`.
   *
   * If false, the command is a plain userspace command — the registry is
   * only used for documentation / introspection, and the bash interpreter
   * handles execution as usual.
   */
  readonly needsNetworkContext: boolean;

  /**
   * Declarative privilege requirement for this command (e.g. "must be
   * root"). When set, the registry dispatch path (`LinuxMachine`) checks it
   * before calling `run()`/`runWithStatus()`, and it doubles as the single
   * place to ask "does this command need sudo?" without invoking it —
   * e.g. for tab-completion hints or a command-listing audit.
   *
   * A single spec covers a blanket requirement ("always needs root"). For
   * a command whose privilege requirement differs by option/flag (e.g.
   * `mount` needs nothing to list mounts but root to mount something,
   * `dmesg` needs root only for `-c`/`-C`/`-n`), pass an array instead: each
   * entry's own `appliesWhen` scopes it to the invocations it governs, so
   * unrelated rules don't block each other. See `evaluatePrivilegeRequirement`.
   *
   * Commands not routed through the registry (still living in
   * `LinuxCommandExecutor`'s switch) keep declaring their privilege
   * requirement in `iam/policy/defaultCommandPrivileges.ts` instead, since
   * they have no `LinuxCommand` object to hang it off of.
   */
  readonly privilege?: PrivilegeRequirement;

  // ─── Documentation ──────────────────────────────────────────────

  /** One-line usage string. Shown by `--help` and in the SYNOPSIS of `man`. */
  readonly usage?: string;

  /** Multi-line description shown by `man <cmd>`. */
  readonly help?: string;

  /** Man section number (1 = user commands, 8 = admin commands). Default: 8. */
  readonly manSection?: number;

  /**
   * Declarative option specs, used to auto-generate help and man output.
   * When provided, `LinuxMachine` uses these instead of the raw `help`
   * string to render `--help` and `man <cmd>` output.
   */
  readonly options?: readonly LinuxCommandOption[];

  /**
   * Execute the command. May be synchronous or asynchronous (e.g. `ping`).
   *
   * Implementations MUST NOT import `EndHost`, `LinuxPC`, `LinuxServer` or
   * `LinuxMachine` directly. All machine state is accessed through the
   * narrow `LinuxCommandContext` passed here.
   */
  run(ctx: LinuxCommandContext, args: string[]): Promise<string> | string;

  /**
   * Optional status-aware execution used by the bash↔network bridge:
   * same behaviour as `run`, plus the command's real exit code so shell
   * conditionals (`if`, `&&`, `$?`) observe success/failure faithfully.
   */
  runWithStatus?(
    ctx: LinuxCommandContext,
    args: string[],
  ): Promise<{ output: string; exitCode: number; stderr?: string }>;

  /**
   * Synchronous counterpart to `runWithStatus`, for commands whose logic
   * has no genuine async step. `LinuxMachine`'s `_registryCommandHook` —
   * the bridge a *script-invoked* command runs through (as opposed to one
   * typed at the prompt, which goes through the async
   * `setNetworkCommandRunner` path and already honours `runWithStatus`) —
   * is itself synchronous and cannot await a Promise, so without this a
   * script calling a registry command with only `runWithStatus` always
   * observes exit code 0 regardless of the command's real outcome.
   */
  runWithStatusSync?(
    ctx: LinuxCommandContext,
    args: string[],
  ): { output: string; exitCode: number; stderr?: string };

  /**
   * Optional tab-completion callback. Called when the user presses TAB
   * while typing an argument to this command.
   *
   * @param ctx  same context passed to `run()`
   * @param args arguments typed so far; the last element is the partial
   *             word being completed (may be `''` when the user has just
   *             typed a space).
   * @returns    candidate completions matching the partial word. Return
   *             an empty array to fall back to default (path) completion.
   *
   * Implementations may return all candidates unfiltered — the caller
   * filters by `args[args.length - 1]` as a safety net.
   */
  complete?(ctx: LinuxCommandContext, args: string[]): string[];
}
