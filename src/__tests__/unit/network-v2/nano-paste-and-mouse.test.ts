/**
 * Nano — coller depuis le presse-papiers du navigateur et cliquer dans
 * le texte pour repositionner le curseur.
 *
 * Le composant peint les cellules de `engine.screen` (notation `^X` pour
 * les octets de contrôle, tabulations développées), donc un clic souris
 * — une ligne et une colonne d'ÉCRAN — est reconverti par
 * `engine.clickAt(row, col)` vers la position réelle (ligne, colonne) du
 * buffer, défilement horizontal compris. `applyPaste`
 * simule un collage sans "bracketed paste" : chaque caractère atterrit
 * comme s'il avait été tapé très vite (un `\n` collé crée une nouvelle
 * ligne, comme Enter), en UN SEUL pas d'annulation.
 */
import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { defaultNanoSettings } from '@/network/devices/linux/editors/nano/NanoSettings';
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
function alt(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { alt: true }));
}

describe('Scénario — coller un bloc multi-lignes dans le buffer (édition)', () => {
  it('un texte collé avec des \\n insère de nouvelles lignes, exactement comme Enter', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'start\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'start\n', false);
    nano.applyPaste('nameserver 8.8.8.8\nnameserver 1.1.1.1\n# commentaire\n');
    expect(nano.lines).toEqual([
      'nameserver 8.8.8.8',
      'nameserver 1.1.1.1',
      '# commentaire',
      'start',
    ]);
    expect(nano.modified).toBe(true);
  });

  it('le curseur se retrouve à la fin du texte collé', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'abc\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'abc\n', false);
    nano.applyPaste('X\nYZ');
    expect(nano.cursorLine).toBe(1);
    expect(nano.cursorCol).toBe(2);
    expect(nano.lines).toEqual(['X', 'YZabc']);
  });

  it('un collage au milieu d\'une ligne coupe correctement le texte existant', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'helloworld\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'helloworld\n', false);
    for (let i = 0; i < 5; i++) press(nano, 'ArrowRight');
    nano.applyPaste(' BIG ');
    expect(nano.lines).toEqual(['hello BIG world']);
  });

  it('un collage contenant une tabulation insère \\t littéral (contrairement à la touche Tab, non liée)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': '\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', '\n', false);
    nano.applyPaste('a\tb');
    expect(nano.lines).toEqual(['a\tb']);
  });

  it('gère \\r\\n (presse-papiers Windows) comme un simple saut de ligne', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': '\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', '\n', false);
    nano.applyPaste('a\r\nb');
    expect(nano.lines).toEqual(['a', 'b']);
  });

  it('le collage entier est UN SEUL pas d\'annulation (Alt+U l\'annule intégralement, pas ligne par ligne)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': '\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', '\n', false);
    nano.applyPaste('line1\nline2\nline3');
    expect(nano.lines).toEqual(['line1', 'line2', 'line3']);
    alt(nano, 'u');
    expect(nano.lines).toEqual(['']);
    expect(nano.modified).toBe(false);
  });

  it('coller puis taper un caractère : la frappe démarre un NOUVEAU pas d\'annulation (pas fondue avec le collage)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': '\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', '\n', false);
    nano.applyPaste('AB');
    typeText(nano, 'C');
    expect(nano.lines).toEqual(['ABC']);
    alt(nano, 'u'); // undoes only the "C" keystroke
    expect(nano.lines).toEqual(['AB']);
    alt(nano, 'u'); // undoes the whole paste
    expect(nano.lines).toEqual(['']);
  });

  it('mode vue (-v) : le collage est ignoré, le buffer reste inchangé', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'original\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'original\n', false, true);
    nano.applyPaste('HACKED');
    expect(nano.lines).toEqual(['original']);
    expect(nano.modified).toBe(false);
  });
});

describe('Scénario — coller dans les prompts (recherche, remplacement, nom de fichier)', () => {
  it('coller dans le prompt "Where Is" (^W) remplit le champ de recherche', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'foo bar\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'foo bar\n', false);
    ctrl(nano, 'w');
    nano.applyPaste('bar');
    expect(nano.searchQuery).toBe('bar');
  });

  it('un collage multi-lignes dans un prompt ne garde que la première ligne (champ mono-ligne)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    ctrl(nano, 'o'); // save-prompt
    nano.applyPaste('/tmp/first.txt\nrest ignoré');
    expect(nano.saveFileName).toBe('/tmp/x.txt/tmp/first.txt');
  });
});

describe('Scénario — clic souris repositionne le curseur (cellule de l\'écran → (ligne, colonne) réelle)', () => {
  function sized(content: string, file = '/tmp/x.txt', mouse = true): NanoEngine {
    const nano = new NanoEngine(new InMemoryEditorFsContext({ [file]: content }), file, content, false, false, undefined, false, {
      settings: defaultNanoSettings({ mouse }),
    });
    nano.resize(24, 80);
    return nano;
  }

  it('sans -m nano ne demande pas la souris au terminal : un clic ne bouge rien', () => {
    const nano = sized('hello\nworld\n', '/tmp/x.txt', false);
    nano.clickAt(2, 2);
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(0);
  });

  it('M-M allume la souris en cours de route', () => {
    const nano = sized('hello\nworld\n', '/tmp/x.txt', false);
    alt(nano, 'm');
    expect(nano.statusMessage).toBe('[ Mouse support enabled ]');
    nano.clickAt(2, 2);
    expect(nano.cursorLine).toBe(1);
    expect(nano.cursorCol).toBe(2);
  });

  it('cliquer sur une cellule simple (aucun caractère de contrôle) déplace le curseur exactement', () => {
    const nano = sized('hello\nworld\n');
    nano.clickAt(2, 2);
    expect(nano.cursorLine).toBe(1);
    expect(nano.cursorCol).toBe(2);
  });

  it('un clic sous la dernière ligne tombe sur la dernière ligne', () => {
    const nano = sized('ab\n');
    nano.clickAt(15, 0);
    expect(nano.cursorLine).toBe(1);
    expect(nano.cursorCol).toBe(0);
  });

  it('un clic sur la barre de titre, la barre d\'état ou les raccourcis ne bouge rien', () => {
    const nano = sized('hello\nworld\n');
    nano.clickAt(0, 3);
    nano.clickAt(22, 3);
    nano.clickAt(23, 3);
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(0);
  });

  it('un caractère de contrôle avant le point de clic (^A = 2 colonnes affichées) décale le mapping vers la position réelle', () => {
    const nano = sized('x\x01y\n', '/tmp/ctrl.txt');
    nano.clickAt(1, 3);
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(2);
  });

  it('une tabulation : un clic dans ses cellules tombe sur elle, un clic après tombe sur le caractère suivant', () => {
    const nano = sized('a\tb\n');
    nano.clickAt(1, 5);
    expect(nano.cursorCol).toBe(1);
    nano.clickAt(1, 8);
    expect(nano.cursorCol).toBe(2);
  });

  it('la cellule du curseur revient exactement sur la cellule cliquée', () => {
    const nano = sized('ab\x01cd\n', '/tmp/ctrl2.txt');
    for (const column of [0, 1, 2, 4, 5]) {
      nano.clickAt(1, column);
      expect(nano.screen.cursor).toEqual({ row: 1, col: column });
    }
  });

  it('un clic ne fait rien hors du mode édition (ex: pendant un prompt de recherche)', () => {
    const nano = sized('hello\n');
    ctrl(nano, 'w');
    nano.clickAt(1, 3);
    expect(nano.mode).toBe('search');
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(0);
  });

  it('après un clic, la frappe suivante démarre un nouveau pas d\'annulation (comme les flèches)', () => {
    const nano = sized('ab\n');
    typeText(nano, 'X');
    nano.clickAt(1, 0);
    typeText(nano, 'Y');
    alt(nano, 'u');
    expect(nano.lines).toEqual(['Xab']);
  });

  it('dans une ligne défilée horizontalement, un clic compte depuis la première colonne affichée', () => {
    const long = `${'a'.repeat(100)}\n`;
    const nano = sized(long);
    press(nano, 'End');
    nano.clickAt(1, 10);
    expect(nano.screen.cursor).toEqual({ row: 1, col: 10 });
  });
});
