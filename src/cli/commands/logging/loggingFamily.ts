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
  /**
   * Ce qui peut suivre CETTE continuation.
   *
   * `logging host <ip> transport tcp port 1470` porte un mot-cle apres
   * un mot-cle : le moteur le lit depuis toujours, mais un seul rang de
   * continuations ne savait pas le declarer, si bien que `port`
   * s'executait sans que `?` l'annonce jamais.
   */
  readonly continuations?: readonly LoggingContinuation[];
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
  /**
   * La continuation vient APRES l'argument facultatif aussi bien qu'a sa
   * place.
   *
   * `logging reload critical message-limit 10` donne la severite ET la
   * borne : les deux places sont facultatives et INDEPENDANTES, la ou
   * `logging console 5` et `logging console discriminator X` sont deux
   * choix qui s'excluent. Un seul defaut ne peut pas dire les deux.
   */
  readonly continuationsAlsoAfterArgument?: boolean;
  readonly undoWithoutArgument?: boolean;
  /**
   * Le mot-cle lui-meme peut etre OMIS.
   *
   * `logging <ip>` est l'ecriture heritee de `logging host <ip>`, et la
   * machine range les deux sous la seconde. Les declarer separement
   * faisait deux vocabulaires pour une commande : la forme heritee
   * vivait sur le trie, ou son adresse etait suivie des mots-cles
   * declares sur `logging` — `buffered`, `console`, `on`… — que la meme
   * machine refusait a cette place. Une entree, deux chemins engendres.
   */
  readonly keywordOptional?: boolean;
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

function declarerSuites(
  suites: readonly LoggingContinuation[],
  amont: ReadonlyArray<string | ArgumentSpec>,
  idAmont: string,
  motsAmont: (args: Record<string, string>) => string[],
  host: () => LoggingHost,
  specs: CommandSpec[],
): void {
  for (const suite of suites) {
    const tete = [...amont, suite.keyword];
    const path = suite.argument ? [...tete, suite.argument] : tete;
    const id = `${idAmont}-${suite.keyword}`;
    const mots = (args: Record<string, string>) => [
      ...motsAmont(args), suite.keyword, ...valueOf(args, suite.argument),
    ];

    specs.push(specFor(id, path, suite.description, mots, host));
    declarerSuites(suite.continuations ?? [], path, id, mots, host, specs);
  }
}

function declarerEntree(
  entry: LoggingEntry, tete: ReadonlyArray<string | ArgumentSpec>,
  id: string, motsTete: readonly string[],
  host: () => LoggingHost, specs: CommandSpec[],
): void {
  const base: Array<string | ArgumentSpec> = entry.argument
    ? [...tete, entry.argument] : [...tete];
  const complet = entry.second ? [...base, entry.second] : base;
  const debut = (args: Record<string, string>) => [
    ...motsTete, ...valueOf(args, entry.argument), ...valueOf(args, entry.second),
  ];

  specs.push(specFor(id, complet, entry.description, debut, host));

  if (entry.undoWithoutArgument) {
    specs.push({
      ...specFor(`${id}-undo`, tete, entry.description, () => [...motsTete], host),
      existsOnlyNegated: true,
    });
  }

  const remplace = entry.continuationsReplaceArgument
    ?? entry.argument?.optional === true;

  // Un argument OPTIONNEL et un mot-cle qui le suit sont deux CHOIX,
  // pas une sequence : IOS accepte `logging console 5` ou `logging
  // console discriminator X`, jamais les deux a la fois. Le chemin de
  // la continuation saute donc l'argument — le declarer apres ferait
  // accepter une forme qu'aucune machine reelle ne prend, ce qui est
  // pire qu'en refuser une vraie.
  const ancres: Array<[string, ReadonlyArray<string | ArgumentSpec>,
    (args: Record<string, string>) => string[]]> = [];
  if (remplace) ancres.push([id, tete, () => [...motsTete]]);
  if (!remplace || entry.continuationsAlsoAfterArgument) {
    ancres.push([`${id}-apres`, base,
      (args) => [...motsTete, ...valueOf(args, entry.argument)]]);
  }
  if (entry.second) ancres.push([`${id}-second`, complet, debut]);

  for (const [idAncre, amont, mots] of ancres) {
    declarerSuites(entry.continuations ?? [], amont, idAncre, mots, host, specs);
  }
}

export function loggingFamily(
  entries: readonly LoggingEntry[], host: () => LoggingHost,
): CommandSpec[] {
  const specs: CommandSpec[] = [];

  for (const entry of entries) {
    declarerEntree(entry, ['logging', entry.keyword],
      `logging-${entry.keyword}`, [entry.keyword], host, specs);

    if (entry.keywordOptional) {
      declarerEntree(entry, ['logging'],
        `logging-${entry.keyword}-implicite`, [entry.keyword], host, specs);
    }
  }
  return specs;
}
