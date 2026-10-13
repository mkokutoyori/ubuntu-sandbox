/**
 * Les options d'edition de nano rejouees contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py --corpus
 * edit, `nano -I`) : chaque cas met une option en vedette (`-i -E -T3 -T4 -A -k -Z -L -y -W -X -j -O`) avec zero a
 * deux autres, un tampon aux lignes indentees, suivies de blancs ou ponctuees, 10 a 24 lignes de pane, des
 * touches d'edition et de deplacement, la marque (`M-a`), `^K` `M-6` `^U`, et des `^O Enter`.  Apres chaque etape on
 * compare les rangees du pane, la cellule du curseur ET le contenu des fichiers du repertoire (le recorder les
 * relit apres chaque touche), si bien que `-E`, `-L` ou l'ecriture d'une selection sont verifies sur le disque.
 *
 * Methode : text.c (do_tab, do_enter, do_indent, do_unindent), cut.c (do_snip, extract_segment, copy_text,
 * zap_text), move.c (do_home, do_next_word, do_page_up / down, do_up / down) et chars.c (is_word_char) de nano 8.x,
 * confrontes au binaire 7.2 qui fait foi.  Trouve en route et corrige : `^O` avec un nom vide dit « Cancelled »
 * au lieu d'ecrire ; `^O` avec une marque n'ecrit que la selection (« Wrote N lines » compte ses lignes, Modified
 * est conserve) ; le tampon de coupe est une liste de lignes dont la derniere est partielle, `^K` consecutifs et
 * `M-6` consecutifs s'y ajoutent, une coupe apres une copie repart de zero ; `Tab` avec une marque sur une AUTRE
 * ligne indente le bloc (`M-}` et `M-{` indentent et desindentent) ; la marque suit le texte quand `Enter`, une
 * suppression, un collage ou une jointure de lignes le deplace ; la colonne souhaitee survit a une invite ;
 * couper la ligne du haut de la fenetre garde la rangee du curseur ; avec `-L` le tampon n'a pas de ligne magique
 * ajoutee et le fichier n'est pas termine par un saut de ligne.
 *
 * Tous les cas sont rejoues (SCREEN_PORTED_FLAGS couvre les options en vedette).  Les 23 cas `-O` (bookstyle) par seed
 * n'ont ete portes qu'avec la justification (nano-wrap-oracle.test.ts) : sur le moteur d'avant, 8 sur 300 (seed
 * 1), 14 sur 300 (seed 2) et 17 sur 300 (seed 3) tombaient.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : au premier increment (options d'edition,
 * sur les 277 cas hors `-O`) 186 cas sur 277 (seed 1), 177 sur 277 (seed 2) et 182 sur 277 (seed 3) tombaient
 * avant, 0 apres.  Les seeds 1 a 3 ont ete enregistres ensemble une fois le premier corpus (non retenu) ayant
 * montre que les options passaient « a vide » faute d'etre exercees.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { screenIsPorted } from '../../support/oracle/nanoCliReplay';
import { recordedArguments, replayNanoScreenCase, type NanoScreenCase } from '../../support/oracle/nanoScreenReplay';

const dir = 'src/__tests__/support/oracle/nano-edit';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoScreenCase[] }) }));

describe('nano editing options recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows, cursor cell and file on disk`, () => {
      const ported = fixture.cases.filter((c) => screenIsPorted(recordedArguments(c)));
      expect(ported.length).toBeGreaterThan(200);
      const failures = ported.map((c) => replayNanoScreenCase(c)).filter((f): f is string => f !== null);
      expect(failures.length > 0 ? `${failures.length} of ${ported.length}\n${failures.slice(0, 3).join('\n')}` : '').toBe('');
    });
  }
});
