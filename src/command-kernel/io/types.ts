import type { InteractionChannel } from "./interaction";

/**
 * Flux d'entrée/sortie génériques (pour supporter pipes et redirections).
 *
 * Invariants du contrat :
 * - Les flux transportent exclusivement des `string` (texte UTF-16 JS),
 *   jamais d'octets bruts — simuler un contenu binaire via ce contrat est
 *   hors périmètre tant que le besoin n'a pas été discuté explicitement.
 * - `read()` renvoie le prochain chunk disponible, ou `null` quand plus
 *   aucune donnée n'est disponible — jamais `""` pour signifier
 *   « rien pour l'instant » : aucun appelant ne doit boucler en attente
 *   active sur ce contrat.
 * - Les étages d'un pipeline s'exécutent séquentiellement (le producteur
 *   termine avant que le consommateur ne démarre) ; un flux non borné
 *   (générateur infini) est hors périmètre de ce modèle.
 */

export interface InputStream {
  read(): Promise<string | null>;
  readAll(): Promise<string>;
}

export interface OutputStream {
  write(chunk: string): Promise<void>;
  close(): Promise<void>;
}

export interface CommandIO {
  readonly stdin: InputStream;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  /**
   * Terminal de contrôle pour les dialogues en cours d'exécution
   * (mot de passe, GECOS, confirmation). Absent quand aucun humain ne
   * peut répondre (pipe de test, pont non câblé, script) — une commande
   * interactive passe par `requireInteraction()` pour convertir cette
   * absence en erreur métier propre.
   */
  readonly interaction?: InteractionChannel;
  /**
   * Remise d'un sous-shell interactif à l'hôte (ex: `sftp` après connexion,
   * framework §5.5) — absent quand aucun hôte ne sait en accueillir un
   * (script, pont non câblé). `kind` identifie le type de sous-shell,
   * `payload` est la poignée opaque renvoyée par la capacité machine qui a
   * ouvert la connexion.
   */
  readonly openSubShell?: (kind: string, payload: unknown) => void;
}
