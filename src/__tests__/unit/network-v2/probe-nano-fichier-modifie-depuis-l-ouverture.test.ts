/**
 * nano (src/files.c, write_it_out) : si le fichier garde son nom, existe, et que ses métadonnées ont changé depuis l'ouverture,
 * nano dit « File on disk has changed » puis demande « File was modified since you opened it; continue saving? ». Oui écrit ;
 * non abandonne sans écrire ; l'écriture refait le relevé, si bien qu'un second ^O ne redemande rien.
 * Source lue : le miroir GitHub du dépôt nano (9.3) ; la branche est ancienne dans files.c, mais la version 7.2 elle-même n'est pas
 * atteignable d'ici.
 * Mesure de départ : nano écrasait sans rien dire. 3 des 4 cas tombent avant ; le témoin « fichier inchangé » passe dans les deux états.
 */

import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function open(): { fs: InMemoryEditorFsContext; nano: NanoEngine } {
  const fs = new InMemoryEditorFsContext();
  fs.writeFile('/tmp/f.txt', 'one\n');
  const nano = new NanoEngine(fs, '/tmp/f.txt', 'one\n', false);
  return { fs, nano };
}

const type = (nano: NanoEngine, text: string): void => { for (const ch of text) nano.applyKey(editorKey(ch)); };
const save = (nano: NanoEngine): void => { nano.applyKey(editorKey('o', { ctrl: true })); nano.applyKey(editorKey('Enter')); };

describe('nano : « File was modified since you opened it »', () => {
  it('un fichier changé sur le disque déclenche la question', () => {
    const { fs, nano } = open();
    type(nano, 'x');
    fs.writeFile('/tmp/f.txt', 'changed elsewhere\n');
    save(nano);
    expect(nano.mode).toBe('confirm');
    expect(fs.readFile('/tmp/f.txt')).toBe('changed elsewhere\n');
  });

  it('non : rien n\'est écrit', () => {
    const { fs, nano } = open();
    type(nano, 'x');
    fs.writeFile('/tmp/f.txt', 'changed elsewhere\n');
    save(nano);
    nano.applyKey(editorKey('n'));
    expect(nano.mode).toBe('edit');
    expect(fs.readFile('/tmp/f.txt')).toBe('changed elsewhere\n');
  });

  it('témoin : un fichier inchangé s\'écrit sans question', () => {
    const { fs, nano } = open();
    type(nano, 'x');
    save(nano);
    expect(nano.mode).toBe('edit');
    expect(fs.readFile('/tmp/f.txt')).toBe('xone\n');
  });

  it('témoin : oui écrit, et le relevé est refait', () => {
    const { fs, nano } = open();
    type(nano, 'x');
    fs.writeFile('/tmp/f.txt', 'changed elsewhere\n');
    save(nano);
    nano.applyKey(editorKey('y'));
    expect(fs.readFile('/tmp/f.txt')).toBe('xone\n');
    type(nano, 'y');
    save(nano);
    expect(nano.mode).toBe('edit');
    expect(fs.readFile('/tmp/f.txt')).toBe('xyone\n');
  });
});

describe('rnano', () => {
  it('est nano en mode restreint', async () => {
    const { parseEditorLaunch } = await import('@/network/devices/linux/editors/editorLaunch');
    const launch = parseEditorLaunch('rnano /tmp/f.txt');
    expect(launch?.editor).toBe('nano');
    expect(launch?.filePath).toBe('/tmp/f.txt');
    expect(launch?.nano?.settings.restricted).toBe(true);
  });
});
