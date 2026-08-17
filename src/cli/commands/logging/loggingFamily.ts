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
export interface LoggingContinuation {
  readonly keyword: string;
  readonly description: string;
  readonly argument?: ArgumentSpec;
}

export interface LoggingEntry {
  readonly keyword: string;
  readonly description: string;
  readonly argument?: ArgumentSpec;
  /**
   * Les mots-cles qui SUIVENT l'argument.
   *
   * `logging host <ip> transport tcp` en est le cas type : la place de
   * l'adresse est franchie, puis un mot-cle reprend. Sans eux, la forme
   * longue serait refusee ou avalee par un argument glouton, et l'aide
   * apres l'adresse n'annoncerait rien.
   */
  readonly continuations?: readonly LoggingContinuation[];
}

export interface LoggingHost {
  applyLogging(words: string[], negate: boolean): string;
}

function specFor(
  id: string, path: ReadonlyArray<string | ArgumentSpec>, description: string,
  words: (args: Record<string, string>) => string[], host: () => LoggingHost,
): CommandSpec {
  return {
    id, path: [...path], description,
    modes: ['config'], minPrivilege: 15,
    run: (_session, args) => host().applyLogging(words(args), false),
    undo: (_session, args) => host().applyLogging(words(args), true),
  };
}

function valueOf(args: Record<string, string>, argument?: ArgumentSpec): string[] {
  if (!argument) return [];
  const value = args[argument.name];
  return value === undefined ? [] : [value];
}

export function loggingFamily(
  entries: readonly LoggingEntry[], host: () => LoggingHost,
): CommandSpec[] {
  const specs: CommandSpec[] = [];

  for (const entry of entries) {
    const base: Array<string | ArgumentSpec> = entry.argument
      ? ['logging', entry.keyword, entry.argument]
      : ['logging', entry.keyword];

    specs.push(specFor(
      `logging-${entry.keyword}`, base, entry.description,
      (args) => [entry.keyword, ...valueOf(args, entry.argument)], host));

    for (const suite of entry.continuations ?? []) {
      const path: Array<string | ArgumentSpec> = [...base, suite.keyword];
      if (suite.argument) path.push(suite.argument);

      specs.push(specFor(
        `logging-${entry.keyword}-${suite.keyword}`, path, suite.description,
        (args) => [
          entry.keyword, ...valueOf(args, entry.argument),
          suite.keyword, ...valueOf(args, suite.argument),
        ], host));
    }
  }
  return specs;
}

export function loggingPaths(entries: readonly LoggingEntry[]): string[] {
  return entries.flatMap(entry => [
    `logging ${entry.keyword}`, `no logging ${entry.keyword}`,
  ]);
}
