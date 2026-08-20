/**
 * Une CLI Cisco abrege — sur l'ASA aussi.
 *
 * La navigation de l'ASA comparait le mot entier, donc `conf t` et `en`,
 * les deux formes que tout operateur tape, repondaient
 * `% Invalid input detected`. Ce n'est pas un confort de frappe : c'est
 * un trait du produit, et une CLI Cisco qui ne l'a pas ne se comporte
 * pas comme une CLI Cisco.
 *
 * L'ambiguite fait partie de la meme regle et n'est pas separable : `e`
 * ouvre `enable`, `end` et `exit`, et choisir le premier de la liste
 * ferait executer une commande que personne n'a demandee. Un prefixe qui
 * designe plusieurs mots ne designe rien.
 */
export type AbbreviationMatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'unique'; readonly keyword: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] };

export function resolveAbbreviation(
  typed: string | undefined, vocabulary: readonly string[],
): AbbreviationMatch {
  if (typed === undefined || typed.length === 0) return { kind: 'none' };

  const lowered = typed.toLowerCase();
  const exact = vocabulary.find(word => word.toLowerCase() === lowered);
  if (exact) return { kind: 'unique', keyword: exact };

  const matches = vocabulary.filter(word => word.toLowerCase().startsWith(lowered));
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'unique', keyword: matches[0] };
  return { kind: 'ambiguous', candidates: matches };
}

export function expandsTo(
  typed: string | undefined, keyword: string, vocabulary: readonly string[],
): boolean {
  const match = resolveAbbreviation(typed, vocabulary);
  return match.kind === 'unique' && match.keyword === keyword;
}
