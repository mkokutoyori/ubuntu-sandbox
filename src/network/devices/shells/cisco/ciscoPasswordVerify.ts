/**
 * Verifier un mot de passe Cisco contre la FORME STOCKEE.
 *
 * Le pendant lecture de `ciscoPasswordRender.ts`, et il manquait. Toutes
 * les portes d'acces de ce depot comparaient le mot de passe tape a
 * `stocke === saisi`, ce qui n'est juste que dans le seul cas ou la forme
 * stockee est le texte en clair. Trois situations tres ordinaires la
 * rendent fausse, et dans chacune la machine refuse le BON mot de passe
 * pour toujours :
 *
 * 1. `service password-encryption` — la commande que tout operateur tape
 *    juste apres avoir pose un mot de passe — reecrit la valeur en type 7
 *    au moment de la configuration.
 * 2. Les formes a condense deja calcule qu'on colle depuis une
 *    configuration existante : `enable secret 5 $1$...`,
 *    `enable password 7 0822455D0A16`.
 * 3. **L'aller-retour d'une topologie.** `show running-config` REND le
 *    condense (c'est son role : IOS ne reaffiche jamais un mot de passe en
 *    clair), et l'import rejoue cette configuration. Donc meme un secret
 *    pose en clair devient un condense des la premiere sauvegarde, et la
 *    machine rouverte refuse le mot de passe que l'apprenant vient de
 *    choisir. Mesure : `enable secret MonSecret1` ressort en
 *    `enable secret 5 $1$a38effcc$3fSShOKFha.TXFAu34YEB/`.
 *
 * Ce que fait une vraie machine, et qui est la seule regle a retenir : un
 * condense se VERIFIE en recalculant avec le meme sel, un chiffre
 * reversible se DECHIFFRE. Le type 7 est un chiffre de Vigenere a cle
 * fixe — c'est precisement pourquoi Cisco le documente comme un
 * obscurcissement et non comme une securite : il se dechiffre.
 *
 * Le choix se fait sur le PREFIXE de la valeur stockee et non sur
 * l'etiquette d'algorithme, exactement comme `cryptPrefixType` cote
 * rendu : c'est la valeur qui dit ce qu'elle est, et une etiquette qui la
 * contredirait (un `$9$` range sous `enable secret 5`) ne doit pas
 * decider a sa place.
 */

import { md5Crypt, ciscoType8, ciscoType9, decryptType7 } from '@/crypto';

/** Decoupe une chaine `$<id>$<sel>$<condense>` ; null si ce n'en est pas une. */
function decouperCrypt(valeur: string): { id: string; sel: string } | null {
  const m = /^\$(1|8|9)\$([^$]*)\$/.exec(valeur);
  if (!m) return null;
  return { id: m[1], sel: m[2] };
}

/**
 * Le mot de passe tape ouvre-t-il cette porte ?
 *
 * @param saisi  Ce que l'operateur vient de taper, en clair.
 * @param stocke La forme conservee par l'equipement.
 * @param algo   L'etiquette rangee a cote (`plain`, `md5`, `type-7`, ...),
 *               consultee seulement quand la valeur ne se decrit pas
 *               elle-meme.
 */
export function ciscoPasswordMatches(saisi: string, stocke: string, algo?: string): boolean {
  if (stocke === '') return false;

  const crypt = decouperCrypt(stocke);
  if (crypt) {
    // Un sel vide ne peut pas produire le condense d'origine : refuser
    // plutot que de recalculer sur du vide, qui donnerait une egalite
    // fortuite entre deux entrees malformees.
    if (crypt.sel === '') return false;
    try {
      switch (crypt.id) {
        case '1': return md5Crypt(saisi, crypt.sel) === stocke;
        case '8': return ciscoType8(saisi, crypt.sel) === stocke;
        case '9': return ciscoType9(saisi, crypt.sel) === stocke;
      }
    } catch { return false; }
    return false;
  }

  if (algo === 'type-7') {
    try { return decryptType7(stocke) === saisi; } catch { return false; }
  }

  // Ce depot range le reste en clair et n'en rend le condense qu'a
  // l'affichage : l'egalite est alors la bonne comparaison. Le dire vaut
  // mieux que de feindre de verifier un condense qui n'est pas la.
  return saisi === stocke;
}
