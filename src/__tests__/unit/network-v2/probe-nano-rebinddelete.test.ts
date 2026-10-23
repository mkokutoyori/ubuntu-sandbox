/*
 * Sonde de `-d` (--rebinddelete) de nano, un laboratoire minimal par regle, enregistres sur nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus cli --from, tmux 3.4) : rangees du pane, cellule du curseur apres
 * chaque etape.  Le corpus aleatoire `edit` seed 4 de nano-edit-oracle.test.ts couvre le meme terrain a l'echelle ;
 * ici chaque cas nomme la regle qu'il isole.
 *
 * Methode : parse_kbinput() de winio.c (nano 8.x) confronte au binaire 7.2 : avec `-d` les codes de la touche
 * Retour arriere (DEL 0x7f, KEY_BACKSPACE) valent KEY_DC et le code de la touche Suppr vaut KEY_BACKSPACE, dans
 * la fenetre d'edition comme dans les invites ; ^H (0x08) et ^D (0x04) sont d'autres codes et ne bougent pas.
 *
 * Mesure avec `git stash push -- src/network` : 8 des 13 tests tombent sur le moteur d'avant (qui rangeait `-d`
 * dans les reglages sans jamais le lire), 0 apres.  Les 5 qui passent avant comme apres : le test de chargement
 * (structurel), rb-witness (TEMOIN : sans `-d` Retour arriere supprime avant le curseur et Suppr apres, ce qui
 * prouve que le laboratoire lit l'ecran), rb-ctrl-h (non-regression : ^H et ^D ne sont pas echanges), rb-zap
 * (l'echange est invisible : les deux touches zappent une selection avec `-Z`) et rb-view (la vue seule refuse
 * les deux touches).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-rebind/rebind-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano -d, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(12);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
