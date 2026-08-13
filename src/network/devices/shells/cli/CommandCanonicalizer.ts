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
}

function normalise(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/g, ' ');
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
    const saisie = normalise(command);
    if (saisie.length === 0) return null;
    for (const trie of this.source.triesFor(scope)) {
      const forme = this.canonicalIn(trie, saisie);
      if (forme !== null) return forme;
    }
    return null;
  }

  /**
   * La forme canonique, ou la saisie normalisee quand aucun arbre ne
   * connait la commande. C'est ce que veulent les appelants qui doivent
   * decider de TOUTE ligne, y compris d'une ligne inconnue.
   */
  canonicalOrSelf(scope: AuthScope, command: string): string {
    return this.canonical(scope, command) ?? normalise(command);
  }

  private canonicalIn(trie: CommandTrie, saisie: string): string | null {
    const r = trie.match(saisie);
    if (r.status !== 'ok' && r.status !== 'incomplete') return null;
    if (r.matchedKeywords.length === 0) return null;
    const mots = [...r.matchedKeywords, ...r.args];
    return normalise(mots.join(' '));
  }
}
