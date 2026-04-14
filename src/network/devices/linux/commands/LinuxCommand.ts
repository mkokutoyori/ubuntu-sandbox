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

  /**
   * Execute the command. May be synchronous or asynchronous (e.g. `ping`).
   *
   * Implementations MUST NOT import `EndHost`, `LinuxPC`, `LinuxServer` or
   * `LinuxMachine` directly. All machine state is accessed through the
   * narrow `LinuxCommandContext` passed here.
   */
  run(ctx: LinuxCommandContext, args: string[]): Promise<string> | string;
}
