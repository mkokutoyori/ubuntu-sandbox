/**
 * LinuxCommandRegistry - Lookup table for `LinuxCommand` implementations.
 *
 * Responsible for:
 *   - name + alias registration;
 *   - detecting whether a shell line contains a network-routed command
 *     (so that `LinuxMachine` can bypass the bash interpreter when
 *     necessary);
 *   - exposing a read-only view for introspection/tests.
 *
 * See `linux_gap.md` §7.4.
 */

import type { LinuxCommand } from './LinuxCommand';

export class LinuxCommandRegistry {
  private readonly cmds = new Map<string, LinuxCommand>();

  /** Register a command (and all its aliases). Last registration wins. */
  register(cmd: LinuxCommand): void {
    this.cmds.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.cmds.set(alias, cmd);
      }
    }
  }

  /** Register every command in `cmds`. */
  registerAll(cmds: readonly LinuxCommand[]): void {
    for (const c of cmds) this.register(c);
  }

  /** Look up a command by name or alias. */
  get(name: string): LinuxCommand | undefined {
    return this.cmds.get(name);
  }

  /** Has any command been registered under this name? */
  has(name: string): boolean {
    return this.cmds.has(name);
  }

  /**
   * True if `line` contains, anywhere in its tokens, a command whose
   * `needsNetworkContext` flag is set. Used by `LinuxMachine.executeCommand`
   * to decide whether to route through the network dispatcher or hand the
   * whole line to the bash interpreter.
   *
   * The split mirrors the one currently used by
   * `LinuxPC.containsNetworkCommand()`.
   */
  hasNetworkCommandIn(line: string): boolean {
    const words = line.split(/[\s;|&]+/);
    for (const w of words) {
      const cmd = this.cmds.get(w);
      if (cmd && cmd.needsNetworkContext) return true;
    }
    return false;
  }

  /** Read-only view over the unique set of registered commands. */
  list(): readonly LinuxCommand[] {
    const unique = new Set<LinuxCommand>();
    for (const c of this.cmds.values()) unique.add(c);
    return Array.from(unique);
  }

  /** Number of unique commands (names + aliases point to the same cmd). */
  size(): number {
    return this.list().length;
  }
}
