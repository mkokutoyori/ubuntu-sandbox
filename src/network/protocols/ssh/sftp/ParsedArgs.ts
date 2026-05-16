/**
 * ParsedArgs — pure parser splitting CLI tokens into flags + positionals.
 *
 * Used by the SFTP sub-shell to honour BRD SFTP-12 (separate `-r/-l/-a` etc.
 * from path arguments) without scattering the logic across each command.
 *
 * Reference: BRD-SSH-SFTP.md SFTP-12 ; DESIGN-SSH-SFTP.md section 9.3.
 */

export class ParsedArgs {
  private constructor(
    /** Single-letter or word flags ("-r", "--recursive", "-la"). */
    public readonly flags: ReadonlySet<string>,
    /** Positional arguments in original order. */
    public readonly positional: readonly string[],
  ) {}

  static parse(tokens: readonly string[]): ParsedArgs {
    const flags = new Set<string>();
    const positional: string[] = [];
    for (const token of tokens) {
      if (token === '--') continue;
      if (token.startsWith('--') && token.length > 2) {
        flags.add(token.slice(2));
      } else if (token.startsWith('-') && token.length > 1) {
        // Each character after `-` is a separate flag (`-la` => `-l`,`-a`).
        for (const ch of token.slice(1)) flags.add(ch);
      } else {
        positional.push(token);
      }
    }
    return new ParsedArgs(flags, positional);
  }

  has(flag: string): boolean {
    return this.flags.has(flag);
  }
}
