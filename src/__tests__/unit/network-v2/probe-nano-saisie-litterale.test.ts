/**
 * nano 7.2 M-V (do_verbatim_input) : la touche suivante est insérée telle quelle et la barre d'état dit « [ Verbatim Input ] » en attendant ; mesuré sous tmux sur le binaire 7.2 de cette machine (M-V a → « a », M-V ^A → « ^A », M-V Entrée → « ^M »).
 * Les saisies numériques (3 chiffres octaux, u + chiffres hexadécimaux) ne sont pas portées : le binaire affiche « [ Unicode Input: 101 ] » en attendant la suite et sa règle de fin n'est pas mesurée.
 * Mesure de départ : M-V affichait la position du curseur et n'insérait rien. 4 des 5 cas tombent avant ; le témoin (frappe ordinaire) passe dans les deux états.
 */

import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function fresh(): NanoEngine {
  return new NanoEngine(new InMemoryEditorFsContext(), '/work/t.txt', '', true);
}

const meta = (key: string) => ({ ...editorKey(key), alt: true });

describe('nano M-V', () => {
  it('annonce la saisie littérale', () => {
    const nano = fresh();
    nano.applyKey(meta('v'));
    expect(nano.statusMessage).toBe('[ Verbatim Input ]');
  });
  it('insère un caractère de contrôle', () => {
    const nano = fresh();
    nano.applyKey(meta('v'));
    nano.applyKey({ ...editorKey('a'), ctrl: true });
    expect(nano.bufferLines[0]).toBe('\x01');
  });
  it('insère un retour chariot', () => {
    const nano = fresh();
    nano.applyKey(meta('v'));
    nano.applyKey(editorKey('Enter'));
    expect(nano.bufferLines[0]).toBe('\r');
  });
  it('efface le message après la touche', () => {
    const nano = fresh();
    nano.applyKey(meta('v'));
    nano.applyKey(editorKey('a'));
    expect(nano.statusMessage).toBe('');
    expect(nano.bufferLines[0]).toBe('a');
  });
  it('témoin : frappe ordinaire', () => {
    const nano = fresh();
    nano.applyKey(editorKey('b'));
    expect(nano.bufferLines[0]).toBe('b');
  });
});
