/**
 * AliasRepository — config-driven CLI alias state (Lot C,
 * docs/DESIGN-DEVICE-STATE-INSPECTION.md).
 *
 * `alias <mode> <name> <command…>` creates a REAL, working alias:
 * typing the name actually expands to the command, and
 * `show aliases` projects this real state. Ships the genuine IOS
 * default exec aliases (real device identity, not fabricated data).
 */

/** IOS CLI modes that support aliases (subset we model). */
export type AliasMode = 'exec' | 'configure' | 'interface' | 'router';

/** Real Cisco IOS built-in exec aliases. */
const DEFAULT_EXEC: ReadonlyArray<[string, string]> = [
  ['h', 'help'],
  ['lo', 'logout'],
  ['p', 'ping'],
  ['r', 'resume'],
  ['s', 'show'],
  ['u', 'undebug'],
  ['un', 'undebug'],
  ['w', 'where'],
];

export class AliasRepository {
  /** mode → (alias name → expansion). User aliases only. */
  private readonly user = new Map<AliasMode, Map<string, string>>();

  /** Define or overwrite an alias. */
  set(mode: AliasMode, name: string, command: string): void {
    if (!this.user.has(mode)) this.user.set(mode, new Map());
    this.user.get(mode)!.set(name, command);
  }

  /** Remove a user alias. Returns true if it existed. */
  remove(mode: AliasMode, name: string): boolean {
    return this.user.get(mode)?.delete(name) ?? false;
  }

  /**
   * Resolve `name` to its expansion for `mode` (user aliases take
   * precedence, then IOS defaults). Returns null if unknown.
   */
  resolve(mode: AliasMode, name: string): string | null {
    const u = this.user.get(mode)?.get(name);
    if (u !== undefined) return u;
    if (mode === 'exec') {
      const d = DEFAULT_EXEC.find(([k]) => k === name);
      if (d) return d[1];
    }
    return null;
  }

  /** `show aliases` projection — defaults + user aliases, by mode. */
  render(): string {
    const lines: string[] = [];
    const exec = new Map<string, string>(DEFAULT_EXEC);
    for (const [k, v] of this.user.get('exec') ?? []) exec.set(k, v);
    lines.push('Exec mode aliases:');
    for (const [k, v] of exec) lines.push(`  ${k.padEnd(20)}${v}`);
    for (const mode of ['configure', 'interface', 'router'] as AliasMode[]) {
      const m = this.user.get(mode);
      if (!m || m.size === 0) continue;
      lines.push(`${mode.charAt(0).toUpperCase() + mode.slice(1)} mode aliases:`);
      for (const [k, v] of m) lines.push(`  ${k.padEnd(20)}${v}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.user.clear();
  }
}
