import type { CommandSpec } from '../../CommandTable';
import type { ArgumentSpec } from '../../ArgumentTypes';

/**
 * `logging X` et `no logging X` sont UNE commande a deux directions.
 *
 * Le trie construit deux arbres entiers — un sous `logging`, un sous
 * `no logging` — par la meme boucle, donc deux chemins par entree. Le
 * socle porte l'entree une fois : `run` applique, `undo` retire.
 *
 * La tranche migree ici est celle que le socle sait exprimer SANS RIEN
 * PERDRE. Les sous-commandes a plusieurs parametres ou a continuations
 * (`buffered`, `console`, `discriminator`, `history`, `host`,
 * `persistent`, `rate-limit`, `reload`) restent au trie : leur aide y
 * decrit des mots-cles qui suivent l'argument, et migrer avant de savoir
 * les rendre echangerait une aide precise contre une aide generique —
 * l'erreur commise puis annulee sur la famille `ntp`.
 */
export interface LoggingEntry {
  readonly keyword: string;
  readonly description: string;
  readonly argument?: ArgumentSpec;
}

export interface LoggingHost {
  applyLogging(words: string[], negate: boolean): string;
}

export function loggingFamily(
  entries: readonly LoggingEntry[], host: () => LoggingHost,
): CommandSpec[] {
  return entries.map((entry): CommandSpec => {
    const path = entry.argument
      ? ['logging', entry.keyword, entry.argument]
      : ['logging', entry.keyword];

    const words = (args: Record<string, string>): string[] => {
      const value = entry.argument ? args[entry.argument.name] : undefined;
      return value === undefined ? [entry.keyword] : [entry.keyword, value];
    };

    return {
      id: `logging-${entry.keyword}`,
      path,
      description: entry.description,
      modes: ['config'],
      minPrivilege: 15,
      run: (_session, args) => host().applyLogging(words(args), false),
      undo: (_session, args) => host().applyLogging(words(args), true),
    };
  });
}

export function loggingPaths(entries: readonly LoggingEntry[]): string[] {
  return entries.flatMap(entry => [
    `logging ${entry.keyword}`, `no logging ${entry.keyword}`,
  ]);
}
