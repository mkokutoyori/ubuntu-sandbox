import type { CommandSpec } from '../../CommandTable';
import type { ArgumentSpec } from '../../ArgumentTypes';

/**
 * `logging X` et `no logging X` sont UNE commande a deux directions.
 *
 * Le trie construit deux arbres entiers — un sous `logging`, un sous
 * `no logging` — par la meme boucle, donc deux chemins par entree. Le
 * socle porte l'entree une fois : `run` applique, `undo` retire.
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
   * Un SECOND argument optionnel, quand la commande en prend deux.
   *
   * `logging buffered 8192 7` donne la taille puis la severite, et les
   * deux places acceptent les memes valeurs — l'ambiguite est voulue par
   * IOS et resolue par la valeur, pas par la position.
   */
  readonly second?: ArgumentSpec;
  /**
   * Les mots-cles qui SUIVENT l'argument.
   *
   * `logging host <ip> transport tcp` en est le cas type : la place de
   * l'adresse est franchie, puis un mot-cle reprend. Sans eux, la forme
   * longue serait refusee ou avalee par un argument glouton, et l'aide
   * apres l'adresse n'annoncerait rien.
   */
  readonly continuations?: readonly LoggingContinuation[];
  readonly continuationsReplaceArgument?: boolean;
  readonly undoWithoutArgument?: boolean;
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
  if (value === undefined) return [];
  // Un `REST` porte PLUSIEURS mots en une chaine : le gestionnaire les
  // attend separes, comme le trie les lui donnait. Le passer entier
  // ferait de `drops X` un seul argument que rien ne sait lire.
  if (argument.type === 'REST') return value.trim().split(/\s+/).filter(Boolean);
  return [value];
}

export function loggingFamily(
  entries: readonly LoggingEntry[], host: () => LoggingHost,
): CommandSpec[] {
  const specs: CommandSpec[] = [];

  for (const entry of entries) {
    const base: Array<string | ArgumentSpec> = entry.argument
      ? ['logging', entry.keyword, entry.argument]
      : ['logging', entry.keyword];
    const complet = entry.second ? [...base, entry.second] : base;

    specs.push(specFor(
      `logging-${entry.keyword}`, complet, entry.description,
      (args) => [
        entry.keyword,
        ...valueOf(args, entry.argument), ...valueOf(args, entry.second),
      ], host));

    if (entry.undoWithoutArgument) {
      specs.push({
        ...specFor(
          `logging-${entry.keyword}-undo`, ['logging', entry.keyword],
          entry.description, () => [entry.keyword], host),
        existsOnlyNegated: true,
      });
    }

    const remplace = entry.continuationsReplaceArgument
      ?? entry.argument?.optional === true;

    for (const suite of entry.continuations ?? []) {
      // Un argument OPTIONNEL et un mot-cle qui le suit sont deux
      // CHOIX, pas une sequence : IOS accepte `logging console 5` ou
      // `logging console discriminator X`, jamais les deux a la fois. Le
      // chemin de la continuation saute donc l'argument — le declarer
      // apres ferait accepter une forme qu'aucune machine reelle ne
      // prend, ce qui est pire qu'en refuser une vraie.
      const amont: Array<string | ArgumentSpec> = remplace
        ? ['logging', entry.keyword, suite.keyword]
        : [...base, suite.keyword];
      const path = suite.argument ? [...amont, suite.argument] : amont;

      specs.push(specFor(
        `logging-${entry.keyword}-${suite.keyword}`, path, suite.description,
        (args) => [
          entry.keyword,
          ...(remplace ? [] : valueOf(args, entry.argument)),
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
