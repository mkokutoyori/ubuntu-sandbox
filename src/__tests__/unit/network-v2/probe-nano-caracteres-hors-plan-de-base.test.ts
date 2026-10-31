/**
 * nano 7.2 et un caractère hors du plan de base (emoji) : une flèche, Retour arrière et Suppr passent par-dessus un point de code entier ; mesuré sous tmux en UTF-8 sur 'a😀b' (1 flèche → col 2/5, 2 flèches → col 4/5 ; Fin, ←, Retour arrière efface l'emoji et rend « ab »).
 * Mesure de départ : le curseur s'arrêtait au milieu de la paire de substitution (col 3 au lieu de 4 après deux flèches) et Retour arrière en laissait une moitié. 4 des 5 cas tombent avant ; le témoin (texte du plan de base) passe dans les deux états.
 */

import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function open(content: string): NanoEngine {
  return new NanoEngine(new InMemoryEditorFsContext({ '/tmp/e.txt': content }), '/tmp/e.txt', content, false);
}

describe('nano et les paires de substitution', () => {
  it('deux flèches droites franchissent l\'emoji', () => {
    const nano = open('a😀b\n');
    nano.applyKey(editorKey('ArrowRight'));
    nano.applyKey(editorKey('ArrowRight'));
    expect(nano.cursorCol).toBe(3);
  });
  it('flèche gauche depuis la fin revient avant l\'emoji', () => {
    const nano = open('a😀b\n');
    nano.applyKey(editorKey('End'));
    nano.applyKey(editorKey('ArrowLeft'));
    nano.applyKey(editorKey('ArrowLeft'));
    expect(nano.cursorCol).toBe(1);
  });
  it('Retour arrière efface l\'emoji entier', () => {
    const nano = open('a😀b\n');
    nano.applyKey(editorKey('End'));
    nano.applyKey(editorKey('ArrowLeft'));
    nano.applyKey(editorKey('Backspace'));
    expect(nano.bufferLines[0]).toBe('ab');
  });
  it('Suppr efface l\'emoji entier', () => {
    const nano = open('a😀b\n');
    nano.applyKey(editorKey('ArrowRight'));
    nano.applyKey(editorKey('Delete'));
    expect(nano.bufferLines[0]).toBe('ab');
  });
  it('témoin : texte du plan de base', () => {
    const nano = open('abc\n');
    nano.applyKey(editorKey('ArrowRight'));
    nano.applyKey(editorKey('Delete'));
    expect(nano.bufferLines[0]).toBe('ac');
  });
});
