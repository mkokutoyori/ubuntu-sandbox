/**
 * CommandAliasTable — vendor-neutral CLI alias store.
 *
 * On Huawei VRP, `command-alias alias <name> <command…>` registers an
 * exec-mode shortcut that expands the leading word of an input line
 * to a longer command. `command-alias enable / disable` toggles the
 * whole feature.
 *
 * The table also fits Cisco IOS' `alias exec / config` directives the
 * same way — both vendors share this model so the per-vendor shells
 * and outbound SSH dispatchers can call resolve() without re-coding
 * the substitution rule.
 */

export class CommandAliasTable {
  private enabled = true;
  private readonly byHead = new Map<string, string>();

  enable(): void  { this.enabled = true; }
  disable(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }

  add(head: string, expansion: string): void {
    this.byHead.set(head.toLowerCase(), expansion);
  }

  remove(head: string): boolean {
    return this.byHead.delete(head.toLowerCase());
  }

  /** Resolve the head of a command line; returns the expansion or null. */
  resolve(head: string): string | null {
    if (!this.enabled) return null;
    return this.byHead.get(head.toLowerCase()) ?? null;
  }

  /** Expand a full command line — leading word only, like real VRP/IOS. */
  expand(line: string): string {
    if (!this.enabled) return line;
    const sp = line.indexOf(' ');
    const head = sp === -1 ? line : line.slice(0, sp);
    const expansion = this.byHead.get(head.toLowerCase());
    if (!expansion) return line;
    return sp === -1 ? expansion : expansion + line.slice(sp);
  }

  entries(): readonly { head: string; expansion: string }[] {
    return Array.from(this.byHead.entries()).map(([h, e]) =>
      Object.freeze({ head: h, expansion: e }),
    );
  }

  clear(): void { this.byHead.clear(); }
}
