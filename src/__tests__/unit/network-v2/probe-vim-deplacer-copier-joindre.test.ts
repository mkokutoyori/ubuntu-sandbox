/**
 * `:m', `:t', `:co', `:j', `:>' et `:<' repondaient toutes « cette
 * commande n'existe pas ».
 *
 * MESURE DE DEPART sur `bdf7e1b9', sur un tampon de quatre lignes
 * (alpha, bravo, charlie, delta) :
 *
 *   :2,3m0   -> E492: Not an editor command: 2,3m0     tampon intact
 *   :1t$     -> E492: Not an editor command: 1t$       tampon intact
 *   :1co2    -> E492: Not an editor command: 1co2      tampon intact
 *   :1,2j    -> E492: Not an editor command: 1,2j      tampon intact
 *   :j       -> E492: Not an editor command: j         tampon intact
 *   :1,2>    -> E492: Not an editor command: 1,2>      tampon intact
 *   :2,3<    -> E492: Not an editor command: 2,3<      tampon intact
 *
 * Le lot precedent (`4ed57f22') a branche `:d' et `:y' sur `parseExRange'
 * et pose la validation des bornes. Ces six-la sont la meme famille :
 * elles prennent la MEME plage, et aucune ne la consommait. Repondre
 * « commande inconnue » a `:m' ou `:j' est le refus que la regle 6 nomme
 * le plus trompeur — il envoie chercher une faute de frappe la ou il n'y
 * en a pas.
 *
 * AUTORITE. vim 9.1, le binaire de l'Ubuntu 24.04.4 hote de cette session,
 * pilote sur un pty avec `-u NONE -i NONE' — sur les defauts de vim, donc,
 * et non sur ceux de la distribution :
 *
 *   :2,3m0  -> bravo,charlie,alpha,delta
 *   :1t$    -> alpha,bravo,charlie,delta,alpha
 *   :1co2   -> alpha,bravo,alpha,charlie,delta
 *   :1,2j   -> alpha bravo,charlie,delta
 *   :j      -> alpha bravo,charlie,delta       (la courante et la suivante)
 *   :1,2>   -> \talpha,\tbravo,charlie,delta
 *   :2,3<   -> alpha,bravo,charlie,delta       (rien a retirer)
 *
 * QUATRE FAITS QUE LA MESURE FIXE, et qu'on devinerait mal :
 *
 * 1. L'ADRESSE DE `:m' ET `:t' EST UN « APRES ». `:2,3m0' place apres la
 *    ligne 0, c'est-a-dire AVANT la premiere — d'ou `bravo,charlie' en
 *    tete. La ligne 0 n'est pas une ligne, c'est le bord.
 * 2. `:j' SANS PLAGE joint la courante et la SUIVANTE, pas seulement la
 *    courante avec elle-meme.
 * 3. LA JOINTURE INSERE UNE ESPACE : `alpha bravo', pas `alphabravo'.
 * 4. `:<' SUR UNE LIGNE SANS BLANC DE TETE NE FAIT RIEN, et ne s'en
 *    plaint pas.
 *
 * MESURE : 7 cas tombent sur 11.
 *
 * Le cas de `:<' sur une ligne sans blanc de tete demandait une precaution :
 * ecrit « le tampon ne change pas », il passait DES DEUX COTES, une commande
 * inconnue ne changeant rien non plus. Il verifie donc d'abord que la
 * commande est ACCEPTEE — message vide — avant de constater qu'elle n'a rien
 * a retirer. Sans cela il ne prouvait rien.
 * Les trois cas qui passent des deux cotes sont nommes :
 *   - TEMOIN : `:2d', pose par le lot precedent, supprime toujours la
 *     ligne nommee — la preuve que la plage est lue et le tampon touche ;
 *   - TEMOIN : `:zorglub' reste VRAIMENT inconnu et garde `E492' ;
 *   - NON-REGRESSION : `:1,99d' rend toujours `E16' et ne touche a rien.
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

const apres = (cmd: string): string => {
  const e = vim();
  ex(e, cmd);
  return e.lines.join(',');
};

describe('deplacer, copier, joindre et decaler par plage', () => {
  it('TEMOIN : `:2d` supprime toujours la ligne nommee', () => {
    expect(apres('2d')).toBe('alpha,charlie,delta');
  });

  it('TEMOIN : `:zorglub` reste vraiment inconnu', () => {
    expect(ex(vim(), 'zorglub')).toBe('E492: Not an editor command: zorglub');
  });

  it('`:2,3m0` deplace la plage avant la premiere ligne', () => {
    expect(apres('2,3m0')).toBe('bravo,charlie,alpha,delta');
  });

  it('`:1t$` copie la ligne apres la derniere', () => {
    expect(apres('1t$')).toBe('alpha,bravo,charlie,delta,alpha');
  });

  it('`:1co2` copie la ligne apres la ligne nommee', () => {
    expect(apres('1co2')).toBe('alpha,bravo,alpha,charlie,delta');
  });

  it('`:1,2j` joint la plage avec une espace', () => {
    expect(apres('1,2j')).toBe('alpha bravo,charlie,delta');
  });

  it('`:j` sans plage joint la courante et la SUIVANTE', () => {
    expect(apres('j')).toBe('alpha bravo,charlie,delta');
  });

  it('`:1,2>` decale la plage d une tabulation', () => {
    expect(apres('1,2>')).toBe('\talpha,\tbravo,charlie,delta');
  });

  it('`:2,3<` sur des lignes sans blanc de tete est ACCEPTEE et ne fait rien', () => {
    const e = vim();
    expect(ex(e, '2,3<')).toBe('');
    expect(e.lines.join(',')).toBe('alpha,bravo,charlie,delta');
  });

  it('`:<` retire bien le decalage que `:>` a pose', () => {
    const e = vim();
    ex(e, '1,2>');
    ex(e, '1,2<');
    expect(e.lines.join(',')).toBe('alpha,bravo,charlie,delta');
  });

  it('NON-REGRESSION : `:1,99d` rend toujours E16 sans rien toucher', () => {
    const e = vim();
    expect(ex(e, '1,99d')).toBe('E16: Invalid range: 1,99d');
    expect(e.lines.join(',')).toBe('alpha,bravo,charlie,delta');
  });
});
