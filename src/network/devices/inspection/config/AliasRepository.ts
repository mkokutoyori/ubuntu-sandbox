/**
 * AliasRepository — config-driven CLI alias state (Lot C,
 * docs/DESIGN-DEVICE-STATE-INSPECTION.md).
 *
 * `alias <mode> <name> <command…>` creates a REAL, working alias:
 * typing the name actually expands to the command, and
 * `show aliases` projects this real state. Ships the genuine IOS
 * default exec aliases (real device identity, not fabricated data).
 */

export const ALIAS_MODE_VALUES = [
  { keyword: 'configure', description: 'Global configuration mode' },
  { keyword: 'exec', description: 'Exec mode' },
  { keyword: 'interface', description: 'Interface configuration mode' },
  { keyword: 'line', description: 'Line configuration mode' },
  { keyword: 'router', description: 'Router configuration mode' },
] as const;

export type AliasMode = typeof ALIAS_MODE_VALUES[number]['keyword'];

export function parseAliasMode(token: string): AliasMode | null {
  const bas = token.toLowerCase();
  const trouve = ALIAS_MODE_VALUES.find((v) => v.keyword === bas);
  return trouve ? trouve.keyword : null;
}

/**
 * Le mode d'alias qui gouverne le mode COURANT de la CLI, s'il y en a un.
 *
 * Les cinq modes d'`alias` ne sont pas les vingt-et-un modes de la
 * coquille : `configure` couvre la configuration globale, `interface`
 * couvre aussi une sous-interface, et les autres sous-modes n'ont
 * simplement pas d'alias sur IOS. Sans cette table, le mot etait RANGE
 * et jamais evalue — un alias pose en mode `interface` ne servait
 * nulle part, et c'est le critere accepte-mais-inerte que ce depot
 * refuse.
 */
export function aliasModeForCliMode(mode: string): AliasMode | null {
  if (mode === 'user' || mode === 'privileged') return 'exec';
  if (mode === 'config') return 'configure';
  if (mode === 'config-if' || mode === 'config-subif') return 'interface';
  if (mode === 'config-line') return 'line';
  if (mode === 'config-router') return 'router';
  return null;
}

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

  private defaultsRefused = false;

  private defaultExec(): ReadonlyArray<readonly [string, string]> {
    return this.defaultsRefused ? [] : DEFAULT_EXEC;
  }

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
   * `no alias <mode>` sans nom : IOS retire TOUT le mode, alias d'usine
   * compris. C'est meme la seule facon de se debarrasser de `p`, `s` ou
   * `w`, qui existent des l'allumage et qu'aucun `no alias exec p` ne
   * peut atteindre — ils ne sont pas dans le magasin des alias de
   * l'operateur. Le mode dont l'usine est ainsi refusee est retenu, sans
   * quoi `render()` les reafficherait aussitot.
   */
  removeMode(mode: AliasMode): void {
    this.user.delete(mode);
    if (mode === 'exec') this.defaultsRefused = true;
  }

  /**
   * Resolve `name` to its expansion for `mode` (user aliases take
   * precedence, then IOS defaults). Returns null if unknown.
   */
  resolve(mode: AliasMode, name: string): string | null {
    const u = this.user.get(mode)?.get(name);
    if (u !== undefined) return u;
    if (mode === 'exec') {
      const d = this.defaultExec().find(([k]) => k === name);
      if (d) return d[1];
    }
    return null;
  }

  /** `show aliases` projection — defaults + user aliases, by mode. */
  render(): string {
    const lines: string[] = [];
    const exec = new Map<string, string>(this.defaultExec());
    for (const [k, v] of this.user.get('exec') ?? []) exec.set(k, v);
    lines.push('Exec mode aliases:');
    for (const [k, v] of exec) lines.push(`  ${k.padEnd(20)}${v}`);
    for (const mode of ['configure', 'interface', 'line', 'router'] as AliasMode[]) {
      const m = this.user.get(mode);
      if (!m || m.size === 0) continue;
      lines.push(`${mode.charAt(0).toUpperCase() + mode.slice(1)} mode aliases:`);
      for (const [k, v] of m) lines.push(`  ${k.padEnd(20)}${v}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.user.clear();
    this.defaultsRefused = false;
  }

  snapshot(): Array<[AliasMode, Array<[string, string]>]> {
    const out: Array<[AliasMode, Array<[string, string]>]> = [];
    for (const [m, kv] of this.user) out.push([m, [...kv]]);
    return out;
  }

  restore(snap: Array<[AliasMode, Array<[string, string]>]>): void {
    this.user.clear();
    for (const [m, kv] of snap) this.user.set(m, new Map(kv));
  }

  toRunningConfig(): string[] {
    const lines: string[] = [];
    if (this.defaultsRefused) lines.push('no alias exec');
    for (const mode of
      ['exec', 'configure', 'interface', 'line', 'router'] as AliasMode[]) {
      const m = this.user.get(mode);
      if (!m) continue;
      for (const [name, cmd] of m) lines.push(`alias ${mode} ${name} ${cmd}`);
    }
    return lines;
  }
}
