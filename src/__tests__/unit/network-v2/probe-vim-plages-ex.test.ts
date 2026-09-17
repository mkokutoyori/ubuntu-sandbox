/**
 * `:d' — et toute commande ex a PLAGE — repondait « cette commande
 * n'existe pas ».
 *
 * MESURE DE DEPART sur `f5bee256', sur un tampon de quatre lignes
 * (alpha, bravo, charlie, delta) :
 *
 *   :d        -> E492: Not an editor command: d          4 lignes
 *   :2d       -> E492: Not an editor command: 2d         4 lignes
 *   :1,2d     -> E492: Not an editor command: 1,2d       4 lignes
 *   :%d       -> E492: Not an editor command: %d         4 lignes
 *   :.,$d     -> E492: Not an editor command: .,$d       4 lignes
 *   :$d       -> E492: Not an editor command: $d         4 lignes
 *   :1,99d    -> E492: Not an editor command: 1,99d      4 lignes
 *   :3,1d     -> E492: Not an editor command: 3,1d       4 lignes
 *   :set zorglub     -> E492: Not an editor command: set zorglub
 *   :set tabstop=abc -> E492: Not an editor command: set tabstop=abc
 *
 * `E492' dit a l'operateur que la commande N'EXISTE PAS. Or `:d' existe,
 * `:%d' existe, et `set' existe : ce qui manquait etait le gestionnaire,
 * pas la commande. Repondre « inconnue » a une commande qu'un vrai vim
 * execute est le pire des trois refus que la regle 6 distingue — il
 * envoie chercher une faute de frappe la ou il n'y en a pas.
 *
 * `parseExRange' EXISTAIT DEJA et resolvait `%', `.', `$', `'<', `'>' et
 * les numeros ; `:g/', `:s' et le filtre `:!' s'en servaient. Personne
 * n'avait branche `:d' ni `:y' dessus, et rien ne validait les bornes.
 *
 * AUTORITE. vim 9.1 (patches 1-16, 647, 678, 697), le binaire de
 * l'Ubuntu 24.04.4 hote de cette session, pilote sur un pty et lance
 * `-u NONE -i NONE' pour ecarter le vimrc de Debian et son viminfo — sans
 * quoi l'autocommande « saut a la derniere position » de `/etc/vim/vimrc'
 * deplace le curseur et `:d' semble supprimer la DERNIERE ligne. Mesure
 * faite deux fois pour cette raison. Sur les defauts de vim :
 *
 *   :d      -> bravo,charlie,delta        (la ligne COURANTE)
 *   :2d     -> alpha,charlie,delta
 *   :1,2d   -> charlie,delta
 *   :%d     -> (vide)
 *   :.,$d   -> (vide)
 *   :$d     -> alpha,bravo,charlie
 *   :0d     -> bravo,charlie,delta        (la ligne 0 vaut la ligne 1)
 *   :1,99d  -> E16: Invalid range: 1,99d           rien supprime
 *   :3,1d   -> E493: Backwards range given: 3,1d   rien supprime
 *   :set nosuchopt       -> E518: Unknown option: nosuchopt
 *   :set zorglub=abc     -> E518: Unknown option: zorglub=abc
 *   :set shiftwidth=xyz  -> E521: Number required after =: shiftwidth=xyz
 *   :set number=3        -> E474: Invalid argument: number=3
 *
 * Les messages citent le texte tape ENTIER, plage ou valeur comprise.
 *
 * LA PRECEDENCE, mesuree : une option INCONNUE rend E518 qu'elle porte ou
 * non une valeur ; une option NUMERIQUE mal remplie rend E521 ; une option
 * BOOLEENNE a qui l'on donne une valeur rend E474.
 *
 * UNE LIMITE ASSUMEE, et elle se lit dans les cas. Un vrai vim connait des
 * centaines d'options ; ce moteur en honore une vingtaine. `:set tabstop=abc'
 * rend donc ici `E518: Unknown option', et non le `E521' du vrai vim — parce
 * que `tabstop' n'existe PAS dans ce moteur, et que le dire est plus honnete
 * que d'accepter en silence une option qu'il n'appliquerait pas. Le cas E521
 * porte donc sur `colorcolumn', que le moteur porte vraiment.
 *
 * MESURE : 12 cas tombent sur 15.
 * Les trois cas qui passent des deux cotes sont nommes :
 *   - TEMOIN : `:s/nomatch/x/' rendait deja `E486: Pattern not found:
 *     nomatch' — la preuve que le lab tape bien des commandes ex et lit
 *     leur message ;
 *   - TEMOIN : `:zorglub', lui, est VRAIMENT inconnu et garde `E492' —
 *     c'est ce qui distingue le refus juste de celui qu'on referme ici ;
 *   - NON-REGRESSION : `:set number' reste silencieux et allume les
 *     numeros de ligne.
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

const CONTENU = 'alpha\nbravo\ncharlie\ndelta\n';

function typeText(e: { applyKey(k: EditorKeyInput): void }, t: string): void {
  for (const ch of t) e.applyKey(editorKey(ch));
}
function press(e: { applyKey(k: EditorKeyInput): void }, k: string): void {
  e.applyKey(editorKey(k));
}
function ex(e: VimEngine, cmd: string): string {
  press(e, ':');
  typeText(e, cmd);
  press(e, 'Enter');
  return e.message;
}
const vim = (): VimEngine => new VimEngine(
  new InMemoryEditorFsContext({ '/tmp/t.txt': CONTENU }), '/tmp/t.txt', CONTENU, false, 'vim');

describe('les commandes ex a plage existent, et le disent', () => {
  it('TEMOIN : `:s/nomatch/x/` rend deja E486', () => {
    expect(ex(vim(), 's/nomatch/x/')).toBe('E486: Pattern not found: nomatch');
  });

  it('TEMOIN : `:zorglub` est vraiment inconnu et garde E492', () => {
    expect(ex(vim(), 'zorglub')).toBe('E492: Not an editor command: zorglub');
  });

  it('`:d` supprime la ligne courante', () => {
    const e = vim();
    ex(e, 'd');
    expect(e.lines.join(',')).toBe('bravo,charlie,delta');
  });

  it('`:2d` supprime la ligne nommee', () => {
    const e = vim();
    ex(e, '2d');
    expect(e.lines.join(',')).toBe('alpha,charlie,delta');
  });

  it('`:1,2d` supprime l intervalle', () => {
    const e = vim();
    ex(e, '1,2d');
    expect(e.lines.join(',')).toBe('charlie,delta');
  });

  it('`:$d` supprime la derniere ligne', () => {
    const e = vim();
    ex(e, '$d');
    expect(e.lines.join(',')).toBe('alpha,bravo,charlie');
  });

  it('`:%d` vide le tampon', () => {
    const e = vim();
    ex(e, '%d');
    expect(e.content).toBe('');
  });

  it('`:.,$d` va de la ligne courante a la derniere', () => {
    const e = vim();
    ex(e, '.,$d');
    expect(e.content).toBe('');
  });

  it('`:0d` traite la ligne 0 comme la ligne 1', () => {
    const e = vim();
    ex(e, '0d');
    expect(e.lines.join(',')).toBe('bravo,charlie,delta');
  });

  it('une plage au-dela du tampon rend E16 et ne supprime rien', () => {
    const e = vim();
    expect(ex(e, '1,99d')).toBe('E16: Invalid range: 1,99d');
    expect(e.lines.join(',')).toBe('alpha,bravo,charlie,delta');
  });

  it('une plage a l envers rend E493 et ne supprime rien', () => {
    const e = vim();
    expect(ex(e, '3,1d')).toBe('E493: Backwards range given: 3,1d');
    expect(e.lines.join(',')).toBe('alpha,bravo,charlie,delta');
  });

  it('une option inconnue rend E518, pas E492', () => {
    expect(ex(vim(), 'set nosuchopt')).toBe('E518: Unknown option: nosuchopt');
  });

  it('une option numerique mal remplie rend E521', () => {
    expect(ex(vim(), 'set colorcolumn=abc'))
      .toBe('E521: Number required after =: colorcolumn=abc');
  });

  it('une option booleenne a qui l on donne une valeur rend E474', () => {
    expect(ex(vim(), 'set number=3')).toBe('E474: Invalid argument: number=3');
  });

  it('NON-REGRESSION : `:set number` reste muet et allume les numeros', () => {
    const e = vim();
    expect(ex(e, 'set number')).toBe('');
    expect(e.lineNumbersShown).toBe(true);
  });
});
