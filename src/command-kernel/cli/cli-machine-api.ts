import type { ModeRegistry } from "./mode-registry";

/**
 * Capacité optionnelle `MachineApi.cli` — expose les modes au socle CLI
 * pour que les commandes de transition (`enable`, `configure terminal`,
 * `exit`, `end`) puissent valider et exécuter les changements de mode
 * sans dépendre d'un import direct de `ModeRegistry` (respect strict
 * du principe « MachineApi = seule source pour les commandes »).
 *
 * Une machine sans CLI vendeur (Linux, Windows) ne définit tout
 * simplement pas cette capacité.
 */
export interface CliMachineApi {
  /** Registre des modes du vendeur (Cisco IOS, Huawei VRP, switch…). */
  readonly modes: ModeRegistry;
}
