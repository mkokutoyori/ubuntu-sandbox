import type { CommandSpec } from '../CommandTable';
import type { ArgumentSpec } from '../ArgumentTypes';
import type { CliSession } from '../CliSession';

export type TrieAction = (args: string[], raw?: string) => string;

export interface AdapterKeyword {
  readonly keyword: string;
  readonly description: string;
  /**
   * Ce que le mot-cle prend apres lui : une place, PLUSIEURS, ou aucune.
   *
   * Une seule ne suffit pas : `address ipv4 <adresse> auth-port <port>
   * acct-port <port>` en pose trois, et n'en declarer qu'une laissait
   * la suite de la ligne sans destination — la commande la plus tapee
   * du sous-mode RADIUS etait refusee au caret.
   */
  readonly argument?: ArgumentSpec | readonly ArgumentSpec[] | null;
  /**
   * Le mot-cle vient APRES les places declarees, pas avant.
   *
   * `network <reseau> <masque> area <n>` : le trie ne savait poser une
   * continuation qu'au rang qui suit le mot-cle, donc `area` etait
   * annonce la ou il faut ecrire un reseau.
   */
  readonly afterArguments?: boolean;
  /**
   * La joignabilite de CE mot-cle, quand elle differe de la commande.
   *
   * `redistribute rip` sous `router rip` n'existe pas — on ne
   * redistribue pas un protocole dans lui-meme — alors que
   * `redistribute connected` existe partout. Une place enumeree ne peut
   * pas porter cette nuance, son domaine etant fixe a la declaration ;
   * un mot-cle, lui, est une declaration a part entiere.
   */
  readonly reachableWhen?: (session: CliSession) => boolean;
}

export interface CollectedRegistration {
  path: string;
  description: string;
  action: TrieAction;
  greedy: boolean;
  keywords?: ReadonlyArray<AdapterKeyword>;
  hidden: boolean;
}

export interface SpecCollector {
  register(path: string, description: string, action: TrieAction): void;
  registerGreedy(
    path: string, description: string, action: TrieAction,
    keywords?: ReadonlyArray<{ keyword: string; description: string } | string>,
  ): void;
  declare(entry: { path: string; description: string; run: TrieAction }): void;
  describeNode(path: string, description: string): void;
  neJamaisAnnoncer(path: string): void;
  addCompletionKeywords(path: string, keywords: readonly string[]): void;
  registerSuggestions(path: string, keywords: readonly unknown[]): void;
  /**
   * « Ce chemin exige au moins un mot de plus. »
   *
   * Le socle le dit autrement, et mieux : une place DECLAREE et non
   * facultative. Le trie ne sait que compter les mots, la declaration
   * sait de quelle NATURE ils sont, donc la traduction se fait par
   * `argumentFor` et cet appel n'a rien a retenir.
   */
  requireArgs(path: string, count: number): void;
  /**
   * « N'annonce pas ce mot-cle dans cette situation. »
   *
   * Le socle le dit par `reachableWhen` sur chaque declaration, ce qui
   * gouverne l'aide ET l'execution au lieu de la seule aide : c'est
   * `reachableWhenFor` qui porte la regle, pas ce filtre.
   */
  setCompletionFilter(filter: (path: readonly string[], keyword: string) => boolean): void;
}

function normaliseKeywords(
  keywords?: ReadonlyArray<{ keyword: string; description: string } | string>,
): ReadonlyArray<AdapterKeyword> | undefined {
  if (!keywords) return undefined;
  return keywords.map(k => typeof k === 'string' ? { keyword: k, description: '' } : k);
}

export function collectRegistrations(
  register: (collector: SpecCollector) => void,
): CollectedRegistration[] {
  const collected: CollectedRegistration[] = [];
  const hidden = new Set<string>();
  const collector: SpecCollector = {
    register(path, description, action) {
      collected.push({ path, description, action, greedy: false, hidden: false });
    },
    registerGreedy(path, description, action, keywords) {
      collected.push({
        path, description, action, greedy: true,
        keywords: normaliseKeywords(keywords), hidden: false,
      });
    },
    declare(entry) {
      collected.push({
        path: entry.path, description: entry.description, action: entry.run,
        greedy: false, hidden: false,
      });
    },
    describeNode() { /* the socle derives node labels from its own specs */ },
    neJamaisAnnoncer(path) { hidden.add(path); },
    addCompletionKeywords() { /* the socle derives completion from declared children */ },
    registerSuggestions() { /* idem */ },
    requireArgs() { /* a declared, non-optional place says it */ },
    setCompletionFilter() { /* `reachableWhen` says it, for help AND execution */ },
  };
  register(collector);
  return collected.map(entry => ({ ...entry, hidden: hidden.has(entry.path) }));
}

export interface SpecFromTrieOptions {
  modes: readonly string[];
  minPrivilege: number;
  restName?: string;
  restDescription?: string;
  restDescriptionFor?: (path: string) => string | undefined;
  restLiteralFor?: (path: string) => string | undefined;
  argumentFor?: (path: string) => ArgumentSpec | readonly ArgumentSpec[] | null | undefined;
  hiddenFor?: (path: string) => boolean;
  reachableWhenFor?: (path: string) => ((session: CliSession) => boolean) | undefined;
  skip?: (path: string) => boolean;
  /**
   * Le mot-cle du trie qui porte la NEGATION de toute la famille.
   *
   * Le trie enregistre `no` comme un mot-cle de plus, dont le
   * gestionnaire lit le mot suivant ; le socle, lui, traite `no` comme
   * un MODIFICATEUR et cherche `undo` sur la commande positive. Sans
   * cette traduction, une famille migree perd sa negation entiere : le
   * chemin `no <kw>` n'existe plus et `no <kw>` cherche un `undo` que
   * personne n'a declare.
   */
  /**
   * Les chemins `no X` du trie DEVIENNENT l'`undo` de `X`.
   *
   * Le trie enregistre la negation comme un chemin a part entiere ; le
   * socle cherche `undo` sur la commande positive et ne trouverait
   * jamais un chemin dont le premier mot est `no`. Sans cette
   * traduction, une famille migree perd toutes ses negations.
   */
  undoFromNegatedPaths?: boolean;
  undoFrom?: string;
  undoFor?: (path: string) => boolean;
  undoDescriptionFor?: (path: string) => string | undefined;
  keywordsFor?: (path: string) => ReadonlyArray<AdapterKeyword> | undefined;
}

function argumentsFille(
  sub: AdapterKeyword, places: readonly ArgumentSpec[],
  args: Record<string, string>,
): string[] {
  return [sub.keyword, ...places.flatMap(place => {
    const valeur = String(args[place.name] ?? '').trim();
    return valeur.length === 0 ? [] : valeur.split(/\s+/);
  })];
}

export function specsFromTrieRegistrations(
  register: (collector: SpecCollector) => void,
  options: SpecFromTrieOptions,
): CommandSpec[] {
  const restName = options.restName ?? 'reste';
  const collected = collectRegistrations(register);
  const negation = options.undoFrom === undefined
    ? undefined
    : collected.find(entry => entry.path === options.undoFrom);
  const negations = new Map<string, CollectedRegistration>();
  if (options.undoFromNegatedPaths) {
    for (const entry of collected) {
      if (entry.path.startsWith('no ')) negations.set(entry.path.slice(3), entry);
    }
  }
  const specs: CommandSpec[] = [];
  for (const entry of collected) {
    if (negation !== undefined && entry.path === negation.path) continue;
    /*
     * Une negation SANS forme positive reste une negation, pas un chemin
     * dont le premier mot serait `no`.
     *
     * `no version` n'a pas de `version` en face — la forme positive
     * s'ecrit `version 1` ou `version 2` — donc la traduction en `undo`
     * ne trouvait rien et laissait un chemin litteral. Il s'executait
     * tres bien et `no ?` ne l'annoncait JAMAIS, cette aide ne listant
     * que les commandes qui savent se defaire. La commande est donc
     * declaree a sa place positive, existant SEULEMENT niee : `version`
     * seul n'est pas une commande complete, et `no version` en est
     * l'annulation, donc annoncee comme telle.
     */
    const negationSeule = options.undoFromNegatedPaths
      && entry.path.startsWith('no ')
      && !collected.some(autre => autre.path === entry.path.slice(3));
    if (options.undoFromNegatedPaths && entry.path.startsWith('no ')
      && !negationSeule) continue;
    if (options.skip?.(entry.path)) continue;
    const cache = entry.hidden || options.hiddenFor?.(entry.path) === true;
    const contexte = options.reachableWhenFor?.(entry.path);
    const words = (negationSeule ? entry.path.slice(3) : entry.path)
      .split(/\s+/).filter(Boolean);
    const declaredLabel = options.restDescriptionFor?.(entry.path)
      ?? options.restDescription;
    const restLiteral = options.restLiteralFor?.(entry.path);
    const declaredArgument = options.argumentFor?.(entry.path);
    const reste: ArgumentSpec = {
      name: restName, type: 'REST', optional: true,
      description: declaredLabel ?? entry.description,
      ...(restLiteral ? { literal: restLiteral } : {}),
      ...(declaredLabel === undefined && restLiteral === undefined
        ? { values: [] } : {}),
    };
    const places: readonly ArgumentSpec[] = declaredArgument === undefined
      ? (entry.greedy ? [reste] : [])
      : declaredArgument === null ? []
        : Array.isArray(declaredArgument) ? declaredArgument
          : [declaredArgument as ArgumentSpec];
    const argument = places.length === 0 ? null : places[places.length - 1];
    const path: CommandSpec['path'] = [...words, ...places];
    const valeursTapees = (args: Record<string, string>): string[] =>
      places.flatMap(place => {
        const valeur = String(args[place.name] ?? '').trim();
        return valeur.length === 0 ? [] : valeur.split(/\s+/);
      });
    const run = (prefix: readonly string[]) => (_session: unknown, args: Record<string, string>) => {
      const argv = [...prefix, ...valeursTapees(args)];
      return entry.action(argv, [...words, ...argv].join(' '));
    };
    specs.push({
      id: [options.modes[0], ...words].join('-'),
      path,
      description: entry.description,
      modes: options.modes,
      minPrivilege: options.minPrivilege,
      ...(cache ? { hidden: true } : {}),
      ...(contexte ? { reachableWhen: contexte } : {}),
      ...(negationSeule ? {
        existsOnlyNegated: true,
        run: (() => '') as CommandSpec['run'],
        undo: run([]) as CommandSpec['undo'],
      } : { run: run([]) as CommandSpec['run'] }),
      ...(options.undoDescriptionFor?.(entry.path) === undefined ? {} : {
        undoDescription: options.undoDescriptionFor(entry.path),
      }),
      ...(negation === undefined
        || options.undoFor?.(entry.path) === false ? {} : {
        undo: ((_session: unknown, args: Record<string, string>) => {
          const argv = [...words, ...valeursTapees(args)];
          return negation.action(argv, [negation.path, ...argv].join(' '));
        }) as CommandSpec['undo'],
      }),
      ...(negations.get(entry.path) === undefined ? {} : {
        undo: ((_session: unknown, args: Record<string, string>) => {
          const propre = negations.get(entry.path)!;
          const argv = valeursTapees(args);
          return propre.action(argv, [propre.path, ...argv].join(' '));
        }) as CommandSpec['undo'],
      }),
    });
    // Une NEGATION ne reprend pas la valeur que la forme positive exige :
    // `no password` se tape seul. Le chemin nu n'existe alors QUE
    // negativement — le socle porte deja cette notion — sinon `password`
    // tout court passerait pour une commande complete.
    if (negation !== undefined && argument !== null && argument.optional !== true) {
      specs.push({
        id: `no-${[options.modes[0], ...words].join('-')}`,
        path: [...words],
        description: entry.description,
        modes: options.modes,
        minPrivilege: options.minPrivilege,
        existsOnlyNegated: true,
        ...(cache ? { hidden: true } : {}),
        ...(contexte ? { reachableWhen: contexte } : {}),
        run: (() => '') as CommandSpec['run'],
        undo: ((_session: unknown) =>
          negation.action([...words], [negation.path, ...words].join(' '))
        ) as CommandSpec['undo'],
      });
    }

    for (const sub of entry.keywords ?? options.keywordsFor?.(entry.path) ?? []) {
      const placesFille: readonly ArgumentSpec[] = sub.argument === undefined
        ? [{ name: restName, type: 'REST', optional: true,
          description: sub.description, values: [] }]
        : sub.argument === null ? []
          : Array.isArray(sub.argument) ? sub.argument
            : [sub.argument as ArgumentSpec];
      const amont = sub.afterArguments ? [...words, ...places] : [...words];
      specs.push({
        id: [options.modes[0], ...amont, sub.keyword].join('-'),
        path: [...amont, sub.keyword, ...placesFille],
        description: sub.description,
        modes: options.modes,
        minPrivilege: options.minPrivilege,
        ...(cache ? { hidden: true } : {}),
        ...(sub.reachableWhen ? { reachableWhen: sub.reachableWhen }
          : contexte ? { reachableWhen: contexte } : {}),
        run: ((_session: unknown, args: Record<string, string>) => {
          const argv = [...(sub.afterArguments ? valeursTapees(args) : []),
            ...argumentsFille(sub, placesFille, args)];
          return entry.action(argv, [...words, ...argv].join(' '));
        }) as CommandSpec['run'],
        ...(negations.get(entry.path) === undefined ? {} : {
          undo: ((_session: unknown, args: Record<string, string>) => {
            const propre = negations.get(entry.path)!;
            const argv = [...(sub.afterArguments ? valeursTapees(args) : []),
              ...argumentsFille(sub, placesFille, args)];
            return propre.action(argv, [propre.path, ...argv].join(' '));
          }) as CommandSpec['undo'],
        }),
        ...(negation === undefined
          || options.undoFor?.(entry.path) === false ? {} : {
          undo: ((_session: unknown, args: Record<string, string>) => {
            const argv = [...words, ...argumentsFille(sub, placesFille, args)];
            return negation.action(argv, [negation.path, ...argv].join(' '));
          }) as CommandSpec['undo'],
        }),
      });
    }
  }
  return specs;
}

export function pathsOf(specs: readonly CommandSpec[]): string[] {
  return specs.map(spec =>
    spec.path.filter((step): step is string => typeof step === 'string').join(' '));
}
