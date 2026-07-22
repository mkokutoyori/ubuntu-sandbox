/**
 * Nano — les champs de prompt (recherche, remplacement, nom de fichier,
 * goto-line, execute, read-file) ne supportaient que "taper en fin de
 * champ" + "Backspace en fin de champ" : impossible de se repositionner
 * au milieu du texte déjà tapé pour le corriger sans tout effacer.
 *
 * Un seul mécanisme partagé (promptCursor + applyPromptFieldKey) pilote
 * les sept champs ; ce fichier vérifie le comportement sur le prompt de
 * recherche (le plus utilisé) puis croise avec 2-3 autres prompts pour
 * confirmer que le partage fonctionne uniformément.
 */
import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function ctrl(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { ctrl: true }));
}

function newEngine(content = 'a\n'): NanoEngine {
  const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
  return new NanoEngine(fs, '/tmp/x.txt', content, false);
}

describe('Scénario — prompt de recherche : curseur repositionnable au milieu du champ', () => {
  it('taper place le curseur en fin de champ, comme avant (comportement de base préservé)', () => {
    const nano = newEngine();
    ctrl(nano, 'w');
    typeText(nano, 'eth0');
    expect(nano.searchQuery).toBe('eth0');
    expect(nano.promptCursor).toBe(4);
  });

  it('ArrowLeft déplace le curseur ; la frappe suivante s\'insère à cette position, pas en fin de champ', () => {
    const nano = newEngine();
    ctrl(nano, 'w');
    typeText(nano, 'eth1');
    press(nano, 'ArrowLeft');
    typeText(nano, 'X');
    expect(nano.searchQuery).toBe('ethX1');
  });

  it('ArrowRight ramène vers la fin', () => {
    const nano = newEngine();
    ctrl(nano, 'w');
    typeText(nano, 'abcd');
    press(nano, 'ArrowLeft'); press(nano, 'ArrowLeft'); press(nano, 'ArrowLeft');
    press(nano, 'ArrowRight');
    typeText(nano, 'X');
    expect(nano.searchQuery).toBe('abXcd');
  });

  it('Home puis Backspace ne fait rien (déjà en début de champ)', () => {
    const nano = newEngine();
    ctrl(nano, 'w');
    typeText(nano, 'abc');
    press(nano, 'Home');
    press(nano, 'Backspace');
    expect(nano.searchQuery).toBe('abc');
  });

  it('End ramène en fin, Backspace efface alors le dernier caractère (comportement historique)', () => {
    const nano = newEngine();
    ctrl(nano, 'w');
    typeText(nano, 'abc');
    press(nano, 'Home');
    press(nano, 'End');
    press(nano, 'Backspace');
    expect(nano.searchQuery).toBe('ab');
  });

  it('Delete supprime le caractère APRÈS le curseur, sans déplacer le curseur', () => {
    const nano = newEngine();
    ctrl(nano, 'w');
    typeText(nano, 'abcd');
    press(nano, 'Home'); press(nano, 'ArrowRight'); // cursor between 'a' and 'b'
    press(nano, 'Delete');
    expect(nano.searchQuery).toBe('acd');
  });

  it('Backspace au milieu du champ efface le caractère AVANT le curseur, sans tout effacer', () => {
    const nano = newEngine();
    ctrl(nano, 'w');
    typeText(nano, 'abcd');
    press(nano, 'ArrowLeft'); press(nano, 'ArrowLeft'); // cursor between 'b' and 'c'
    press(nano, 'Backspace');
    expect(nano.searchQuery).toBe('acd');
  });

  it('ArrowLeft/Right ne dépassent jamais les bornes du champ', () => {
    const nano = newEngine();
    ctrl(nano, 'w');
    typeText(nano, 'ab');
    for (let i = 0; i < 10; i++) press(nano, 'ArrowLeft');
    expect(nano.promptCursor).toBe(0);
    for (let i = 0; i < 10; i++) press(nano, 'ArrowRight');
    expect(nano.promptCursor).toBe(2);
  });

  it('rouvrir ^W avec un terme préexistant place le curseur en FIN du texte pré-rempli, comme le vrai nano', () => {
    const nano = newEngine('eth0 up\neth0 up\n');
    ctrl(nano, 'w');
    typeText(nano, 'eth0');
    press(nano, 'Enter'); // search performed, lastSearchTerm = "eth0"
    ctrl(nano, 'w'); // reopen: prefilled with "eth0"
    expect(nano.searchQuery).toBe('eth0');
    expect(nano.promptCursor).toBe(4); // at the end, not stuck at a stale mid-field position
  });

  it('coller du texte l\'insère à la position du curseur, pas seulement en fin de champ', () => {
    const nano = newEngine();
    ctrl(nano, 'w');
    typeText(nano, 'ad');
    press(nano, 'ArrowLeft');
    nano.applyPaste('bc');
    expect(nano.searchQuery).toBe('abcd');
    expect(nano.promptCursor).toBe(3);
  });
});

describe('Scénario — le curseur de prompt est partagé et se réinitialise à chaque nouveau prompt', () => {
  it('changer de prompt (recherche puis remplacement) repart avec le curseur en fin du nouveau champ', () => {
    const nano = newEngine();
    ctrl(nano, 'w');
    typeText(nano, 'foo');
    press(nano, 'ArrowLeft'); // cursor now mid-field in the search prompt
    press(nano, 'Escape');
    ctrl(nano, '\\'); // replace-search prompt opens fresh
    typeText(nano, 'bar');
    expect(nano.replaceSearchQuery).toBe('bar'); // not affected by the stale cursor position
    expect(nano.promptCursor).toBe(3);
  });
});

describe('Scénario — le même mécanisme fonctionne sur les autres prompts (nom de fichier, goto-line)', () => {
  it('prompt "File Name to Write" : ArrowLeft + insertion corrige au milieu du nom', () => {
    const nano = newEngine();
    ctrl(nano, 'o');
    for (let i = 0; i < 20; i++) press(nano, 'Backspace');
    typeText(nano, '/tmp/fil.txt');
    press(nano, 'ArrowLeft'); press(nano, 'ArrowLeft'); press(nano, 'ArrowLeft'); press(nano, 'ArrowLeft');
    typeText(nano, 'e');
    expect(nano.saveFileName).toBe('/tmp/file.txt');
  });

  it('prompt Go To Line : Home puis Delete efface le premier chiffre tapé', () => {
    const nano = newEngine('a\nb\nc\nd\ne\n');
    ctrl(nano, '_');
    typeText(nano, '45');
    press(nano, 'Home');
    press(nano, 'Delete');
    expect(nano.gotoLineQuery).toBe('5');
  });
});
