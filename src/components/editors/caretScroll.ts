/**
 * Amener le curseur dans la vue, ce que `setSelectionRange` ne fait pas.
 *
 * Les deux éditeurs posaient le curseur avec `setSelectionRange` et
 * s'en remettaient au navigateur pour suivre. Firefox suit ; Chrome ne
 * suit PAS un `textarea` déplacé par programme. Conséquence : au-delà de
 * la hauteur visible, les flèches et `PageDown` déplaçaient un curseur
 * INVISIBLE — le texte ne bougeait plus, et l'éditeur paraissait bloqué
 * alors que le moteur avait bien avancé.
 *
 * Écrire `scrollTop` déclenche l'événement `scroll` que les deux
 * éditeurs écoutent déjà pour recaler la gouttière et les surcouches :
 * il n'y a donc rien à synchroniser en plus ici.
 */
export function lineHeightOf(ta: HTMLTextAreaElement, totalLines: number): number {
  const computed = parseFloat(getComputedStyle(ta).lineHeight);
  if (Number.isFinite(computed) && computed > 0) return computed;
  if (totalLines > 0 && ta.scrollHeight > 0) return ta.scrollHeight / totalLines;
  return 0;
}

export function scrollCaretIntoView(
  ta: HTMLTextAreaElement,
  caretLine: number,
  totalLines: number,
): void {
  const lh = lineHeightOf(ta, totalLines);
  const viewport = ta.clientHeight;
  if (lh <= 0 || viewport <= 0) return;

  const top = caretLine * lh;
  if (top < ta.scrollTop) {
    ta.scrollTop = top;
    return;
  }
  const bottom = top + lh;
  if (bottom > ta.scrollTop + viewport) {
    ta.scrollTop = bottom - viewport;
  }
}
