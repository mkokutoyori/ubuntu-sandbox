/**
 * DoskeyTable — Windows cmd.exe doskey macros.
 *
 * `doskey ll=dir /a $*` installs a macro that expands `ll` (and any
 * subsequent args) into `dir /a <args>`. `$*` is the placeholder for
 * all remaining argv tokens. Macros are case-insensitive on the head
 * keyword (cmd.exe behaviour).
 */

export class DoskeyTable {
  private readonly macros = new Map<string, string>();

  /** Parse a `doskey NAME=BODY` definition and register it. */
  define(rawArg: string): boolean {
    const eq = rawArg.indexOf('=');
    if (eq <= 0) return false;
    const head = rawArg.slice(0, eq).trim().toLowerCase();
    const body = rawArg.slice(eq + 1).trim();
    if (!head) return false;
    if (!body) { this.macros.delete(head); return true; }
    this.macros.set(head, body);
    return true;
  }

  resolve(head: string): string | null {
    return this.macros.get(head.toLowerCase()) ?? null;
  }

  /** Expand the leading word of a command line, substituting $*, $1-$9. */
  expand(line: string): string {
    const sp = line.indexOf(' ');
    const head = sp === -1 ? line : line.slice(0, sp);
    const macro = this.macros.get(head.toLowerCase());
    if (!macro) return line;
    const rest = sp === -1 ? '' : line.slice(sp + 1);
    const tokens = rest.length === 0 ? [] : rest.split(/\s+/);
    let expanded = macro.replace(/\$\*/g, rest);
    for (let i = 1; i <= 9; i++) {
      expanded = expanded.replace(new RegExp(`\\$${i}`, 'g'), tokens[i - 1] ?? '');
    }
    return expanded;
  }

  clear(): void { this.macros.clear(); }
  entries(): readonly { head: string; body: string }[] {
    return Array.from(this.macros.entries()).map(([head, body]) =>
      Object.freeze({ head, body }),
    );
  }
}
