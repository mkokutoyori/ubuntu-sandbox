import type { ModeRegistry } from "./mode-registry";
import type { CliSession } from "./types";

/**
 * Construction de l'invite CLI à partir du mode courant : `<hostname>`
 * + suffixe défini par `CliMode.promptSuffix` (fixe ou fonction). Le
 * modèle est le même quel que soit le vendeur — seuls les modes/
 * suffixes changent.
 *
 * Cisco : `Router>` (user) → `Router#` (privileged) → `Router(config)#`
 *         → `Router(config-if)#`
 * Huawei : `<Router>` (user-view) → `[Router]` (system-view) →
 *          `[Router-GigabitEthernet0/0/0]` (interface-view)
 */
export class CliPromptBuilder {
  constructor(
    private readonly modes: ModeRegistry,
    private readonly hostname: () => string,
  ) {}

  build(session: CliSession): string {
    const current = session.modeStack[session.modeStack.length - 1];
    const mode = this.modes.get(current);
    return mode.prompt(session, this.hostname());
  }
}
