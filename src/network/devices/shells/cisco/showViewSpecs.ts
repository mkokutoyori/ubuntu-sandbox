import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

const EXEC = ['user', 'privileged'] as const;

export const TRACK_OBJECT_RANGE: readonly [number, number] = [1, 1000];

/**
 * Ce que `show track` prend : un NUMERO d'objet ou le mot `brief`.
 *
 * Une seule place porte les deux, comme `logging console` porte une
 * severite ecrite `errors` ou `3`. Elle est partagee par les deux
 * plateformes parce que la plage est celle de l'objet suivi, que
 * `track <1-1000>` declare deja en configuration — deux bornes pour un
 * meme fait finiraient par se contredire.
 */
export const TRACK_SELECTOR: ArgumentSpec = {
  name: 'cible', type: 'ENUM', optional: true, range: TRACK_OBJECT_RANGE,
  description: 'Tracked object number',
  values: [{ keyword: 'brief', description: 'Brief output' }],
};

/**
 * Une vue `show` sans argument, declaree pour les DEUX vues EXEC.
 *
 * Le trie les enregistrait deux fois — une boucle sur `userTrie` puis
 * `privilegedTrie` — et en GLOUTON, donc `show adjacency zorglub` etait
 * accepte en silence. Une commande du socle nomme ses deux modes en une
 * declaration, et ce qui suit un chemin sans place est refuse par
 * construction.
 */
export function showViewSpec(
  id: string, mots: readonly string[], description: string,
  rendre: () => string,
): CommandSpec {
  return {
    id,
    path: [...mots],
    description,
    modes: EXEC, minPrivilege: 1,
    run: () => rendre(),
  };
}

export function showTrackSpec(
  rendre: (cible: string | undefined) => string,
): CommandSpec {
  return {
    id: 'show-track',
    path: ['show', 'track', TRACK_SELECTOR],
    description: 'Tracking information',
    modes: EXEC, minPrivilege: 1,
    run: (_session, args) => rendre(args.cible),
  };
}

export const ADJACENCY_SCOPE: ArgumentSpec = {
  name: 'portee', type: 'ENUM', optional: true,
  description: 'Adjacency information to display',
  values: [
    { keyword: 'detail', description: 'Detailed adjacency information' },
    { keyword: 'summary', description: 'Summary of adjacency information' },
  ],
};

export function showAdjacencySpec(
  rendre: (portee: string | undefined) => string,
  avecPortee: boolean,
): CommandSpec {
  return {
    id: 'show-adjacency',
    path: avecPortee ? ['show', 'adjacency', ADJACENCY_SCOPE] : ['show', 'adjacency'],
    description: 'Display CEF adjacency table',
    modes: EXEC, minPrivilege: 1,
    run: (_session, args) => rendre(args.portee),
  };
}
