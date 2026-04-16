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

  // ─── Documentation ──────────────────────────────────────────────

  /** One-line usage string. Shown by `--help` and in the SYNOPSIS of `man`. */
  readonly usage?: string;

  /** Multi-line description shown by `man <cmd>`. */
  readonly help?: string;

  /** Man section number (1 = user commands, 8 = admin commands). Default: 8. */
  readonly manSection?: number;

  /**
   * Execute the command. May be synchronous or asynchronous (e.g. `ping`).
   *
   * Implementations MUST NOT import `EndHost`, `LinuxPC`, `LinuxServer` or
   * `LinuxMachine` directly. All machine state is accessed through the
   * narrow `LinuxCommandContext` passed here.
   */
  run(ctx: LinuxCommandContext, args: string[]): Promise<string> | string;

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
