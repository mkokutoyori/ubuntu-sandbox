/*
 * Sonde de `-o` (--operatingdir) de nano, un laboratoire minimal par regle, enregistres sur nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus cli --from labs.json --workdir /tmp/nano-lab, tmux 3.4) : rangees du
 * pane, cellule du curseur, attributs et fichiers du repertoire apres chaque etape.  Le repertoire de travail de
 * chaque cas (`casedir`) est enregistre : les messages portent le chemin absolu du repertoire d'operation, que le
 * rejeu reconstruit a l'identique (InMemoryEditorFsContext prend un repertoire de travail).
 *
 * Methode : init_operating_dir(), outside_of_confinement() et get_full_path() de files.c, open_buffer() et
 * write_file() (nano 8.x) confrontes au binaire 7.2 : nano change de repertoire vers le repertoire d'operation,
 * qu'il garde sous sa forme canonique terminee par « / » ; un nom est dehors quand son chemin canonique (liens
 * symboliques resolus, composante finale absente tolérée) ne commence pas par cette chaine, d'ou un frere dont le
 * nom commence pareil (`sub2` pour `sub`) dehors ; ouvrir dehors laisse un tampon vide « New Buffer » et dit
 * « Can't read file from outside of ROOT » (en alerte), ^R dit la meme chose, ecrire dehors dit « Can't write
 * outside of ROOT » apres les questions habituelles, l'invite de ^R porte ROOT a la place de « ./ », ^T lance sa
 * commande dans le repertoire d'operation, et un repertoire absent ou qui n'en est pas un tue nano avant l'ecran
 * (« Invalid operating directory: X », code 1).  Le navigateur de fichiers (^T d'une invite) et la completion par
 * Tab, qui lisent aussi ce repertoire, ne sont pas portes.
 *
 * Mesure avec `git stash push -- src/network/devices/linux/editors/NanoEngine.ts` et le message d'alerte (le lanceur
 * editorLaunch, qui resout le nom et valide le repertoire, restant celui d'apres) : 17 des 32 tests tombent, 0
 * apres.  Les 15 qui passent avant comme apres : le test de chargement (structurel), op-witness (TEMOIN : sans `-o`
 * le nom est relatif au repertoire courant), op-open-inside, op-open-nested, op-open-dotdot-inside, op-open-new,
 * op-open-missing-dir, op-save-exit, op-backup, op-long et op-view (la resolution du nom se fait dans le lanceur,
 * pas dans le moteur ; ils verifient que le moteur ne la defait pas), op-invalid et op-invalid-file (la validation
 * aussi).  Le terminal local et l'executeur non interactif sont couverts par
 * probe-nano-operatingdir-terminal.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-operatingdir/operatingdir-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano -o, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(31);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
