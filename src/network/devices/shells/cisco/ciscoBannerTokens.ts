/**
 * Les jetons d'une banniere IOS.
 *
 * `banner exec ^C Bienvenue sur $(hostname).$(domain) ^C` est une forme
 * qu'IOS substitue depuis la 12.0(3)T — la banniere n'etait rendue que
 * litteralement, donc un operateur qui suivait la documentation de Cisco
 * voyait `$(hostname)` s'afficher tel quel.
 *
 * La substitution a lieu a l'AFFICHAGE et non au rangement : le nom de
 * la machine peut changer apres qu'on a ecrit la banniere, et une
 * banniere figee au moment de la frappe annoncerait alors l'ancien nom.
 *
 * Quatre jetons existent, et seulement ceux-la. Les variables du genre
 * `$USERNAME` ou `$TIME` qu'on rencontre dans des tutoriels ne sont pas
 * des jetons IOS : elles restent du texte, exactement comme sur une
 * vraie machine — la fidelite est de ne PAS les remplacer.
 */
export interface BannerTokenSource {
  hostname(): string;
  domain(): string;
  /** Le numero de ligne active (`0` pour la console, `N` pour vty N). */
  line(): string;
  /** La description posee par `location` sur la ligne, vide si aucune. */
  lineDescription(): string;
}

const JETONS = /\$\((hostname|domain|line|line-desc)\)/gi;

export function expandBannerTokens(texte: string, source: BannerTokenSource): string {
  if (!texte || !texte.includes('$(')) return texte;
  return texte.replace(JETONS, (_tout, nom: string) => {
    switch (nom.toLowerCase()) {
      case 'hostname': return source.hostname();
      case 'domain': return source.domain();
      case 'line': return source.line();
      case 'line-desc': return source.lineDescription();
      default: return _tout;
    }
  });
}
