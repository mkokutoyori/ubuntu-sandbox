import type { CommandSpec } from '../../CommandTable';

/**
 * `debug X` et `no debug X` sont UNE commande a deux directions.
 *
 * Le trie les enregistrait comme deux chemins sans lien : rien n'obligeait
 * la negation a exister, ni a viser la meme categorie que l'activation.
 * `undebug domain` en est la trace — la commande positive marchait, sa
 * negation manquait, et l'aide proposait pourtant `domain` sous `undebug`
 * parce que le repartiteur reecrit `undebug X` en `no debug X`.
 *
 * Une paire se declare ici une fois ; `run` allume, `undo` eteint. Le
 * socle refuse alors `no debug X` pour une commande sans `undo`, au lieu
 * de laisser la negation exister par accident ou manquer en silence.
 */
export interface DebugSubKeyword {
  readonly keyword: string;
  readonly description: string;
}

export interface DebugPair {
  readonly path: readonly string[];
  readonly description: string;
  readonly undoDescription: string;
  readonly takesArguments: boolean;
  readonly enable: (args: string[]) => string;
  readonly disable: (args: string[]) => string;
  /**
   * Les sous-mots que la commande accepte vraiment.
   *
   * Le trie les portait comme une DECORATION d'aide posee a cote du
   * noeud (`registerSuggestions`, `addCompletionKeywords`), donc rien ne
   * garantissait qu'un mot annonce soit accepte, ni qu'un mot accepte
   * soit annonce. Declares ici, ils sont de vrais enfants : le meme
   * objet decrit et achemine.
   */
  readonly subKeywords?: readonly DebugSubKeyword[];
}

const DEBUG_MODES = Object.freeze(['privileged']);

function positional(rest: string | undefined): string[] {
  const tail = (rest ?? '').trim();
  return tail.length === 0 ? [] : tail.split(/\s+/);
}

function specFor(
  pair: DebugPair, path: readonly string[], description: string, prefix: readonly string[],
): CommandSpec {
  return {
    id: path.join('-'),
    path: pair.takesArguments
      ? [...path, { name: 'rest', type: 'REST' as const, optional: true }]
      : [...path],
    description,
    undoDescription: pair.undoDescription,
    modes: DEBUG_MODES,
    minPrivilege: 15,
    run: (_session, args) => pair.enable([...prefix, ...positional(args.rest)]),
    undo: (_session, args) => pair.disable([...prefix, ...positional(args.rest)]),
  };
}

export function debugFamily(pairs: readonly DebugPair[]): CommandSpec[] {
  const specs: CommandSpec[] = [];
  for (const pair of pairs) {
    specs.push(specFor(pair, pair.path, pair.description, []));
    for (const sub of pair.subKeywords ?? []) {
      specs.push(specFor(
        pair, [...pair.path, sub.keyword], sub.description, [sub.keyword]));
    }
  }
  return specs;
}

export function debugPairPaths(pairs: readonly DebugPair[]): string[] {
  return pairs.flatMap(pair => [pair.path.join(' '), `no ${pair.path.join(' ')}`]);
}
