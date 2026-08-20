/**
 * PRD-Debug-Fidelite-Cisco.md, chantier A — depuis le lot D1, une ligne
 * de debug porte son estampe (`service timestamps debug`), comme sur un
 * vrai IOS.
 *
 * Les suites qui verifient CE QUE la ligne dit s'abonnent a travers
 * `collecteDebug`, qui retire l'estampe : elles decrivent un contenu,
 * pas une date. Celles qui verifient QUE la ligne est estampee — et que
 * la console et le tampon s'accordent — sont dans
 * `cisco-debug-one-line-one-rendering.test.ts`, qui lit la ligne
 * complete.
 *
 * Separer les deux est ce qui evite qu'un changement de format casse
 * cinquante assertions qui ne parlent pas de format.
 */

/** `*Aug  6 19:14:16.550: ` ou `00:12:34: ` ou `1d02h: `, selon le reglage. */
const ESTAMPE = /^(?:\*?[A-Z][a-z]{2}\s+\d+ \d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?|\d+[dw]\d+[hd])(?: [A-Z]{2,5})?: /;

export function sansEstampe(line: string): string {
  return line.replace(ESTAMPE, '');
}

export function estEstampee(line: string): boolean {
  return ESTAMPE.test(line);
}

export interface SourceDebug {
  subscribe(listener: (line: string) => void): () => void;
}

/**
 * S'abonne au canal de debug et range les lignes sans leur estampe.
 * Rend le tableau vivant, comme le faisait l'abonnement direct.
 */
export function collecteDebug(source: SourceDebug, into: string[] = []): string[] {
  source.subscribe((l) => into.push(sansEstampe(l)));
  return into;
}
