import { InteractionUnavailableError } from "../errors";
import type { CommandIO } from "./types";

/**
 * Dialogue utilisateur en cours d'exécution (mot de passe, GECOS,
 * confirmation) : contrairement à stdin (un flux de données redirigeable),
 * ce canal représente le terminal de contrôle — il reste celui de
 * l'utilisateur même quand stdin vient d'un pipe ou d'un fichier.
 */
export type PromptKind = "text" | "secret" | "confirm";

export interface PromptSpec {
  readonly kind: PromptKind;
  readonly prompt: string;
  readonly defaultValue?: string;
  readonly allowEmpty?: boolean;
}

export interface InteractionChannel {
  /** null = flux interrompu (EOF / Ctrl+D) — jamais une chaîne vide implicite. */
  prompt(spec: PromptSpec): Promise<string | null>;
}

/**
 * Requête en attente d'une réponse humaine : l'hôte (session de terminal,
 * pont legacy) affiche `spec.prompt` selon `spec.kind`, puis appelle
 * `respond()` avec la saisie — ce qui réveille le `await` de la commande.
 */
export interface PromptRequest {
  readonly spec: PromptSpec;
  respond(input: string | null): void;
}

/**
 * Adaptateur pause/reprise : convertit le modèle « execute() déroulé
 * jusqu'au bout » des commandes en dialogue en plusieurs tours piloté par
 * l'hôte. La commande fait `await ctx.io.interaction.prompt(...)` ; la
 * Promise ne se résout qu'au `respond()` de l'hôte — l'exécution est
 * réellement suspendue entre les deux, sans polling ni file d'attente.
 */
export class InteractionBroker implements InteractionChannel {
  constructor(private readonly onRequest: (request: PromptRequest) => void) {}

  prompt(spec: PromptSpec): Promise<string | null> {
    return new Promise((resolve) => {
      this.onRequest({
        spec,
        respond: (input) => {
          if (input !== null && input === "" && spec.defaultValue !== undefined) {
            resolve(spec.defaultValue);
            return;
          }
          resolve(input);
        },
      });
    });
  }
}

/**
 * Garde d'entrée pour toute commande interactive : lève une erreur métier
 * (jamais une Error native) quand le contexte ne permet aucun dialogue
 * (pipeline non interactif, pont sans broker, script).
 */
export function requireInteraction(io: CommandIO, commandName: string): InteractionChannel {
  if (!io.interaction) throw new InteractionUnavailableError(commandName);
  return io.interaction;
}
