import { createSession } from "../session/types";
import type { User } from "../session/types";
import type { CliSession } from "./types";

/**
 * Fabrique une `CliSession` neuve — même mécanique que `createSession`
 * du socle, mais avec la pile de modes initialisée (le mode racine
 * fournit par l'interpréteur) et les champs de prompt vides. Compatible
 * avec toute API qui prend une `Session` de base — la CLI-ité vit dans
 * les champs additionnels, jamais dans une hiérarchie de classes.
 */
export interface CreateCliSessionOptions {
  readonly id: string;
  readonly user: User;
  readonly rootMode: string;
}

export function createCliSession(options: CreateCliSessionOptions): CliSession {
  const base = createSession({ id: options.id, user: options.user });
  return {
    ...base,
    modeStack: [options.rootMode],
    promptFields: new Map(),
  };
}

/**
 * Push d'un nouveau mode sur la pile — utilisée par les commandes de
 * transition (`enable`, `configure terminal`, `interface`). Aucune
 * validation ici : c'est à l'appelant de vérifier que la transition a
 * un sens (parent-enfant selon `ModeRegistry`).
 */
export function pushMode(session: CliSession, mode: string): void {
  session.modeStack.push(mode);
}

/**
 * Pop d'un mode — utilisée par `exit`/`quit`. Ne descend jamais sous le
 * mode racine (au minimum, une session garde son mode initial). Nettoie
 * les champs de prompt déclarés `clearOnExit` par le mode quitté.
 */
export function popMode(session: CliSession, clearFields: readonly string[] = []): void {
  if (session.modeStack.length <= 1) return;
  session.modeStack.pop();
  for (const field of clearFields) session.promptFields.delete(field);
}

/**
 * Retour direct au mode d'exécution privilégié (`end` / Ctrl-Z sur
 * Cisco) — vide la pile jusqu'au mode cible, en nettoyant les champs
 * `clearOnExit` de chaque mode traversé.
 */
export function endToMode(
  session: CliSession,
  targetMode: string,
  clearFieldsPerMode: (mode: string) => readonly string[],
): void {
  while (session.modeStack.length > 1 && session.modeStack[session.modeStack.length - 1] !== targetMode) {
    const leaving = session.modeStack[session.modeStack.length - 1];
    session.modeStack.pop();
    for (const field of clearFieldsPerMode(leaving)) session.promptFields.delete(field);
  }
}
