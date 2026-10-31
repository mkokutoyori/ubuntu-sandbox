/**
 * nano 7.2 M-V (do_verbatim_input) : la touche suivante est insérée telle quelle et la barre d'état dit « [ Verbatim Input ] » en attendant ; mesuré sous tmux sur le binaire 7.2 de cette machine (M-V a → « a », M-V ^A → « ^A », M-V Entrée → « ^M »).
 * En locale UTF-8 (LC_ALL=C.UTF-8, mesuré) une touche hexadécimale ouvre « [ Unicode Input: NN ] » (6 chiffres, alignés à droite) ; Entrée ou Espace termine et est consommé, six chiffres terminent d'eux-mêmes, une valeur > 10FFFF ou une autre touche donne « [ Invalid code ] » sans rien insérer.
 * Mesure de départ : M-V affichait la position du curseur et n'insérait rien. 8 des 9 cas tombent avant le premier portage de M-V (la version à une touche seule en passait 5) ; le témoin (frappe ordinaire) passe dans les deux états.
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
  it('code hexadécimal terminé par Entrée', () => {
    const nano = fresh();
    nano.applyKey(meta('v'));
    for (const digit of '41') nano.applyKey(editorKey(digit));
    expect(nano.statusMessage).toBe('[ Unicode Input:     41 ]');
    nano.applyKey(editorKey('Enter'));
    expect(nano.bufferLines[0]).toBe('A');
    expect(nano.statusMessage).toBe('');
  });
  it('six chiffres terminent seuls', () => {
    const nano = fresh();
    nano.applyKey(meta('v'));
    for (const digit of '0020ac') nano.applyKey(editorKey(digit));
    expect(nano.bufferLines[0]).toBe('€');
  });
  it('valeur trop grande', () => {
    const nano = fresh();
    nano.applyKey(meta('v'));
    for (const digit of '123456') nano.applyKey(editorKey(digit));
    expect(nano.statusMessage).toBe('[ Invalid code ]');
    expect(nano.bufferLines[0]).toBe('');
  });
  it('touche non hexadécimale en cours de saisie', () => {
    const nano = fresh();
    nano.applyKey(meta('v'));
    nano.applyKey(editorKey('4'));
    nano.applyKey(editorKey('1'));
    nano.applyKey(editorKey('x'));
    expect(nano.statusMessage).toBe('[ Invalid code ]');
    expect(nano.bufferLines[0]).toBe('');
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
    nano.applyKey(editorKey('z'));
    expect(nano.statusMessage).toBe('');
    expect(nano.bufferLines[0]).toBe('z');
  });
  it('témoin : frappe ordinaire', () => {
    const nano = fresh();
    nano.applyKey(editorKey('b'));
    expect(nano.bufferLines[0]).toBe('b');
  });
});
