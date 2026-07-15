import type { InteractionChannel } from "./interaction";

/**
 * Canal standardisé fourni par un hôte de terminal (session UI, SSH, pont
 * legacy) à un pont d'équipement pour une exécution command-kernel. Un seul
 * contrat pour toutes les natures de commandes : celles qui rendent leur
 * résultat d'un bloc, celles qui émettent en continu (suivi, sondes
 * réseau), et celles qui dialoguent (mot de passe, GECOS).
 */
export interface CommandKernelChannel {
  /** Dialogue utilisateur en cours d'exécution (§ io/interaction.ts). */
  readonly interaction?: InteractionChannel;
  /**
   * Réception en flux continu de chaque chunk stdout/stderr au moment où
   * la commande l'écrit — le pont continue de collecter la sortie complète
   * pour l'appelant, ce rappel n'est qu'une copie temps réel vers l'hôte.
   */
  readonly onOutput?: (chunk: string) => void;
  /** Annulation par l'hôte (Ctrl+C) — relayée telle quelle à ctx.signal. */
  readonly signal?: AbortSignal;
  /**
   * Remise d'un sous-shell interactif à l'hôte (ex: `sftp` une fois
   * connecté, §5.5) — absent quand l'hôte ne sait pas en accueillir
   * (script, pont non câblé). `kind` identifie le type de sous-shell,
   * `payload` est la poignée opaque renvoyée par la capacité machine qui a
   * ouvert la connexion — le pont hôte, seul à connaître le type réel, sait
   * la reconvertir.
   */
  readonly openSubShell?: (kind: string, payload: unknown) => void;
}
