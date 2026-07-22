/**
 * Nano — navigation manquante : PageUp/PageDown (^Y/^V et les touches
 * physiques), Go To Line (^_ / M-G), et insertion de tabulation (Tab).
 * Ces trois étaient entièrement absents du moteur : impossible de se
 * déplacer autrement que flèche par flèche dans un long fichier, "^_ Go
 * To Line" était un raccourci mort dans la barre, et la touche Tab
 * n'insérait rien.
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
function alt(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { alt: true }));
}

function longBuffer(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
}

describe('Scénario — PageDown (^V et la touche PageDown) avance d\'une page', () => {
  it('^V avance le curseur de PAGE_SIZE lignes', () => {
    const content = longBuffer(100);
    const fs = new InMemoryEditorFsContext({ '/tmp/big.txt': content });
    const nano = new NanoEngine(fs, '/tmp/big.txt', content, false);
    expect(nano.cursorLine).toBe(0);
    ctrl(nano, 'v');
    expect(nano.cursorLine).toBeGreaterThan(0);
    expect(nano.cursorLine).toBeLessThan(99);
  });

  it('la touche physique PageDown fait exactement la même chose que ^V', () => {
    const content = longBuffer(100);
    const fs1 = new InMemoryEditorFsContext({ '/tmp/big.txt': content });
    const nano1 = new NanoEngine(fs1, '/tmp/big.txt', content, false);
    ctrl(nano1, 'v');

    const fs2 = new InMemoryEditorFsContext({ '/tmp/big.txt': content });
    const nano2 = new NanoEngine(fs2, '/tmp/big.txt', content, false);
    press(nano2, 'PageDown');

    expect(nano2.cursorLine).toBe(nano1.cursorLine);
  });

  it('PageDown près de la fin clampe à la dernière ligne, sans erreur', () => {
    const content = longBuffer(10);
    const fs = new InMemoryEditorFsContext({ '/tmp/small.txt': content });
    const nano = new NanoEngine(fs, '/tmp/small.txt', content, false);
    ctrl(nano, 'v');
    expect(nano.cursorLine).toBe(9);
    ctrl(nano, 'v'); // no-op, already at the end
    expect(nano.cursorLine).toBe(9);
  });

  it('fonctionne aussi en mode vue (-v) : la navigation n\'est jamais bloquée en lecture seule', () => {
    const content = longBuffer(100);
    const fs = new InMemoryEditorFsContext({ '/tmp/big.txt': content });
    const nano = new NanoEngine(fs, '/tmp/big.txt', content, false, true);
    ctrl(nano, 'v');
    expect(nano.cursorLine).toBeGreaterThan(0);
  });
});

describe('Scénario — PageUp (^Y et la touche PageUp) recule d\'une page', () => {
  it('^Y ramène le curseur en arrière de PAGE_SIZE lignes', () => {
    const content = longBuffer(100);
    const fs = new InMemoryEditorFsContext({ '/tmp/big.txt': content });
    const nano = new NanoEngine(fs, '/tmp/big.txt', content, false);
    ctrl(nano, 'v');
    ctrl(nano, 'v');
    const afterTwoDowns = nano.cursorLine;
    ctrl(nano, 'y');
    expect(nano.cursorLine).toBeLessThan(afterTwoDowns);
  });

  it('la touche physique PageUp fait exactement la même chose que ^Y', () => {
    const content = longBuffer(100);
    const fs1 = new InMemoryEditorFsContext({ '/tmp/big.txt': content });
    const nano1 = new NanoEngine(fs1, '/tmp/big.txt', content, false);
    ctrl(nano1, 'v'); ctrl(nano1, 'v'); ctrl(nano1, 'y');

    const fs2 = new InMemoryEditorFsContext({ '/tmp/big.txt': content });
    const nano2 = new NanoEngine(fs2, '/tmp/big.txt', content, false);
    press(nano2, 'PageDown'); press(nano2, 'PageDown'); press(nano2, 'PageUp');

    expect(nano2.cursorLine).toBe(nano1.cursorLine);
  });

  it('PageUp près du début clampe à la première ligne', () => {
    const content = longBuffer(100);
    const fs = new InMemoryEditorFsContext({ '/tmp/big.txt': content });
    const nano = new NanoEngine(fs, '/tmp/big.txt', content, false);
    ctrl(nano, 'y');
    expect(nano.cursorLine).toBe(0);
  });

  it('un mouvement de page interrompt la coalescence undo, comme les flèches', () => {
    const content = longBuffer(100);
    const fs = new InMemoryEditorFsContext({ '/tmp/big.txt': content });
    const nano = new NanoEngine(fs, '/tmp/big.txt', content, false);
    typeText(nano, 'X');
    ctrl(nano, 'v');
    typeText(nano, 'Y');
    alt(nano, 'u'); // undoes only "Y"
    expect(nano.lines[nano.cursorLine].includes('Y')).toBe(false);
  });
});

describe('Scénario — Go To Line (^_ et M-G)', () => {
  it('^_ ouvre le prompt "Enter line number, column number:"', () => {
    const content = longBuffer(20);
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
    const nano = new NanoEngine(fs, '/tmp/x.txt', content, false);
    ctrl(nano, '_');
    expect(nano.mode).toBe('goto-line');
  });

  it('M-G ouvre le même prompt (alias documenté de real nano)', () => {
    const content = longBuffer(20);
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
    const nano = new NanoEngine(fs, '/tmp/x.txt', content, false);
    alt(nano, 'g');
    expect(nano.mode).toBe('goto-line');
  });

  it('taper "42" puis Enter place le curseur au début de la ligne 42 (1-indexé)', () => {
    const content = longBuffer(100);
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
    const nano = new NanoEngine(fs, '/tmp/x.txt', content, false);
    ctrl(nano, '_');
    typeText(nano, '42');
    press(nano, 'Enter');
    expect(nano.mode).toBe('edit');
    expect(nano.cursorLine).toBe(41);
    expect(nano.cursorCol).toBe(0);
  });

  it('la forme "ligne,colonne" positionne aussi la colonne (1-indexée)', () => {
    const content = longBuffer(100);
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
    const nano = new NanoEngine(fs, '/tmp/x.txt', content, false);
    ctrl(nano, '_');
    typeText(nano, '10,3');
    press(nano, 'Enter');
    expect(nano.cursorLine).toBe(9);
    expect(nano.cursorCol).toBe(2);
  });

  it('une ligne au-delà de la fin du fichier clampe à la dernière ligne', () => {
    const content = longBuffer(10);
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
    const nano = new NanoEngine(fs, '/tmp/x.txt', content, false);
    ctrl(nano, '_');
    typeText(nano, '9999');
    press(nano, 'Enter');
    expect(nano.cursorLine).toBe(9);
  });

  it('une entrée non numérique annule sans déplacer le curseur', () => {
    const content = longBuffer(20);
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
    const nano = new NanoEngine(fs, '/tmp/x.txt', content, false);
    press(nano, 'ArrowDown'); // move to line 2 first, to detect a no-op
    ctrl(nano, '_');
    typeText(nano, 'abc');
    press(nano, 'Enter');
    expect(nano.mode).toBe('edit');
    expect(nano.cursorLine).toBe(1);
  });

  it('^C annule le prompt sans déplacer le curseur', () => {
    const content = longBuffer(20);
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
    const nano = new NanoEngine(fs, '/tmp/x.txt', content, false);
    ctrl(nano, '_');
    typeText(nano, '15');
    ctrl(nano, 'c');
    expect(nano.mode).toBe('edit');
    expect(nano.cursorLine).toBe(0);
  });

  it('fonctionne aussi en mode vue (-v)', () => {
    const content = longBuffer(20);
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
    const nano = new NanoEngine(fs, '/tmp/x.txt', content, false, true);
    ctrl(nano, '_');
    typeText(nano, '5');
    press(nano, 'Enter');
    expect(nano.cursorLine).toBe(4);
  });
});

describe('Scénario — la touche Tab insère une tabulation littérale', () => {
  it('Tab insère \\t au point du curseur', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'ab\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'ab\n', false);
    press(nano, 'ArrowRight');
    press(nano, 'Tab');
    expect(nano.lines).toEqual(['a\tb']);
    expect(nano.cursorCol).toBe(2);
    expect(nano.modified).toBe(true);
  });

  it('Tab dans un crontab-like buffer reste un vrai caractère de tabulation (getBuffer round-trip)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/cron.txt': '\n' });
    const nano = new NanoEngine(fs, '/tmp/cron.txt', '\n', false);
    typeText(nano, '*');
    press(nano, 'Tab');
    typeText(nano, '*');
    expect(nano.lines[0]).toBe('*\t*');
  });

  it('mode vue (-v) : Tab est ignoré comme toute autre frappe qui modifierait le buffer', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'ab\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'ab\n', false, true);
    press(nano, 'Tab');
    expect(nano.lines).toEqual(['ab']);
    expect(nano.modified).toBe(false);
  });

  it('plusieurs Tab consécutifs coalescent en un seul pas d\'annulation, comme la frappe normale', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': '\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', '\n', false);
    press(nano, 'Tab');
    press(nano, 'Tab');
    expect(nano.lines).toEqual(['\t\t']);
    alt(nano, 'u');
    expect(nano.lines).toEqual(['']);
  });
});
