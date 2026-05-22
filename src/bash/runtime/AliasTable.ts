/**
 * AliasTable — the backing store for the shell's `alias` / `unalias`
 * builtins and command-position alias expansion.
 *
 * An alias is a first-class shell notion: a name bound to a replacement
 * string that is substituted when the name appears as the first word of
 * a simple command. The table is per-shell state (like the environment
 * and the job table) — it is owned by the command executor and threaded
 * into every interpreter run so definitions persist across commands.
 */

/** A single shell alias — an immutable name → replacement binding. */
export class ShellAlias {
  constructor(
    /** The word that triggers the substitution. */
    readonly name: string,
    /** The replacement command text. */
    readonly value: string,
  ) {}

  /** The `alias`-builtin display form: `alias name='value'`. */
  format(): string {
    return `alias ${this.name}='${this.value.replace(/'/g, "'\\''")}'`;
  }

  /** The `alias name` display form (without the leading `alias `). */
  formatShort(): string {
    return `${this.name}='${this.value.replace(/'/g, "'\\''")}'`;
  }

  /** Tokenize the replacement into argv words (quote-aware). */
  tokens(): string[] {
    return tokenizeAliasValue(this.value);
  }

  /**
   * Bash re-expands the word following an alias whose value ends in a
   * blank — this exposes that property for the expander.
   */
  get expandsNextWord(): boolean {
    return /\s$/.test(this.value);
  }
}

/**
 * AliasTable — aggregate of {@link ShellAlias} bindings for one shell.
 *
 * Pure in-memory shell state: real bash never persists aliases to disk
 * (a user re-declares them from `~/.bashrc` on each login), so the table
 * deliberately has no filesystem projection.
 */
export class AliasTable {
  private readonly aliases = new Map<string, ShellAlias>();

  /** Define (or redefine) an alias. */
  define(name: string, value: string): void {
    this.aliases.set(name, new ShellAlias(name, value));
  }

  get(name: string): ShellAlias | undefined {
    return this.aliases.get(name);
  }

  has(name: string): boolean {
    return this.aliases.has(name);
  }

  /** Remove an alias — returns false when it was not defined. */
  remove(name: string): boolean {
    return this.aliases.delete(name);
  }

  /** Drop every alias (`unalias -a`). */
  clear(): void {
    this.aliases.clear();
  }

  /** Every alias, sorted by name (the order `alias` with no args prints). */
  list(): ShellAlias[] {
    return [...this.aliases.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get size(): number {
    return this.aliases.size;
  }

  /** A deep copy — used to snapshot per-session shell state. */
  clone(): AliasTable {
    const copy = new AliasTable();
    for (const a of this.aliases.values()) copy.define(a.name, a.value);
    return copy;
  }
}

/**
 * Split an alias replacement string into argv words, honouring single
 * and double quotes (the quotes themselves are stripped).
 */
export function tokenizeAliasValue(value: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let hasWord = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasWord = true; continue; }
    if (/\s/.test(ch)) {
      if (hasWord) { tokens.push(cur); cur = ''; hasWord = false; }
      continue;
    }
    cur += ch;
    hasWord = true;
  }
  if (hasWord) tokens.push(cur);
  return tokens;
}
