import type { CommandRegistry } from "../registry/command-registry";
import type { ICommand } from "../command/types";
import type { Session } from "../session/types";

/**
 * =====================================================================
 *  SOCLE CLI VENDEUR — types
 * =====================================================================
 *
 *  Extension du socle `command-kernel` pour les CLI vendeur (Cisco IOS,
 *  Huawei VRP, switches, firewalls) — qui diffèrent structurellement des
 *  shells POSIX/cmd.exe :
 *
 *   - Modes hiérarchiques (user → privileged → config → config-if…)
 *     avec transitions explicites (`enable`, `configure terminal`,
 *     `exit`, `end`) ; chaque mode définit son propre invite ET son
 *     propre sous-registre de commandes.
 *   - Grammaire réduite : pas de `&&`/`||`/`;`, pas de vraies
 *     redirections, pas d'expansion `$VAR`. Uniquement un filtre pipe
 *     terminal `| include|exclude|section <regex>`.
 *   - Abréviations préfixe-unique (`sh ver` = `show version`) résolues
 *     par l'interpréteur, pas par les commandes.
 *   - Commandes composites hiérarchiques : `show ip route ospf` est un
 *     chemin dans une arborescence de sous-registres — chaque niveau
 *     est une vraie commande avec son propre descripteur (args/options
 *     typés, privilèges), pour que l'auto-complétion future s'appuie
 *     dessus sans deviner.
 *
 *  Le moteur d'exécution (`Executor`), la garde de privilèges
 *  (`PermissionGuard`), le parser d'arguments (`ArgumentParser`), le
 *  registre (`CommandRegistry`) et la façade `MachineApi` sont
 *  réutilisés tels quels — le socle CLI est une couche AU-DESSUS,
 *  jamais une réécriture parallèle.
 */

/**
 * Un mode CLI : identité, invite et sous-registre propres. Le mode
 * courant vit sur la `CliSession` (pile de modes), l'interpréteur
 * consulte `registry` pour résoudre la ligne.
 */
export interface CliMode {
  /** Identifiant stable du mode (`'user'`, `'privileged'`, `'config'`…). */
  readonly name: string;
  /** Rendu complet de l'invite pour ce mode — le vendeur décide tout
   *  (préfixe, suffixe, symboles). Le hostname et la session sont
   *  fournis pour interpolation.
   *
   *  Cisco : `(session, host) => `${host}>` ` (user)
   *  Cisco : `(session, host) => `${host}(config-if)#` `
   *  Huawei : `(session, host) => `<${host}>` ` (user-view)
   *  Huawei : `(session, host) => `[${host}]` ` (system-view) */
  readonly prompt: (session: CliSession, hostname: string) => string;
  /** Mode parent : consulté par `exit`/`quit` pour remonter d'un cran.
   *  `null` = mode racine (au sommet de la pile). */
  readonly parent: string | null;
  /** Registre des commandes disponibles DANS ce mode. Chaque mode a le
   *  sien : `configure` n'existe pas en `user`, `ip address` n'existe
   *  qu'en `config-if`. */
  readonly registry: CommandRegistry;
  /** Champs à effacer de `session.promptFields` quand on quitte ce mode
   *  (ex: `selectedInterface` en sortant de `config-if`). */
  readonly clearOnExit?: readonly string[];
}

/**
 * Session CLI : extension de `Session` avec l'état vendeur (pile de
 * modes + champs dynamiques du prompt). Compatible avec toutes les APIs
 * qui prennent une `Session` de base (Executor, PermissionGuard…).
 */
export interface CliSession extends Session {
  /** Pile de modes — sommet = mode courant. `enable` push, `disable`/
   *  `exit`/`end` pop. Jamais vide : au minimum, le mode racine. */
  readonly modeStack: string[];
  /** Champs dynamiques interpolés dans les invites (`selectedInterface`,
   *  `selectedVLAN`…). Une commande de sélection (`interface Gi0/0`) les
   *  positionne ; un `exit` de mode les efface (via `clearOnExit`). */
  readonly promptFields: Map<string, string | null>;
}

/**
 * Commande CLI — extension optionnelle d'`ICommand`. Une commande
 * enregistrée dans un mode donné est déjà implicitement autorisée dans
 * ce mode ; `allowedModes` sert quand la MÊME instance de commande est
 * partagée entre plusieurs modes (ex: `show version` en `user` ET en
 * `privileged`) et qu'elle doit refuser certains modes précis.
 */
export interface CliCommand extends ICommand {
  /** Modes dans lesquels cette commande est utilisable. Absent = tous
   *  les modes où elle est enregistrée. */
  readonly allowedModes?: readonly string[];
  /** Sous-registre pour les composées (`show` → `version`, `ip route`…).
   *  L'interpréteur descend dans ce registre pour continuer la
   *  résolution mot par mot. Une commande sans sous-registre est
   *  terminale : le reste des mots devient son argv. */
  readonly subRegistry?: CommandRegistry;
}

/**
 * Filtre pipe terminal — la seule composition permise par IOS/VRP.
 * `show running-config | include hostname` est le seul cas ; pas de
 * pipeline multi-étages, pas de redirection.
 */
export interface CliPipeFilter {
  readonly op: 'include' | 'exclude' | 'section' | 'begin';
  readonly pattern: string;
}
