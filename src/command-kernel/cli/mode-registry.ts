import type { CliMode } from "./types";

/**
 * Table des modes d'un CLI vendeur donné. Un `CliInterpreter` en tient
 * une instance ; les commandes de transition (`enable`, `configure
 * terminal`, `exit`, `end`) la consultent via l'interpréteur pour valider
 * les push/pop.
 */
export class ModeRegistry {
  private readonly modes = new Map<string, CliMode>();

  private readonly execLevelOverride?: string;

  constructor(modes: readonly CliMode[], opts?: { execLevel?: string }) {
    for (const mode of modes) {
      if (this.modes.has(mode.name)) {
        throw new Error(`mode CLI déjà enregistré : ${mode.name}`);
      }
      this.modes.set(mode.name, mode);
    }
    if (opts?.execLevel !== undefined) {
      if (!this.modes.has(opts.execLevel)) {
        throw new Error(`ModeRegistry: execLevel inconnu "${opts.execLevel}"`);
      }
      this.execLevelOverride = opts.execLevel;
    }
  }

  get(name: string): CliMode {
    const mode = this.modes.get(name);
    if (!mode) throw new Error(`mode CLI inconnu : ${name}`);
    return mode;
  }

  has(name: string): boolean {
    return this.modes.has(name);
  }

  /** Le mode racine — le seul dont `parent === null`. La pile de la
   *  session ne descend jamais en-dessous. */
  root(): CliMode {
    const roots = [...this.modes.values()].filter((m) => m.parent === null);
    if (roots.length === 0) throw new Error('ModeRegistry: aucun mode racine défini');
    if (roots.length > 1) {
      throw new Error(`ModeRegistry: plusieurs modes racine (${roots.map((r) => r.name).join(', ')})`);
    }
    return roots[0];
  }

  /** Le mode d'exécution privilégié — cible de `end`/Ctrl-Z. Cisco :
   *  `privileged`. Huawei : `user-view` (= racine). Par défaut, la
   *  racine ; le vendeur override via l'option `execLevel` du
   *  constructeur. */
  execLevel(): CliMode {
    if (this.execLevelOverride) return this.get(this.execLevelOverride);
    return this.root();
  }

  all(): readonly CliMode[] {
    return [...this.modes.values()];
  }
}
