/**
 * La barre de nano annoncait DIX raccourcis la ou le vrai en annonce DOUZE,
 * et son titre disait `[view]' pour un etat que nano ecrit `View'.
 *
 * MESURE DE DEPART sur `4ed57f22', dans `NanoEditor.tsx' :
 *
 *   barre, edition :  ^G Help   ^O Write Out  ^W Where Is  ^K Cut   ^T Execute
 *                     ^X Exit   ^R Read File  ^\ Replace   ^U Paste ^J Justify
 *   barre, vue :      ^G Help   ^W Where Is
 *                     ^X Exit   ^_ Go To Line
 *   titre, lecture seule : [view]
 *   titre, fichier neuf  : New Buffer, dans l'emplacement d'ETAT
 *
 * AUTORITE. GNU nano 7.2, le binaire de l'Ubuntu 24.04.4 hote de cette
 * session, pilote sur un pty, et la source `nano-editor/nano'.
 * Transcriptions capturees :
 *
 *   $ nano n1.txt
 *       GNU nano 7.2            n1.txt
 *       [ Reading... ][ Read 4 lines ]
 *       ^G Help  ^O Write Out  ^W Where Is  ^K Cut    ^T Execute  ^C Location
 *       ^X Exit  ^R Read File  ^\ Replace   ^U Paste  ^J Justify  ^/ Go To Line
 *
 *   $ nano -v n1.txt
 *       GNU nano 7.2            n1.txt            View
 *       ... la MEME barre, entiere ...
 *
 *   $ nano                  (sans fichier)
 *       GNU nano 7.2          New Buffer
 *       [ Welcome to nano.  For basic help, type Ctrl+G. ]
 *
 * QUATRE ECARTS.
 *
 * 1. DEUX RACCOURCIS MANQUAIENT a chaque rangee : `^C Location' et
 *    `^/ Go To Line'. Le vrai nano en aligne six par rangee depuis la 5.0.
 *
 * 2. LE MODE VUE REDUISAIT LA BARRE a quatre entrees. Le vrai nano garde
 *    la barre ENTIERE et marque l'etat dans le TITRE. Reduire la barre
 *    etait un choix defendable en soi — il n'annonce que ce qui agit —
 *    mais ce n'est pas ce que fait nano, et c'est nano que l'on imite.
 *
 * 3. `^_' EST L'ANCIEN RACCOURCI. `global.c:1241' definit
 *    `SLASH_OR_DASH' comme `"^/"' (ou `"^-"' sur un VT). `^_' fonctionne
 *    toujours, mais la barre affiche `^/' depuis la 5.0.
 *
 * 4. LE TITRE N'A QUE TROIS ETATS. `winio.c:2014' le dit mot pour mot :
 *    « The state of the current buffer -- "Modified", "View", or "" ».
 *    Ni `[view]', ni `New Buffer' : ce dernier est le NOM que porte un
 *    tampon sans fichier (`files.c:543'), au CENTRE du titre, et jamais un
 *    etat. Un fichier neuf mais nomme n'affiche donc rien a cette place —
 *    c'est `[ New File ]' qui le dit, dans la barre d'etat.
 *
 * OU CELA VIVAIT. Ces quatre faits etaient enfermes dans `NanoEditor.tsx',
 * hors d'atteinte d'un test sans moteur de rendu. Ils passent dans
 * `editorRender', dont l'en-tete dit deja porter « la geometrie d'ecran
 * gardee hors des moteurs » ; le composant et cette sonde lisent
 * desormais la meme source.
 *
 * MESURE, ET CE QU'ELLE VAUT. Les neuf cas tombent sur `4ed57f22', mais
 * pour une raison qu'il faut dire : ce lot DEPLACE ces quatre faits, donc
 * `editorRender' n'exporte encore rien a stasher et la sonde ne compile
 * meme pas contre l'ancien etat. Une discrimination par `git stash' ne
 * prouverait donc rien ici, et je ne la fais pas passer pour une mesure.
 *
 * Ce qui tient lieu de mesure est la transcription du DEBUT de cet
 * en-tete : les tables de `NanoEditor.tsx' sont citees telles qu'elles
 * etaient, et chacun des quatre ecarts se lit en les comparant aux
 * captures du binaire juste en dessous. Deux cas gardent le role de
 * temoin en portant ce qui NE devait pas changer :
 *   - TEMOIN : la rangee d'edition commencait DEJA par `^G Help' et
 *     `^X Exit', et les garde ;
 *   - NON-REGRESSION : `Modified' pour un tampon modifie et `New Buffer'
 *     pour un tampon sans nom etaient deja justes, et le restent.
 */
import { describe, it, expect } from 'vitest';
import {
  nanoEditShortcutRows, nanoTitleState, nanoTitleName,
} from '@/network/devices/linux/editors/editorRender';

type Rangees = readonly (readonly (readonly [string, string])[])[];

const edition = (): Rangees => nanoEditShortcutRows();
const vue = (): Rangees => nanoEditShortcutRows();

const aplati = (rows: Rangees): string =>
  rows.map(r => r.map(([k, l]) => `${k} ${l}`).join('  ')).join(' | ');

describe('la barre et le titre de nano disent ce que nano dit', () => {
  it('TEMOIN : la barre d edition commence par ^G Help et ^X Exit', () => {
    const rows = edition();
    expect(rows[0][0]).toEqual(['^G', 'Help']);
    expect(rows[1][0]).toEqual(['^X', 'Exit']);
  });

  it('chaque rangee porte SIX raccourcis', () => {
    const rows = edition();
    expect(rows[0]).toHaveLength(6);
    expect(rows[1]).toHaveLength(6);
  });

  it('`^C Location` et `^/ Go To Line` ferment les rangees', () => {
    const rows = edition();
    expect(rows[0][5]).toEqual(['^C', 'Location']);
    expect(rows[1][5]).toEqual(['^/', 'Go To Line']);
  });

  it('la barre entiere est celle du vrai nano', () => {
    expect(aplati(edition())).toBe(
      '^G Help  ^O Write Out  ^W Where Is  ^K Cut  ^T Execute  ^C Location'
      + ' | ^X Exit  ^R Read File  ^\\ Replace  ^U Paste  ^J Justify  ^/ Go To Line');
  });

  it('la barre garde ce que le mode vue retranchait', () => {
    const barre = aplati(vue());
    for (const raccourci of ['^O Write Out', '^K Cut', '^U Paste', '^R Read File']) {
      expect(barre).toContain(raccourci);
    }
  });

  it('plus aucun `^_` dans la barre', () => {
    expect(aplati(vue())).not.toContain('^_');
    expect(aplati(edition())).not.toContain('^_');
  });

  it('l etat du titre en lecture seule est `View`', () => {
    expect(nanoTitleState({ readOnly: true, modified: false })).toBe('View');
  });

  it('un fichier neuf mais nomme n a PAS d etat de titre', () => {
    expect(nanoTitleState({ readOnly: false, modified: false })).toBe('');
    expect(nanoTitleName('/tmp/brandnew.txt')).toBe('/tmp/brandnew.txt');
  });

  it('NON-REGRESSION : un tampon modifie porte `Modified`, et sans nom `New Buffer`', () => {
    expect(nanoTitleState({ readOnly: false, modified: true })).toBe('Modified');
    expect(nanoTitleName('')).toBe('New Buffer');
  });
});
