/**
 * Scénario 13 (auto-conçu) — Auto-indentation vim (`:set autoindent`/
 * `:set ai`, `:set noautoindent`/`:set noai`).
 *
 * Sémantique réelle reproduite : quand `autoindent` est actif, la nouvelle
 * ligne créée par Entrée en mode INSERT, ou par `o`/`O` en mode NORMAL,
 * hérite exactement de l'indentation (espaces/tabulations en tête) de la
 * ligne de référence (la ligne sur laquelle on était), et le curseur se
 * place juste après cette indentation recopiée, prêt à taper. Désactivé
 * par défaut, comme le vrai vim (`noautoindent` est la valeur par
 * défaut).
 *
 * Portée assumée : pas de "smart" cleanup vim ≥ de la ligne indentée
 * laissée vide si on ne tape rien avant de ressortir de l'INSERT (un
 * raffinement de l'autoindent réel, hors périmètre ici) ; pas de
 * `:set shiftwidth`/`:set expandtab`/réindentation automatique de code
 * (`cindent`/`smartindent`) — seule la recopie littérale de
 * l'indentation de la ligne de référence est couverte, qui est le
 * comportement `autoindent` de base tel que documenté par `:help ai`.
 *
 * TDD: written against the headless VimEngine, before any autoindent
 * state or behavior exists (confirmed via grep: no `autoindent`,
 * `noai`, or indent-copying code present).
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function exCmd(engine: { applyKey(k: EditorKeyInput): void }, cmd: string): void {
  press(engine, ':');
  typeText(engine, cmd);
  press(engine, 'Enter');
}
function make(content: string, path = '/tmp/ai.txt'): VimEngine {
  const fs = new InMemoryEditorFsContext({ [path]: content });
  return new VimEngine(fs, path, content, false, 'vim');
}

describe('Scénario 13 — :set autoindent / :set ai / :set noautoindent / :set noai', () => {
  it('autoindent est désactivé par défaut (comme le vrai vim)', () => {
    const vim = make('x\n');
    expect(vim.autoindent).toBe(false);
  });

  it(':set autoindent et :set ai activent, :set noautoindent et :set noai désactivent', () => {
    const vim = make('x\n');
    exCmd(vim, 'set autoindent');
    expect(vim.autoindent).toBe(true);
    exCmd(vim, 'set noautoindent');
    expect(vim.autoindent).toBe(false);
    exCmd(vim, 'set ai');
    expect(vim.autoindent).toBe(true);
    exCmd(vim, 'set noai');
    expect(vim.autoindent).toBe(false);
  });
});

describe('Scénario 13 — Entrée en mode INSERT recopie l\'indentation (autoindent actif)', () => {
  it("une nouvelle ligne créée par Entrée hérite de l'indentation de la ligne précédente", () => {
    const vim = make('    indented line\n');
    exCmd(vim, 'set autoindent');
    press(vim, 'A'); // end of line, insert mode
    press(vim, 'Enter');
    expect(vim.lines).toEqual(['    indented line', '    ']);
    expect(vim.cursorCol).toBe(4); // cursor right after the copied indent
    typeText(vim, 'next');
    expect(vim.lines[1]).toBe('    next');
  });

  it("l'indentation recopiée est celle de la ligne d'origine, même si Entrée est pressée au milieu du texte", () => {
    const vim = make('  foobar\n');
    exCmd(vim, 'set autoindent');
    press(vim, '0');
    for (let i = 0; i < 5; i++) press(vim, 'l'); // cursor between "foo" and "bar" (col 5)
    press(vim, 'i');
    press(vim, 'Enter');
    expect(vim.lines).toEqual(['  foo', '  bar']);
  });

  it("des Entrée successives accumulent l'indentation de proche en proche, sans la doubler", () => {
    const vim = make('  line\n');
    exCmd(vim, 'set autoindent');
    press(vim, 'A');
    press(vim, 'Enter');
    typeText(vim, 'second');
    press(vim, 'Enter');
    expect(vim.lines).toEqual(['  line', '  second', '  ']);
  });

  it('sans autoindent (par défaut), Entrée produit une ligne totalement vide', () => {
    const vim = make('    indented line\n');
    press(vim, 'A');
    press(vim, 'Enter');
    expect(vim.lines).toEqual(['    indented line', '']);
    expect(vim.cursorCol).toBe(0);
  });
});

describe('Scénario 13 — o / O recopient l\'indentation (autoindent actif)', () => {
  it('o ouvre une nouvelle ligne en dessous, pré-indentée comme la ligne courante', () => {
    const vim = make('\tindented\n');
    exCmd(vim, 'set autoindent');
    press(vim, 'o');
    expect(vim.mode).toBe('insert');
    expect(vim.lines[1]).toBe('\t');
    expect(vim.cursorCol).toBe(1);
    typeText(vim, 'x');
    expect(vim.lines[1]).toBe('\tx');
  });

  it('O ouvre une nouvelle ligne au-dessus, pré-indentée comme la ligne courante', () => {
    const vim = make('    below\n');
    exCmd(vim, 'set autoindent');
    press(vim, 'O');
    expect(vim.mode).toBe('insert');
    expect(vim.lines).toEqual(['    ', '    below']);
    expect(vim.cursorCol).toBe(4);
  });

  it('sans autoindent, o et O ouvrent des lignes totalement vides', () => {
    const vim = make('    below\n');
    press(vim, 'o');
    expect(vim.lines[1]).toBe('');
    press(vim, 'Escape');
    press(vim, 'O');
    expect(vim.lines[1]).toBe('');
  });

  it("o sur une ligne non indentée n'ajoute aucune indentation (chaîne vide)", () => {
    const vim = make('flat\n');
    exCmd(vim, 'set autoindent');
    press(vim, 'o');
    expect(vim.lines[1]).toBe('');
    expect(vim.cursorCol).toBe(0);
  });
});
