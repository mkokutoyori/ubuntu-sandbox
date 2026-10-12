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
 *
 * SUITE. Ces quatre faits ne vivent plus dans `editorRender' : la barre, le titre et
 * l'etat sont les rangees de `engine.screen', et la sonde les lit la ou le composant les
 * peint (80x24 : titre, rangee 0 ; barre, rangees 22 et 23). La barre complete a six colonnes
 * en 80 colonnes est rejouee sur le vrai nano par nano-screen-oracle.test.ts, a toutes les
 * largeurs ; ici ne restent que les faits nommes ci-dessus.
 */

import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { plainRowText } from '@/network/devices/linux/editors/screen/EditorScreen';

function open(options: { readOnly?: boolean; path?: string; isNew?: boolean } = {}): NanoEngine {
  const path = options.path ?? '/tmp/n1.txt';
  const nano = new NanoEngine(
    new InMemoryEditorFsContext({}), path, options.isNew === true ? '' : 'one\ntwo\n', options.isNew === true, options.readOnly === true,
    undefined, false, { displayName: path === '' ? '' : 'n1.txt' },
  );
  nano.resize(24, 80);
  return nano;
}

const barre = (nano: NanoEngine): [string, string] => {
  const rows = nano.screen.rows;
  return [plainRowText(rows[22]), plainRowText(rows[23])];
};

const titre = (nano: NanoEngine): string => plainRowText(nano.screen.rows[0]);

describe('la barre et le titre de nano disent ce que nano dit', () => {
  it('TEMOIN : la barre d edition commence par ^G Help et ^X Exit', () => {
    const [haut, bas] = barre(open());
    expect(haut.startsWith('^G Help')).toBe(true);
    expect(bas.startsWith('^X Exit')).toBe(true);
  });

  it('chaque rangee porte SIX raccourcis', () => {
    const [haut, bas] = barre(open());
    expect(haut.match(/\^[A-Z\\/]|M-./g)).toHaveLength(6);
    expect(bas.match(/\^[A-Z\\/]|M-./g)).toHaveLength(6);
  });

  it('`^C Location` et `^/ Go To Line` ferment les rangees', () => {
    const [haut, bas] = barre(open());
    expect(haut.trimEnd().endsWith('^C Location')).toBe(true);
    expect(bas.trimEnd().endsWith('^/ Go To Line')).toBe(true);
  });

  it('la barre entiere est celle du vrai nano', () => {
    const [haut, bas] = barre(open());
    expect(haut.replace(/\s+/g, ' ').trim()).toBe('^G Help ^O Write Out ^W Where Is ^K Cut ^T Execute ^C Location');
    expect(bas.replace(/\s+/g, ' ').trim()).toBe('^X Exit ^R Read File ^\\ Replace ^U Paste ^J Justify ^/ Go To Line');
  });

  it('la barre garde ce que le mode vue retranchait', () => {
    const [haut, bas] = barre(open({ readOnly: true }));
    for (const raccourci of ['^O Write Out', '^K Cut', '^U Paste', '^R Read File']) {
      expect(`${haut}${bas}`).toContain(raccourci);
    }
  });

  it('plus aucun `^_` dans la barre', () => {
    const [haut, bas] = barre(open());
    expect(`${haut}${bas}`).not.toContain('^_');
  });

  it('l etat du titre en lecture seule est `View`', () => {
    expect(titre(open({ readOnly: true })).trimEnd().endsWith('View')).toBe(true);
  });

  it('un fichier neuf mais nomme n a PAS d etat de titre', () => {
    const rangee = titre(open({ isNew: true }));
    expect(rangee).not.toContain('Modified');
    expect(rangee).not.toContain('View');
    expect(rangee).toContain('n1.txt');
  });

  it('NON-REGRESSION : un tampon modifie porte `Modified`, et sans nom `New Buffer`', () => {
    const modifie = open();
    modifie.applyKey({ key: 'x', ctrl: false });
    expect(titre(modifie).trimEnd().endsWith('Modified')).toBe(true);
    expect(titre(open({ path: '', isNew: true }))).toContain('New Buffer');
  });
});
