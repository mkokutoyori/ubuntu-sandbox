/**
 * Nano — la barre de raccourcis en bas de l'écran promettait des touches
 * mortes : ^G affichait la position du curseur au lieu de l'aide, ^C
 * puis Y à la sortie écrivait directement sans repasser par "File Name
 * to Write:", la recherche était sensible à la casse par défaut sans
 * bascule M-C possible, et ^T/^R/^J/M-B ne faisaient strictement rien.
 * Ce fichier fixe le contrat réel de chacun.
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

describe('Scénario — ^G ouvre une aide réelle, ^C reste la position du curseur', () => {
  it('^G bascule en mode aide (plus jamais la position du curseur)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    ctrl(nano, 'g');
    expect(nano.mode).toBe('help');
    expect(nano.helpText.length).toBeGreaterThan(0);
  });

  it('^C affiche toujours la position du curseur, sans changer de mode', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'abc\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'abc\n', false);
    ctrl(nano, 'c');
    expect(nano.mode).toBe('edit');
    expect(nano.statusMessage).toContain('line 1');
  });

  it('^X (ou Échap) referme l\'aide et revient exactement où on était', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'ab\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'ab\n', false);
    press(nano, 'ArrowRight');
    ctrl(nano, 'g');
    ctrl(nano, 'x');
    expect(nano.mode).toBe('edit');
    expect(nano.cursorCol).toBe(1);
  });

  it('fonctionne aussi en mode vue (-v)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false, true);
    ctrl(nano, 'g');
    expect(nano.mode).toBe('help');
  });
});

describe('Scénario — un ^W (ou tout autre ctrl/alt non lié) frappé DANS un prompt texte ne corrompt pas le champ', () => {
  it('^W pendant la saisie d\'une recherche est ignoré, pas inséré littéralement', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    ctrl(nano, 'w');
    typeText(nano, 'foo');
    ctrl(nano, 'w'); // must NOT append a literal "w"
    expect(nano.searchQuery).toBe('foo');
  });

  it('un Alt+<lettre> non lié pendant la saisie d\'un nom de fichier n\'insère rien', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    ctrl(nano, 'o');
    for (let i = 0; i < 20; i++) press(nano, 'Backspace');
    typeText(nano, '/tmp/y.txt');
    alt(nano, 'z'); // unbound alt combo -- must not insert "z"
    expect(nano.saveFileName).toBe('/tmp/y.txt');
  });
});

describe('Scénario — ^X puis Y enchaîne réellement sur "File Name to Write:"', () => {
  it('Y ouvre le prompt de nom de fichier (pré-rempli), n\'écrit PAS immédiatement', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    typeText(nano, 'z');
    ctrl(nano, 'x');
    press(nano, 'y');
    expect(nano.mode).toBe('save-prompt');
    expect(nano.saveFileName).toBe('/tmp/x.txt');
    expect(nano.exited).toBe(false);
  });

  it('valider le prompt écrit puis quitte réellement (exited=true, savedOnExit=true)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    typeText(nano, 'z');
    ctrl(nano, 'x');
    press(nano, 'y');
    press(nano, 'Enter');
    expect(nano.exited).toBe(true);
    expect(nano.savedOnExit).toBe(true);
    expect(fs.readFile('/tmp/x.txt')).toBe('za\n');
  });

  it('on peut changer le nom de fichier avant de valider (Enregistrer sous, comme le vrai nano)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    typeText(nano, 'z');
    ctrl(nano, 'x');
    press(nano, 'y');
    for (let i = 0; i < 20; i++) press(nano, 'Backspace');
    typeText(nano, '/tmp/other.txt');
    press(nano, 'Enter');
    expect(nano.exited).toBe(true);
    expect(fs.readFile('/tmp/other.txt')).toBe('za\n');
    expect(fs.readFile('/tmp/x.txt')).toBe('a\n'); // "Save As" writes a new file, the original is untouched
  });
});

describe('Scénario — recherche insensible à la casse par défaut, M-C pour la rendre sensible', () => {
  it('par défaut, "ETH0" trouve "eth0"', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'interface eth0\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'interface eth0\n', false);
    ctrl(nano, 'w');
    expect(nano.caseSensitiveSearch).toBe(false);
    typeText(nano, 'ETH0');
    press(nano, 'Enter');
    expect(nano.cursorCol).toBe(10);
  });

  it('M-C bascule vers sensible à la casse ; "ETH0" ne trouve alors plus "eth0"', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'interface eth0\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'interface eth0\n', false);
    ctrl(nano, 'w');
    alt(nano, 'c');
    expect(nano.caseSensitiveSearch).toBe(true);
    typeText(nano, 'ETH0');
    press(nano, 'Enter');
    expect(nano.statusMessage).toBe('[ "ETH0" not found ]');
  });

  it('M-C fonctionne aussi dans le prompt de remplacement (^\\\\)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'ETH up\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'ETH up\n', false);
    ctrl(nano, '\\');
    expect(nano.caseSensitiveSearch).toBe(false);
    alt(nano, 'c');
    expect(nano.caseSensitiveSearch).toBe(true);
  });
});

describe('Scénario — M-B bascule la direction de recherche (Backwards)', () => {
  it('en arrière, trouve la première occurrence AVANT le curseur (avec retour en fin de fichier)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'foo\nbar\nfoo\nbaz\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'foo\nbar\nfoo\nbaz\n', false);
    press(nano, 'ArrowDown'); press(nano, 'ArrowDown'); press(nano, 'ArrowDown'); // cursor on "baz"
    ctrl(nano, 'w');
    expect(nano.searchDirection).toBe('forward');
    alt(nano, 'b');
    expect(nano.searchDirection).toBe('backward');
    typeText(nano, 'foo');
    press(nano, 'Enter');
    expect(nano.cursorLine).toBe(2); // the "foo" on line 3 (index 2), nearest before cursor
  });

  it('M-B appuyé deux fois revient en avant', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    ctrl(nano, 'w');
    alt(nano, 'b');
    alt(nano, 'b');
    expect(nano.searchDirection).toBe('forward');
  });
});

describe('Scénario — ^T Execute Command insère la sortie d\'une commande au curseur', () => {
  it('ouvre le prompt, exécute via le fsContext, insère la sortie', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'before\n' }, (cmd) => (cmd === 'echo hello' ? 'hello\n' : ''));
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'before\n', false);
    ctrl(nano, 't');
    expect(nano.mode).toBe('execute-prompt');
    typeText(nano, 'echo hello');
    press(nano, 'Enter');
    expect(nano.mode).toBe('edit');
    expect(nano.lines).toEqual(['hellobefore']);
  });

  it('mode vue (-v) : ^T est bloqué comme les autres raccourcis de mutation', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'before\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'before\n', false, true);
    ctrl(nano, 't');
    expect(nano.mode).toBe('edit');
  });
});

describe('Scénario — ^R Read File insère le contenu d\'un fichier au curseur', () => {
  it('ouvre le prompt, insère le fichier ligne par ligne à la position du curseur', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'AFTER\n', '/tmp/snippet.txt': 'L1\nL2\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'AFTER\n', false);
    ctrl(nano, 'r');
    expect(nano.mode).toBe('read-file-prompt');
    typeText(nano, '/tmp/snippet.txt');
    press(nano, 'Enter');
    expect(nano.mode).toBe('edit');
    expect(nano.lines).toEqual(['L1', 'L2AFTER']);
  });

  it('fichier introuvable : message d\'erreur, buffer inchangé', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'AFTER\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'AFTER\n', false);
    ctrl(nano, 'r');
    typeText(nano, '/tmp/missing.txt');
    press(nano, 'Enter');
    expect(nano.statusMessage).toContain('No such file or directory');
    expect(nano.lines).toEqual(['AFTER']);
  });

  it('mode vue (-v) : ^R est bloqué', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false, true);
    ctrl(nano, 'r');
    expect(nano.mode).toBe('edit');
  });
});

describe('Scénario — ^J Justify reformate le paragraphe courant', () => {
  it('un paragraphe de mots courts tient sur une seule ligne rejustifiée', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\nb\nc\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\nb\nc\n', false);
    ctrl(nano, 'j');
    expect(nano.lines).toEqual(['a b c']);
  });

  it('un paragraphe long est reformaté à la largeur maximale (80 colonnes)', () => {
    const words = Array.from({ length: 30 }, (_, i) => `mot${i}`);
    const content = words.join('\n') + '\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
    const nano = new NanoEngine(fs, '/tmp/x.txt', content, false);
    ctrl(nano, 'j');
    for (const line of nano.lines) expect(line.length).toBeLessThanOrEqual(80);
    // Every original word survives the reflow, in order.
    expect(nano.lines.join(' ')).toBe(words.join(' '));
  });

  it('ne touche pas aux paragraphes voisins séparés par une ligne vide', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'p1a\np1b\n\np2a\np2b\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'p1a\np1b\n\np2a\np2b\n', false);
    ctrl(nano, 'j');
    expect(nano.lines).toEqual(['p1a p1b', '', 'p2a', 'p2b']);
  });

  it('sur une ligne vide, ne fait rien', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n\nb\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n\nb\n', false);
    press(nano, 'ArrowDown'); // land on the blank line
    ctrl(nano, 'j');
    expect(nano.lines).toEqual(['a', '', 'b']);
    expect(nano.modified).toBe(false);
  });

  it('mode vue (-v) : ^J est bloqué', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\nb\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\nb\n', false, true);
    ctrl(nano, 'j');
    expect(nano.lines).toEqual(['a', 'b']);
  });

  it('un seul pas d\'annulation pour tout le reformatage', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\nb\nc\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\nb\nc\n', false);
    ctrl(nano, 'j');
    expect(nano.lines).toEqual(['a b c']);
    alt(nano, 'u');
    expect(nano.lines).toEqual(['a', 'b', 'c']);
  });
});
