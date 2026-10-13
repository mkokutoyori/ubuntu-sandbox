/*
 * Sonde de la cible d'ouverture de nano (dossier, peripherique, lecture seule, dossier absent, chemin qui n'est pas un
 * dossier) et de ses suites a l'ecriture, un laboratoire minimal par regle, enregistres sur nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus cli --from, avec `disk: true`, `files`, `modes` et `hidden: true`).
 *
 * Ce que le binaire a montre : un dossier ou un peripherique n'ouvre PAS de fichier : tampon sans nom (« New Buffer »,
 * sans « View » meme avec -v) et l'alerte `"x" is a directory` / `"x" is a device file` a la place de l'accueil ; un
 * fichier dont le dossier n'existe pas garde son nom, avec `Directory 'p' does not exist` (p = dirname du nom tape) et
 * sans verrou ; un chemin qui traverse un fichier dit `Path 't.txt' is not a directory` ; `x/` inexistant reste « New
 * File » ; un fichier sans bit d'ecriture avertit le superutilisateur (`ro.txt is meant to be read-only`, meme avec -n)
 * et se lit et s'ecrit normalement.  A l'ecriture : `Error writing x: <raison>` (No such file or directory, Not a
 * directory, Is a directory, Permission denied) ; `nodir/` et `nodir` sont deux noms a comparer tels quels quand
 * get_full_path echoue (« Save file under DIFFERENT NAME? ») ; avec -_ l'ecriture ne dit pas « Wrote » mais affiche le
 * nombre de lignes dans la minibarre.  Une ouverture en vue seule garde sa grille d'invite d'ecriture a huit places, sans
 * M-A / M-P / M-B, meme apres le repli sur un tampon sans nom.
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/` (le moteur seul : les coutures de EditorFsContext restent) : 28
 * des 38 tests tombent, 0 apres ; passent dans les deux cas le test de chargement (structurel), open-file, open-new,
 * open-subdir-new, open-trailing-slash, open-dotslash et open-dotdot-path (chemins ordinaires), open-zero-write,
 * open-write-new-in-subdir et open-write-over-dir (le contexte en memoire refuse deja ces ecritures).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-open/open-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano open target, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(37);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
