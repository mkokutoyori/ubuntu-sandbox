/**
 * Les deplacements par paragraphe et par bloc et l'invite « Go To Line » de nano rejoues contre un vrai GNU nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus blocks, `nano -I`) : 600 sessions (4 x 150, seeds 1 a 4) sur des
 * textes a paragraphes, lignes blanches, indentations changeantes et prefixes de citation (`> `, `# `, `// `), dans des
 * fenetres de 6 x 40 a 24 x 80, avec 0 a 2 options parmi `-x -l -S -i -O -e -% -_ -v -R -0 -j`.  Les gestes melent M-( M-)
 * M-9 M-0 (debut et fin de paragraphe), M-7 M-8 ^Haut ^Bas (bloc precedent et suivant), les deplacements simples, des
 * invites Go To Line (numero, ligne,colonne, ,colonne, ^Y ^V ^W ^O ^T ^_ ^C Entree, avec Gauche, ^K, ^U) et des invites
 * de recherche ouvertes pour y retrouver ^Y ^V ^T ^_ et les touches d'edition d'une reponse (^Gauche ^Droite ^B ^F ^A ^E
 * ^D ^H).  Apres chaque etape on compare les rangees du pane, la cellule du curseur et les fichiers du repertoire.
 *
 * Methode : move.c (to_para_begin, to_para_end, to_prev_block, to_next_block), justify.c (do_para_begin, do_para_end,
 * begpar, inpar : les memes que la justification, JustifyContext), prompt.c (do_statusbar_input, do_statusbar_prev_word,
 * do_statusbar_next_word) et search.c (goto_line_and_column, flip_goto) de nano 8.x confrontes au binaire 7.2 qui fait foi.
 * Les mouvements sont des fonctions pures sur les lignes (nano/NanoMotion.ts) ; le saut par mot de l'edition et celui du
 * champ d'une invite sont les deux memes fonctions.
 *
 * Ce que le binaire 7.2 a montre : la fin de paragraphe va a la LIGNE SUIVANTE, colonne 0 (la ligne blanche, ou la ligne
 * magique, ou la fin de la derniere ligne s'il n'y en a pas) ; ^Haut et ^Bas sont les blocs, M-7 et M-8 aussi, M-{ et M-}
 * ne sont pas des mouvements ; dans l'invite Go To Line ^Y ^V ^W ^O ferment l'invite et font le mouvement correspondant en
 * ignorant le texte tape, ^T et ^_ la changent en Search et inversement en gardant le texte ET la position du curseur de
 * la reponse ; un numero de ligne 0 vaut la premiere ligne alors qu'un numero OMIS (« ,3 ») garde la ligne courante et ne
 * recentre pas la fenetre ; une colonne omise ou 0 vaut la colonne souhaitee (placewewant + 1), et la colonne demandee, meme
 * au-dela de la ligne, devient la colonne souhaitee des deplacements verticaux suivants ; l'historique (Haut / Bas) ne
 * deplace pas le curseur de la reponse quand il ne change rien, ^Haut et ^Bas n'y sont pas l'historique ; Entree sur une
 * commande vide de ^T dit « Cancelled » ; M-} et M-{ sur des lignes vides ne touchent pas la colonne souhaitee ; ^H au tout
 * debut du tampon dit « ^W = Ctrl+W    M-W = Alt+W » sauf avec -x, -v, une marque, ou apres la moindre touche Alt de la
 * session.
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/NanoText.ts` (le moteur seul) : 141, 136, 134 et 134 sessions sur 150
 * tombaient avant (545 sur 600), 0 apres sauf les 5 cas ci-dessous.  Passent dans les deux cas 55 sessions dont les
 * touches nouvelles n'ont aucun effet visible (curseur deja au debut du texte, un seul paragraphe, touche ignoree dans
 * une invite) : elles servent de temoin que le laboratoire est sain.
 *
 * Divergences connues, mesurees et NON portees (UNPORTED_CASES) : 4 cas sur 600.  Un cas de la liste qui se met a passer
 * fait echouer le test pour qu'on le retire.
 *   - blo1-61, blo2-129, blo4-149 : avec -0, l'invite Go To Line couvre la derniere rangee de texte et nano ne la
 *     redessine pas quand l'invite se ferme par ^W ou ^O sans que la fenetre defile (edit_redraw ne repeint que l'ancienne
 *     et la nouvelle ligne courante) ; le moteur laisse la rangee vide a ce pas (blo1-21 passe depuis que c'est porte) mais la
 *     repeint a la touche suivante, alors que nano la laisse vide jusqu'au prochain rafraichissement complet.
 *   - blo1-139 : -S avec les numeros de ligne, « 2,99 » puis PageDown : la colonne souhaitee de 98 tombe sur un autre
 *     tronçon de la ligne repliee.
 * Non rejoue : l'invite Execute Command (^T de l'edition : ^S ^Y ^O et les erreurs de commande), le navigateur de fichiers
 * (^T de Write Out et de Read File).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

const dir = 'src/__tests__/support/oracle/nano-blocks';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoCliCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set(['blo1-61', 'blo1-139', 'blo2-129', 'blo4-149']);

describe('nano paragraph and block motions and the Go To Line prompt recorded from a real nano', () => {
  it('loads the recorded sessions', () => {
    expect(fixtures.map((fixture) => fixture.cases.length)).toEqual([150, 150, 150, 150]);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows, cursor cell and files on disk`, () => {
      const ported = fixture.cases.filter((c) => screenIsPorted(c.args));
      expect(ported.length).toBe(fixture.cases.length);
      const outcomes = ported.map((c) => ({ id: c.id, failure: replayNanoCliCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${ported.length}\n${unexpected.slice(0, 3).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});
