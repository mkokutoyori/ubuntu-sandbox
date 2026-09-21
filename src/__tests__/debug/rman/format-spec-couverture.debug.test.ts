/**
 * Suite de RELEVE (pas d'assertions de contrat) — `src/__tests__/debug/`.
 *
 * `docs/ASSESSMENT-RMAN.md` §6 liste ce qui n'a PAS pu etre source, et
 * la nomenclature des noms de pieces en fait partie :
 *
 *   « la nomenclature `%U`/`%d_%T_%s_%p` des noms de pieces »
 *
 * Elle est desormais sourcee — voir le message de commit. Ce banc mesure
 * l'ecart entre ce que RMAN documente et ce que `resolveFormatSpec`
 * substitue, en passant CHAQUE specificateur seul dans un FORMAT.
 *
 * Un specificateur non reconnu ressort TEL QUEL (`default: return
 * token`) : le nom de piece porte alors un `%x` litteral, ce qui se voit
 * — mais un operateur qui tape `%N` obtient `%N` dans son nom de
 * fichier, la ou une vraie base met le nom du tablespace.
 */
import { describe, it, expect } from 'vitest';
import { resolveFormatSpec } from '@/terminal/subshells/rman/core/formatSpec';

const note = (l: string) => { console.log(l); };

const CTX = {
  dbName: 'ORCL', dbId: 1234567890, activationId: 234567890,
  setNumber: 7, pieceNumber: 2, copyNumber: 1,
  logSequence: 42, logThread: 1,
  at: new Date('2026-03-09T14:05:06Z'),
  fileNumber: 4, tablespace: 'USERS',
};

/** Ce que la documentation RMAN nomme, dans l'ordre alphabetique d'Oracle. */
const DOCUMENTES: ReadonlyArray<readonly [string, string]> = [
  ['%a', 'activation ID de la base'],
  ['%c', 'numero de copie de la piece'],
  ['%d', 'nom de la base'],
  ['%D', 'jour du mois (DD)'],
  ['%e', 'numero de sequence du journal archive'],
  ['%f', 'numero absolu de fichier'],
  ['%F', 'c-IIIIIIIIII-YYYYMMDD-QQ'],
  ['%h', 'numero de thread du journal archive'],
  ['%I', 'DBID'],
  ['%M', 'mois (MM)'],
  ['%N', 'nom du tablespace'],
  ['%n', 'nom de la base, complete a droite par des x'],
  ['%p', 'numero de piece dans le jeu'],
  ['%s', 'numero du jeu de sauvegarde'],
  ['%t', 'horodatage du jeu de sauvegarde'],
  ['%T', 'date (YYYYMMDD)'],
  ['%u', 'nom court genere par le systeme'],
  ['%U', 'nom unique genere : %u_%p_%c pour une piece'],
  ['%Y', 'annee (YYYY)'],
  ['%%', 'un caractere % litteral'],
];

describe('couverture de la nomenclature FORMAT', () => {
  it('chaque specificateur documente, passe seul', () => {
    let substitues = 0;
    for (const [token, sens] of DOCUMENTES) {
      const rendu = resolveFormatSpec(token, CTX);
      const inchange = rendu === token;
      if (!inchange) substitues++;
      note(`[fmt] ${token}  ${inchange ? 'NON SUBSTITUE' : 'substitue    '}  ${
        JSON.stringify(rendu).padEnd(22)} ${sens}`);
    }
    note(`[fmt-total] ${substitues} substitues sur ${DOCUMENTES.length} documentes`);

    note(`[fmt-defaut] %U seul               : ${
      JSON.stringify(resolveFormatSpec('%U', CTX))}`);
    note(`[fmt-usuel]  %d_%T_%s_%p           : ${
      JSON.stringify(resolveFormatSpec('%d_%T_%s_%p', CTX))}`);
    note(`[fmt-inconnu] %z, hors documentation : ${
      JSON.stringify(resolveFormatSpec('/u01/%z.bkp', CTX))}`);
    expect(true).toBe(true);
  });
});
