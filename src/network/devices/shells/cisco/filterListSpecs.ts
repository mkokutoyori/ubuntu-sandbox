import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';
import { cidrPrefixLength } from '@/network/core/ip';
import type {
  PolicyRepository, PrefixListEntry,
} from '../../inspection/config/PolicyRepository';

const MODES = ['config'] as const;

export const FILTER_LIST_RANGE: readonly [number, number] = [1, 500];
const PREFIX_SEQ_RANGE: readonly [number, number] = [1, 4294967294];

/**
 * `permit` ou `deny`, la place que les quatre listes partagent.
 *
 * Elle etait DECLAREE par les listes de prefixes et absente des deux
 * autres : `ip as-path access-list 1 zorglub ^$` et `ip community-list 1
 * zorglub 100:1` etaient acceptes, le mot d'action etant avale dans la
 * chaine de regle que le gestionnaire recopiait sans la lire. Une liste
 * qui ne dit ni permit ni deny ne filtre rien de ce que l'operateur
 * croit, et rien dans `show` ne le revele — la regle s'y affiche telle
 * qu'elle a ete tapee, faute comprise.
 */
export const FILTER_ACTION: ArgumentSpec = {
  name: 'action', type: 'ENUM',
  description: 'Action to take on a matching route',
  values: [
    { keyword: 'deny', description: 'Specify routes to reject' },
    { keyword: 'permit', description: 'Specify routes to forward' },
  ],
};

const numeroDeListe = (description: string): ArgumentSpec => ({
  name: 'numero', type: 'INT', range: FILTER_LIST_RANGE, description,
});

export interface FilterListHost {
  asPathLists(): Map<string, string[]>;
  communityLists(): Map<string, string[]>;
  recordConfigLine(line: string): void;
}

function ajouter(store: Map<string, string[]>, cle: string, regle: string): void {
  const liste = store.get(cle) ?? [];
  liste.push(regle);
  store.set(cle, liste);
}

/**
 * Les deux filtres BGP que le trie servait en GLOUTON.
 *
 * `ip as-path access-list` et `ip community-list` posaient chacun leur
 * numero par un controle ecrit a la main dans le gestionnaire, puis
 * recopiaient TOUT le reste comme regle. Ils sont declares : le numero
 * porte sa plage, l'action est une place, et l'expression reguliere ou
 * la valeur de communaute est la seule chose qui reste libre — ce qui
 * est juste, une expression pouvant contenir n'importe quoi.
 */
export function bgpFilterListSpecs(ctx: () => FilterListHost): CommandSpec[] {
  const expression = (nom: string, description: string): ArgumentSpec =>
    ({ name: nom, type: 'REST', literal: 'LINE', description });

  const communaute = (
    id: string, mots: readonly (string | ArgumentSpec)[],
    cle: (args: Record<string, string>) => string,
    saisie: (args: Record<string, string>) => string,
  ): CommandSpec => ({
    id,
    path: ['ip', 'community-list', ...mots, FILTER_ACTION,
      expression('valeur', 'Community value or regular expression')],
    description: 'Define BGP community list',
    modes: MODES, minPrivilege: 15,
    run: (_session, args) => {
      const regle = `${args.action} ${args.valeur}`;
      ajouter(ctx().communityLists(), cle(args), regle);
      ctx().recordConfigLine(`ip community-list ${saisie(args)} ${regle}`);
      return '';
    },
  });

  const nomDeCommunaute: ArgumentSpec = {
    name: 'nom', type: 'WORD', description: 'Community list name',
  };

  return [
    {
      id: 'ip-as-path-access-list',
      path: ['ip', 'as-path', 'access-list',
        numeroDeListe('AS path access list number'), FILTER_ACTION,
        expression('expression', 'A regular expression to match the BGP AS paths')],
      description: 'Define BGP AS-path filter',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        const regle = `${args.action} ${args.expression}`;
        ajouter(ctx().asPathLists(), args.numero, regle);
        ctx().recordConfigLine(
          `ip as-path access-list ${args.numero} ${regle}`);
        return '';
      },
    },
    communaute('ip-community-list-standard', ['standard', nomDeCommunaute],
      (args) => `standard ${args.nom}`, (args) => `standard ${args.nom}`),
    communaute('ip-community-list-expanded', ['expanded', nomDeCommunaute],
      (args) => `expanded ${args.nom}`, (args) => `expanded ${args.nom}`),
    /*
     * La CLE du magasin est `<sorte> <nom>` — c'est ce que `show ip
     * community-list` redecoupe pour ecrire « Community standard list
     * MACOMM » — et une liste NUMEROTEE est standard. La configuration,
     * elle, rend le NUMERO nu, parce que c'est ce que l'operateur a
     * tape et que la configuration est rejouee a l'import.
     */
    communaute('ip-community-list-numbered', [numeroDeListe('Community list number')],
      (args) => `standard ${args.numero}`, (args) => args.numero),
  ];
}

/**
 * `ge` et `le` sont des OPTIONS, pas une suite.
 *
 * IOS les accepte dans les deux ordres, et le trie les lisait par une
 * boucle qui rejugeait a chaque tour si le mot etait l'un ou l'autre.
 * Le sac d'options porte cette regle une fois pour tout le socle, avec
 * la borne de la famille d'adresses — c'est ce qui refuse `ge 33` sur
 * une liste IPv4 sans que le gestionnaire ait a le redire.
 */
function bornesDeLongueur(v6: boolean): OptionSpec[] {
  const plafond = v6 ? 128 : 32;
  return [
    {
      keyword: 'ge', description: 'Minimum prefix length to be matched',
      argument: {
        name: 'ge', type: 'INT', range: [0, plafond],
        description: 'Minimum prefix length',
      },
    },
    {
      keyword: 'le', description: 'Maximum prefix length to be matched',
      argument: {
        name: 'le', type: 'INT', range: [0, plafond],
        description: 'Maximum prefix length',
      },
    },
  ];
}

/**
 * La condition qu'IOS pose sur les trois longueurs : `len < ge <= le`.
 *
 * Elle ne peut pas se declarer — elle lie trois valeurs entre elles —
 * donc elle reste dans le gestionnaire, et son message est celui d'IOS.
 */
function respecteLenGeLe(
  longueur: number, ge: number | undefined, le: number | undefined, plafond: number,
): boolean {
  if (ge === undefined && le === undefined) return true;
  if (ge !== undefined && le !== undefined) {
    return longueur < ge && ge <= le && le <= plafond;
  }
  const seule = (ge ?? le) as number;
  return longueur < seule && seule <= plafond;
}

const NOM_DE_LISTE = (v6: boolean): ArgumentSpec => ({
  name: 'nom', type: 'WORD',
  description: v6 ? 'Name of an IPv6 prefix list' : 'Name of a prefix list',
});

/**
 * Les listes de prefixes, IPv4 et IPv6, declarees par la MEME fonction.
 *
 * Elles ne different que par trois choses — le premier mot, le type de
 * prefixe, le plafond des longueurs — et le trie en portait deux
 * enregistrements gloutons plus deux pour la negation, dont un
 * gestionnaire commun paramere par un booleen. Ce qui manquait n'etait
 * pas la separation mais la DECLARATION : `ip prefix-list LISTE
 * description ma liste` — une forme reelle d'IOS, celle qu'un operateur
 * ecrit avant de remplir sa liste — etait refuse, l'analyse cherchant
 * une action la ou il y a un mot-cle.
 */
export function prefixListSpecs(repo: () => PolicyRepository): CommandSpec[] {
  const out: CommandSpec[] = [];

  for (const v6 of [false, true]) {
    const tete = v6 ? 'ipv6' : 'ip';
    const suffixe = v6 ? '-v6' : '';
    const nom = NOM_DE_LISTE(v6);
    const plafond = v6 ? 128 : 32;
    const prefixe: ArgumentSpec = {
      name: 'prefixe', type: v6 ? 'IPV6_PREFIX' : 'IP_PREFIX',
      description: v6 ? 'IPv6 prefix <network>/<length>' : 'IP prefix <network>/<length>',
    };
    const description = v6 ? 'Build an IPv6 prefix list' : 'Build a prefix list';

    const poser = (args: Record<string, string>, seq: number | undefined): string => {
      const longueur = cidrPrefixLength(args.prefixe, v6) as number;
      const entry: PrefixListEntry = {
        seq: seq ?? repo().nextPrefixSeq(args.nom, v6),
        action: args.action as 'permit' | 'deny',
        prefix: args.prefixe,
      };
      if (args.ge !== undefined) entry.ge = Number(args.ge);
      if (args.le !== undefined) entry.le = Number(args.le);
      if (!respecteLenGeLe(longueur, entry.ge, entry.le, plafond)) {
        return `% Invalid prefix range for ${args.prefixe}, make sure: len < ge <= le`;
      }
      repo().addPrefix(args.nom, entry, v6);
      return '';
    };

    const oter = (args: Record<string, string>): string => {
      repo().removePrefixList(args.nom,
        args.seq === undefined ? undefined : Number(args.seq), v6);
      return '';
    };

    out.push(
      {
        id: `${tete}-prefix-list-seq`,
        path: [tete, 'prefix-list', nom, 'seq',
          { name: 'seq', type: 'INT', range: PREFIX_SEQ_RANGE,
            description: 'Sequence number' },
          FILTER_ACTION, prefixe],
        description,
        modes: MODES, minPrivilege: 15,
        options: bornesDeLongueur(v6),
        run: (_session, args) => poser(args, Number(args.seq)),
        undo: (_session, args) => oter(args),
      },
      {
        id: `${tete}-prefix-list-entry`,
        path: [tete, 'prefix-list', nom, FILTER_ACTION, prefixe],
        description,
        modes: MODES, minPrivilege: 15,
        options: bornesDeLongueur(v6),
        run: (_session, args) => poser(args, undefined),
        undo: (_session, args) => oter(args),
      },
      {
        id: `${tete}-prefix-list-description`,
        path: [tete, 'prefix-list', nom, 'description',
          { name: 'texte', type: 'REST', literal: 'LINE',
            description: 'Up to 80 characters describing this prefix list' }],
        description,
        modes: MODES, minPrivilege: 15,
        run: (_session, args) => {
          repo().setPrefixDescription(args.nom, args.texte, v6);
          return '';
        },
        undo: (_session, args) => {
          repo().setPrefixDescription(args.nom, undefined, v6);
          return '';
        },
      },
      /*
       * `no ip prefix-list LISTE` et `no ip prefix-list LISTE seq 5` sont
       * les deux formes qui n'ont PAS de positif : on ne declare pas une
       * liste vide, on la remplit. `existsOnlyNegated` dit exactement
       * cela, et les deux noeuds portent par ailleurs les entrees
       * ci-dessus — un noeud peut etre une commande ET un chemin.
       */
      {
        id: `${tete}-prefix-list-no`,
        path: [tete, 'prefix-list', nom],
        description,
        undoDescription: `Remove ${description.toLowerCase()}`,
        modes: MODES, minPrivilege: 15,
        existsOnlyNegated: true,
        run: () => '% Incomplete command.',
        undo: (_session, args) => oter(args),
      },
      {
        id: `${tete}-prefix-list-no-seq`,
        path: [tete, 'prefix-list', nom, 'seq',
          { name: 'seq', type: 'INT', range: PREFIX_SEQ_RANGE,
            description: 'Sequence number' }],
        description,
        undoDescription: `Remove ${description.toLowerCase()}`,
        modes: MODES, minPrivilege: 15,
        existsOnlyNegated: true,
        run: () => '% Incomplete command.',
        undo: (_session, args) => oter(args),
      },
    );
  }

  return out;
}
