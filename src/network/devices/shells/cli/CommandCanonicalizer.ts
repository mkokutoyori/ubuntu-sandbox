import type { CommandTrie } from '../CommandTrie';
import type { AuthScope } from './CliAuthorization';

/**
 * La resolution d'une abreviation vers la commande canonique.
 *
 * IOS resout `sh ver` en `show version` AVANT de decider quoi que ce
 * soit : l'autorisation, l'aide et la completion travaillent toutes sur
 * la forme canonique. Ce dépot comparait la chaine TAPEE a la chaine de
 * la regle, ce qui rendait le mecanisme des niveaux contournable en
 * tapant trois lettres de moins — et, dans l'autre sens, rendait une
 * commande deleguee inaccessible sous son abreviation la plus courante.
 *
 * Le module est isole pour qu'il n'en existe qu'une version : trois
 * lecteurs qui canonicalisent chacun a leur facon reproduiraient
 * exactement le defaut qu'on referme.
 */

/** D'ou viennent les arbres consultes pour un espace de nommage donne. */
export interface CanonicalisationSource {
  /**
   * Les arbres a consulter pour cet espace, du plus restreint au plus
   * large. Le premier qui reconnait la commande decide : c'est l'ordre
   * dans lequel la CLI elle-meme cherche.
   */
  triesFor(scope: AuthScope): readonly CommandTrie[];
  /**
   * La meme question posee au SOCLE, pour une commande migree.
   *
   * Une commande partie du trie n'y est plus reconnue, donc une regle
   * de niveau ecrite sur elle ne se canonicalisait plus et ne couvrait
   * plus rien : `privilege interface level 5 ip address` cessait
   * silencieusement de deleguer le jour ou `ip address` a migre. C'est
   * le pendant, pour la canonicalisation, de ce que
   * `niveauDeclareParLeSocle` fait pour le niveau par defaut.
   */
  socleParts?(
    scope: AuthScope, command: string,
  ): { keywords: string; full: string } | null;
}

function normalise(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/g, ' ');
}

function plusLong(
  candidat: { keywords: string },
  courant: { keywords: string } | null,
): boolean {
  if (courant === null) return true;
  return candidat.keywords.split(' ').length > courant.keywords.split(' ').length;
}

export class CommandCanonicalizer {
  constructor(private readonly source: CanonicalisationSource) {}

  /**
   * La forme canonique de `command`, ou `null` si aucun arbre de cet
   * espace ne la reconnait.
   *
   * Une abreviation AMBIGUE rend `null` plutot qu'un des candidats : la
   * resoudre arbitrairement ferait porter la decision d'autorisation sur
   * une commande que l'operateur n'a pas designee. Une commande
   * INCOMPLETE se canonicalise, parce que l'aide juge des lignes
   * incompletes par construction (`show ?`).
   *
   * Les arguments sont conserves tels qu'ils ont ete tapes : une regle
   * de niveau est un PREFIXE — `privilege exec level 5 ping` couvre
   * `ping 10.0.0.1` — donc les effacer changerait la portee des regles.
   */
  canonical(scope: AuthScope, command: string): string | null {
    return this.canonicalParts(scope, command)?.full ?? null;
  }

  /**
   * La forme canonique, separee en MOTS-CLES et forme complete.
   *
   * La distinction n'est pas cosmetique : une regle de niveau porte sur
   * une COMMANDE, pas sur ses arguments. `privilege configure level 5
   * hostname` doit gouverner `hostname R1` — meme commande, un argument
   * — sans gouverner `hostname` d'une sous-commande qui n'existe pas.
   * Comparer les chaines entieres confondait les deux, et il n'y a que
   * l'arbre pour les distinguer.
   */
  canonicalParts(
    scope: AuthScope, command: string,
  ): { keywords: string; full: string } | null {
    const saisie = normalise(command);
    if (saisie.length === 0) return null;
    /*
     * Le chemin le plus LONG gagne, et l'ordre des sources ne departage
     * que les egalites.
     *
     * Rendre la premiere reconnaissance faisait canonicaliser
     * `ip address` par `ip` des lors qu'un arbre plus LARGE portait une
     * autre famille `ip …` : la regle etait alors rangee sous `ip` a
     * l'ecriture et cherchee sous `ip address` a la lecture, donc
     * `privilege interface level 5 ip address` ne couvrait plus rien.
     * « Le plus specifique gagne » est deja la regle de la marche du
     * trie ; l'appliquer ici est ce qui empeche les deux de diverger.
     */
    let meilleur: { keywords: string; full: string } | null = null;
    for (const trie of this.source.triesFor(scope)) {
      const parts = this.partsIn(trie, saisie);
      if (parts !== null && plusLong(parts, meilleur)) meilleur = parts;
    }
    const socle = this.source.socleParts?.(scope, saisie) ?? null;
    if (socle !== null && plusLong(socle, meilleur)) meilleur = socle;
    return meilleur;
  }

  /** Les seuls MOTS-CLES de la forme canonique, arguments exclus. */
  keywordsOrSelf(scope: AuthScope, command: string): string {
    return this.canonicalParts(scope, command)?.keywords ?? normalise(command);
  }

  /**
   * La forme canonique, ou la saisie normalisee quand aucun arbre ne
   * connait la commande. C'est ce que veulent les appelants qui doivent
   * decider de TOUTE ligne, y compris d'une ligne inconnue.
   */
  canonicalOrSelf(scope: AuthScope, command: string): string {
    return this.canonical(scope, command) ?? normalise(command);
  }

  private partsIn(
    trie: CommandTrie, saisie: string,
  ): { keywords: string; full: string } | null {
    const r = trie.match(saisie);
    if (r.status !== 'ok' && r.status !== 'incomplete') return null;
    if (r.matchedKeywords.length === 0) return null;
    return {
      keywords: normalise(r.matchedKeywords.join(' ')),
      full: normalise([...r.matchedKeywords, ...r.args].join(' ')),
    };
  }
}
