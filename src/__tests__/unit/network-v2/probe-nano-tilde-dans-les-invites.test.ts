/**
 * nano 7.2 files.c real_dir_from_tilde : `~` et `~/x` tapés dans une invite de fichier (^O, ^R) sont développés avec le répertoire personnel (get_homedir : celui de passwd pour root, $HOME sinon), `~user` avec la table des comptes ; mesuré sur le binaire 7.2 de cette machine sous tmux (^O sur ~/til.txt écrit /root/til.txt avec HOME=/tmp/x/nh, car l'utilisateur est root).
 * Mesure de départ : `~` était un nom ordinaire (le fichier « ~/til.txt » était cherché dans le répertoire courant). Les 5 cas tombent avant (le témoin aussi, faute de la méthode useUserHome du contexte de test) ; le témoin (nom sans tilde) vérifie que le chemin sans tilde reste intact.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function engine(fs: InMemoryEditorFsContext): NanoEngine {
  return new NanoEngine(fs, '/work/t.txt', '', true);
}

function type(nano: NanoEngine, text: string): void {
  for (const ch of text) nano.applyKey(editorKey(ch));
}

describe('nano et le tilde', () => {
  let fs: InMemoryEditorFsContext;
  beforeEach(() => {
    fs = new InMemoryEditorFsContext({ '/home/alice/notes.txt': 'from home\n', '/home/bob/b.txt': 'bob file\n' });
    fs.useHomeDirectory('/home/alice');
    fs.useUserHome('bob', '/home/bob');
  });

  it('^O sur ~/x écrit dans le répertoire personnel', () => {
    const nano = engine(fs);
    type(nano, 'hi');
    nano.applyKey({ ...editorKey('o'), ctrl: true });
    for (let i = 0; i < 20; i++) nano.applyKey(editorKey('Backspace'));
    type(nano, '~/out.txt');
    nano.applyKey(editorKey('Enter'));
    type(nano, 'y');
    expect(fs.readFile('/home/alice/out.txt')).toBe('hi\n');
  });
  it('^R sur ~/notes.txt lit le fichier du répertoire personnel', () => {
    const nano = engine(fs);
    nano.applyKey({ ...editorKey('r'), ctrl: true });
    type(nano, '~/notes.txt');
    nano.applyKey(editorKey('Enter'));
    expect(nano.content).toContain('from home');
  });
  it('^R sur ~bob/b.txt passe par la table des comptes', () => {
    const nano = engine(fs);
    nano.applyKey({ ...editorKey('r'), ctrl: true });
    type(nano, '~bob/b.txt');
    nano.applyKey(editorKey('Enter'));
    expect(nano.content).toContain('bob file');
  });
  it('^R sur ~inconnu/x reste un nom ordinaire (introuvable)', () => {
    const nano = engine(fs);
    nano.applyKey({ ...editorKey('r'), ctrl: true });
    type(nano, '~nobody/x');
    nano.applyKey(editorKey('Enter'));
    expect(nano.statusMessage).toBe('[ File "~nobody/x" not found ]');
  });
  it('témoin : ^R sur un nom sans tilde', () => {
    const nano = engine(fs);
    nano.applyKey({ ...editorKey('r'), ctrl: true });
    type(nano, '/home/alice/notes.txt');
    nano.applyKey(editorKey('Enter'));
    expect(nano.content).toContain('from home');
  });
});
