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
  /**
   * Le constructeur a dit que la place est EXIGEE.
   *
   * `requireArgs` etait avale sans rien faire, au motif qu'une place
   * declaree non facultative le dit mieux — vrai quand la famille en
   * declare une, faux sinon : la place par defaut de l'adaptateur est
   * facultative, donc la commande annoncait `<cr>` et refusait ensuite
   * au caret le mot qui manquait.
   */
  requiresArgs?: boolean;
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
   * Une place DECLAREE et non facultative le dit mieux — elle sait de
   * quelle NATURE est le mot — donc `argumentFor` l'emporte quand la
   * famille en declare une. En son absence, cet appel est ce qui rend
   * EXIGEE la place par defaut, faute de quoi la commande annonce
   * `<cr>` et refuse ensuite au caret.
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

const COLLECTOR_BRAND = Symbol.for('cli.trieAdapter.collector');

export function isCollector(cible: unknown): boolean {
  return typeof cible === 'object' && cible !== null && COLLECTOR_BRAND in cible;
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
  const exigent = new Set<string>();
  const collector: SpecCollector & { [COLLECTOR_BRAND]: true } = {
    [COLLECTOR_BRAND]: true,
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
    requireArgs(path) { exigent.add(path); },
    setCompletionFilter() { /* `reachableWhen` says it, for help AND execution */ },
  };
  register(collector);
  return collected.map(entry => ({
    ...entry,
    hidden: hidden.has(entry.path),
    requiresArgs: exigent.has(entry.path),
  }));
}

export interface SpecFromTrieOptions {
  modes: readonly string[];
  /**
   * Les modes de CE chemin, quand ils different de la famille.
   *
   * `scopedTrie` retire certaines vues de l'EXEC utilisateur
   * (`PRIVILEGED_EXEC_ONLY`) : un constructeur partage porte donc des
   * commandes de deux portees, et une famille a un seul jeu de modes
   * les rendrait toutes visibles avant `enable`.
   */
  modesFor?: (path: string) => readonly string[] | undefined;
  minPrivilege: number;
  minPrivilegeFor?: (path: string) => number | undefined;
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
  const privilegeDe = (chemin: string): number =>
    options.minPrivilegeFor?.(chemin) ?? options.minPrivilege;
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
  const gloutonCouvrant = (positif: string): CollectedRegistration | undefined =>
    collected
      .filter(autre => autre.greedy && !autre.path.startsWith('no ')
        && positif.startsWith(`${autre.path} `))
      .sort((a, b) => b.path.length - a.path.length)[0];
  const negationsCouvertes = new Map<string, CollectedRegistration[]>();
  if (options.undoFromNegatedPaths) {
    for (const entry of collected) {
      if (!entry.path.startsWith('no ')) continue;
      const glouton = gloutonCouvrant(entry.path.slice(3));
      if (!glouton) continue;
      const liste = negationsCouvertes.get(glouton.path) ?? [];
      liste.push(entry);
      negationsCouvertes.set(glouton.path, liste);
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
    /*
     * Une negation nue ne se declare que si sa forme positive n'est
     * couverte par PERSONNE. `no ip nat inside source static network`
     * n'a pas de `… static network` en face, mais `… static` est
     * GLOUTON et avale deja `network 192.168.1.0 …` : declarer la forme
     * longue comme n'existant que niee la masquerait, et la commande la
     * plus specifique gagnant l'analyse, la traduction de reseau entiere
     * devenait « % Incomplete command. ».
     */
    const positif = entry.path.startsWith('no ') ? entry.path.slice(3) : null;
    const couvertParUnGlouton = positif !== null
      && gloutonCouvrant(positif) !== undefined;
    const negationSeule = options.undoFromNegatedPaths
      && entry.path.startsWith('no ')
      && !collected.some(autre => autre.path === entry.path.slice(3))
      && !couvertParUnGlouton;
    if (options.undoFromNegatedPaths && entry.path.startsWith('no ')
      && !negationSeule) continue;
    if (options.skip?.(entry.path)) continue;
    const cache = entry.hidden || options.hiddenFor?.(entry.path) === true;
    const contexte = options.reachableWhenFor?.(entry.path);
    const words = (negationSeule ? entry.path.slice(3) : entry.path)
      .split(/\s+/).filter(Boolean);
    const modesIci = options.modesFor?.(entry.path) ?? options.modes;
    const declaredLabel = options.restDescriptionFor?.(entry.path)
      ?? options.restDescription;
    const restLiteral = options.restLiteralFor?.(entry.path);
    const declaredArgument = options.argumentFor?.(entry.path);
    const reste: ArgumentSpec = {
      name: restName, type: 'REST', optional: entry.requiresArgs !== true,
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
      id: [modesIci[0], ...words].join('-'),
      path,
      description: entry.description,
      modes: modesIci,
      minPrivilege: privilegeDe(entry.path),
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
      /*
       * Une negation plus LONGUE que le glouton qui la couvre reste
       * atteignable, et c'est le glouton qui l'aiguille.
       *
       * `no ip nat inside source static network 1.1.1.0 …` et
       * `no bfd echo` decrivent tous deux une forme que le glouton
       * positif avale deja : les declarer a part les masquerait, et ne
       * rien declarer les perdrait. Le glouton porte donc UN `undo` qui
       * lit les mots tapes et appelle la negation la plus specifique
       * qui les prefixe — la meme regle que l'analyse suit pour la
       * forme positive, donc les deux ne peuvent pas diverger.
       */
      ...((negationsCouvertes.get(entry.path) ?? []).length === 0 ? {} : {
        undoRequiresArgument: negations.get(entry.path) === undefined,
        undo: ((_session: unknown, args: Record<string, string>) => {
          const mots = valeursTapees(args);
          const couvertes = [...(negationsCouvertes.get(entry.path) ?? [])]
            .sort((a, b) => b.path.length - a.path.length);
          for (const cible of couvertes) {
            const surplus = cible.path.slice(3).split(/\s+/)
              .slice(words.length);
            const prefixe = mots.slice(0, surplus.length)
              .map(mot => mot.toLowerCase());
            if (surplus.length === 0
              || surplus.join(' ').toLowerCase() !== prefixe.join(' ')) continue;
            const suite = mots.slice(surplus.length);
            return cible.action(suite, [cible.path, ...suite].join(' '));
          }
          const propre = negations.get(entry.path);
          if (propre !== undefined) {
            return propre.action(mots, [propre.path, ...mots].join(' '));
          }
          /*
           * Le mot-cle EXISTE sous `no`, il lui manque une suite : c'est
           * `% Incomplete command.` et non le caret, qui dirait que la
           * commande est inconnue. La distinction est celle d'IOS, et
           * `probe-aide-tient-ses-promesses` la mesure — `no ?` annonce
           * ce glouton des qu'une de ses formes sait se defaire.
           */
          return mots.length === 0
            ? '% Incomplete command.'
            : "% Invalid input detected at '^' marker.";
        }) as CommandSpec['undo'],
      }),
    });
    /*
     * Une NEGATION ne reprend pas la valeur que la forme positive
     * exige : `no ip ospf cost` se tape SEUL, la ou `ip ospf cost`
     * demande un nombre. Le chemin nu n'existe alors QUE negativement —
     * le socle porte deja cette notion — sinon `ip ospf cost` tout court
     * passerait pour une commande complete.
     *
     * Cette forme nue valait pour le seul mecanisme `undoFrom` ; elle
     * manquait a `undoFromNegatedPaths`, si bien qu'une famille migree
     * par celui-ci perdait en silence toutes ses negations tapees sans
     * valeur. Les deux mecanismes decrivent le meme fait et doivent donc
     * produire la meme commande.
     */
    const negationPropre = negations.get(entry.path);
    const negationDeLaCommande = negation ?? negationPropre;
    /*
     * Ce qui compte est qu'une place soit EXIGEE, pas que la DERNIERE le
     * soit : `ip ospf network <genre> [reste]` finit par une place
     * facultative et exige pourtant un genre, donc `no ip ospf network`
     * se tape seul comme les autres.
     */
    const exigeUneValeur = places.some(place => place.optional !== true);
    if (negationDeLaCommande !== undefined && exigeUneValeur) {
      const cible = negationDeLaCommande;
      const argvNu = cible === negationPropre ? [] : [...words];
      specs.push({
        id: `no-${[modesIci[0], ...words].join('-')}`,
        path: [...words],
        description: entry.description,
        modes: modesIci,
        minPrivilege: privilegeDe(entry.path),
        existsOnlyNegated: true,
        ...(cache ? { hidden: true } : {}),
        ...(contexte ? { reachableWhen: contexte } : {}),
        run: (() => '') as CommandSpec['run'],
        undo: ((_session: unknown) =>
          cible.action(argvNu, [cible.path, ...argvNu].join(' '))
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
        id: [modesIci[0], ...amont, sub.keyword].join('-'),
        path: [...amont, sub.keyword, ...placesFille],
        description: sub.description,
        modes: modesIci,
        minPrivilege: privilegeDe(entry.path),
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
