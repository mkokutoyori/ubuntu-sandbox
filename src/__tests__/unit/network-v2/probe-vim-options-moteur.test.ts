/**
 * Les options de vim lues par le MOTEUR (la table elle-meme est rejouee contre un vrai vim dans
 * vim-options-oracle.test.ts) : ce que `:set` change vraiment dans ce que le moteur ecrit, cherche
 * et affiche.  Valeurs relevees sur un vim 9.1 reel :
 *   - `:set nowrapscan` puis /foo sans suite : E385 vers l'avant, E384 vers l'arriere, et E385
 *     aussi pour un motif absent du fichier (E486 n'existe qu'avec 'wrapscan') ;
 *   - `:set ff=mac` ecrit des CR seuls ; `:set ff=dos` des CRLF ;
 *   - `:set list` avec 'listchars' sans `eol:` n'affiche pas de `$` ;
 *   - `:setl` et `:setg` sont des abreviations de `:setlocal` et `:setglobal`.
 *
 * Mesure avec `git stash push -u -- src/network` : 8 cas sur 10 tombent avant (le moteur ne
 * connaissait ni tabstop, ni wrapscan, ni ff=mac, ni setlocal, et affichait `$` quoi qu'on regle).
 * Les deux autres passent des deux cotes : TEMOIN, `:set number` allumait deja les numeros, preuve
 * que le lab tape des commandes ex et lit l'etat du moteur ; NON-REGRESSION, `:set zorglub` rendait
 * deja E518 dans les mots de vim.
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function vim(content = 'foo\nbar\nfoo bar\nbaz\n') {
  const fs = new InMemoryEditorFsContext({ '/tmp/o.txt': content });
  return { engine: new VimEngine(fs, '/tmp/o.txt', content, false, 'vim'), fs };
}

function type(engine: VimEngine, keys: string): void {
  for (const k of keys) engine.applyKey(editorKey(k));
}

function ex(engine: VimEngine, command: string): string {
  type(engine, `:${command}`);
  engine.applyKey(editorKey('Enter'));
  return engine.message;
}

describe('les options reglent le moteur', () => {
  it('TEMOIN : `:set number` allume les numeros', () => {
    const { engine } = vim();
    ex(engine, 'set number');
    expect(engine.lineNumbersShown).toBe(true);
  });

  it(':set ts? rapporte la valeur courante', () => {
    const { engine } = vim();
    expect(ex(engine, 'set ts?')).toBe('  tabstop=8');
    ex(engine, 'set ts=4');
    expect(ex(engine, 'set ts?')).toBe('  tabstop=4');
  });

  it('tabstop regle la colonne virtuelle de la regle et du curseur', () => {
    const { engine } = vim('\tx\n');
    ex(engine, 'set ts=4');
    type(engine, 'l');
    expect(engine.cursorCol).toBe(1);
    expect(engine.options.tabstop).toBe(4);
  });

  it('expandtab fait taper des espaces a Tab', () => {
    const { engine } = vim('x\n');
    ex(engine, 'set et ts=4');
    type(engine, 'i');
    engine.applyKey(editorKey('Tab'));
    expect(engine.lines[0]).toBe('    x');
  });

  it('shiftwidth regle >>', () => {
    const { engine } = vim('x\n');
    ex(engine, 'set sw=3 et');
    type(engine, '>>');
    expect(engine.lines[0]).toBe('   x');
  });

  it('nowrapscan : E385 vers l avant, E384 vers l arriere, E385 meme pour un motif absent', () => {
    const { engine } = vim();
    ex(engine, 'set nows');
    type(engine, 'G/foo');
    engine.applyKey(editorKey('Enter'));
    expect(engine.message).toBe('E385: Search hit BOTTOM without match for: foo');
    type(engine, 'gg?foo');
    engine.applyKey(editorKey('Enter'));
    expect(engine.message).toBe('E384: Search hit TOP without match for: foo');
    type(engine, 'gg/nomatch');
    engine.applyKey(editorKey('Enter'));
    expect(engine.message).toBe('E385: Search hit BOTTOM without match for: nomatch');
  });

  it('ff=mac ecrit des CR seuls et ff=dos des CRLF', () => {
    const { engine, fs } = vim('a\nb\n');
    ex(engine, 'set ff=mac');
    ex(engine, 'w');
    expect(fs.readFile('/tmp/o.txt')).toBe('a\rb\r');
    ex(engine, 'set ff=dos');
    ex(engine, 'w');
    expect(fs.readFile('/tmp/o.txt')).toBe('a\r\nb\r\n');
  });

  it('list sans eol: dans listchars n affiche pas de $', () => {
    const { engine } = vim('ab\n');
    ex(engine, 'set list');
    ex(engine, 'set lcs=tab:>-');
    expect(engine.renderListLine('ab')).toBe('ab');
    ex(engine, 'set lcs=eol:$');
    expect(engine.renderListLine('ab')).toBe('ab$');
  });

  it(':setl et :setg abreviatures de setlocal et setglobal', () => {
    const { engine } = vim();
    ex(engine, 'setl ts=3');
    expect(ex(engine, 'set ts?')).toBe('  tabstop=3');
    ex(engine, 'setg ts=5');
    expect(ex(engine, 'set ts?')).toBe('  tabstop=3');
    expect(ex(engine, 'setg ts?')).toBe('  tabstop=5');
  });

  it(':set refuse une option inconnue dans les mots de vim', () => {
    const { engine } = vim();
    expect(ex(engine, 'set zorglub')).toBe('E518: Unknown option: zorglub');
  });
});
