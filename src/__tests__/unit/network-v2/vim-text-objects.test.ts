/**
 * Scénario 12 (auto-conçu) — Objets de texte vim (`iw`/`aw`, `i"`/`a"`,
 * `i'`/`a'`, `i(`/`a(` (+ alias `b`), `i{`/`a{` (+ alias `B`), `i[`/`a[`)
 * combinés aux opérateurs `d`/`c`/`y`.
 *
 * Sémantique réelle reproduite :
 *  - `iw` sélectionne le mot (ou la ponctuation, ou le blanc) sous le
 *    curseur uniquement ; `aw` l'étend au blanc qui suit, ou, à défaut,
 *    au blanc qui précède (règle exacte de vim).
 *  - `i"`/`i'` sélectionnent le contenu entre guillemets sans les
 *    guillemets ; si le curseur n'est pas encore dans une paire, vim
 *    recherche la prochaine paire en avant sur la ligne — reproduit ici.
 *    `a"`/`a'` incluent les guillemets, puis le même blanc
 *    suivant/précédent que `aw`.
 *  - `i(`/`i{`/`i[` trouvent la paire de crochets/parenthèses/accolades
 *    englobant le curseur (gère l'imbrication) ; `a` variante inclut les
 *    délimiteurs eux-mêmes.
 *
 * Portée assumée : comme pour le reste du moteur d'opérateurs caractère
 * par caractère de ce fichier (déjà limité à une seule ligne pour
 * `dw`/`d$`/etc., et pour les marques du scénario 11), la résolution des
 * objets de texte reste mono-ligne — une chaîne entre guillemets ou une
 * parenthèse non refermée sur la même ligne ne résout rien (annulation,
 * comme tout mouvement non reconnu après un opérateur). Pas de support
 * de compteur (`2diw`) ni d'objets de texte en mode VISUAL (`viw`) —
 * hors périmètre pour ce scénario.
 *
 * TDD: written against the headless VimEngine, before any text-object
 * resolution exists (confirmed via grep: no `computeTextObjectRange`,
 * `diw`, or bracket-pair matching code present).
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function make(content: string, path = '/tmp/to.txt'): VimEngine {
  const fs = new InMemoryEditorFsContext({ [path]: content });
  return new VimEngine(fs, path, content, false, 'vim');
}
function moveToCol(vim: VimEngine, col: number): void {
  press(vim, '0');
  for (let i = 0; i < col; i++) press(vim, 'l');
}

describe('Scénario 12 — iw / aw (mot sous le curseur)', () => {
  it('diw supprime uniquement le mot sous le curseur, sans le blanc environnant', () => {
    const vim = make('foo bar baz\n');
    moveToCol(vim, 5); // inside "bar"
    press(vim, 'd'); press(vim, 'i'); press(vim, 'w');
    expect(vim.lines[0]).toBe('foo  baz');
  });

  it('daw supprime le mot ET le blanc qui suit (règle "a")', () => {
    const vim = make('foo bar baz\n');
    moveToCol(vim, 5); // inside "bar"
    press(vim, 'd'); press(vim, 'a'); press(vim, 'w');
    expect(vim.lines[0]).toBe('foo baz');
  });

  it("daw sur le dernier mot (sans blanc après) prend le blanc qui précède à la place", () => {
    const vim = make('foo bar baz\n');
    moveToCol(vim, 9); // inside "baz", the last word, nothing trailing
    press(vim, 'd'); press(vim, 'a'); press(vim, 'w');
    expect(vim.lines[0]).toBe('foo bar');
  });

  it('ciw remplace le mot et repasse en INSERT', () => {
    const vim = make('change this word\n');
    moveToCol(vim, 0);
    press(vim, 'c'); press(vim, 'i'); press(vim, 'w');
    expect(vim.mode).toBe('insert');
    expect(vim.lines[0]).toBe(' this word');
  });

  it('yiw copie le mot sans modifier le buffer, puis p le colle', () => {
    const vim = make('alpha beta\n');
    moveToCol(vim, 0);
    press(vim, 'y'); press(vim, 'i'); press(vim, 'w');
    expect(vim.lines[0]).toBe('alpha beta'); // unchanged
    press(vim, '$');
    press(vim, 'p');
    expect(vim.lines[0]).toBe('alpha betaalpha');
  });

  it('diw sur un caractère de ponctuation ne supprime que la ponctuation, pas le mot voisin', () => {
    const vim = make('foo, bar\n');
    moveToCol(vim, 3); // the comma
    press(vim, 'd'); press(vim, 'i'); press(vim, 'w');
    expect(vim.lines[0]).toBe('foo bar');
  });
});

describe('Scénario 12 — i" / a" / i\' / a\' (chaînes entre guillemets)', () => {
  it('di" supprime le contenu entre guillemets doubles, sans les guillemets', () => {
    const vim = make('say "hello world" now\n');
    moveToCol(vim, 6); // inside "hello world"
    press(vim, 'd'); press(vim, 'i'); press(vim, '"');
    expect(vim.lines[0]).toBe('say "" now');
  });

  it('da" supprime aussi les guillemets et le blanc qui suit', () => {
    const vim = make('say "hello world" now\n');
    moveToCol(vim, 6);
    press(vim, 'd'); press(vim, 'a'); press(vim, '"');
    expect(vim.lines[0]).toBe('say now');
  });

  it("ci' change le contenu entre guillemets simples", () => {
    const vim = make("path is 'old/value' here\n");
    moveToCol(vim, 10); // inside 'old/value'
    press(vim, 'c'); press(vim, 'i'); press(vim, "'");
    expect(vim.mode).toBe('insert');
    expect(vim.lines[0]).toBe("path is '' here");
  });

  it('curseur avant les guillemets : vim cherche la paire suivante sur la ligne', () => {
    const vim = make('go "here" now\n');
    moveToCol(vim, 0); // on "go", before the quotes
    press(vim, 'd'); press(vim, 'i'); press(vim, '"');
    expect(vim.lines[0]).toBe('go "" now');
  });

  it("aucune paire de guillemets sur la ligne : l'opérateur est annulé, rien ne change", () => {
    const vim = make('no quotes here\n');
    moveToCol(vim, 3);
    press(vim, 'd'); press(vim, 'i'); press(vim, '"');
    expect(vim.lines[0]).toBe('no quotes here');
  });
});

describe('Scénario 12 — i( / a( (+ alias b), i{ / a{ (+ alias B), i[ / a[', () => {
  it('di( supprime le contenu entre parenthèses, gère les parenthèses imbriquées (paire la plus interne)', () => {
    const vim = make('call(foo(bar), baz)\n');
    moveToCol(vim, 9); // inside "bar", nested inside foo(...)
    press(vim, 'd'); press(vim, 'i'); press(vim, '(');
    expect(vim.lines[0]).toBe('call(foo(), baz)');
  });

  it('da) (curseur sur la parenthèse fermante) supprime les parenthèses elles-mêmes', () => {
    const vim = make('call(foo, bar)\n');
    moveToCol(vim, 13); // the closing paren itself
    press(vim, 'd'); press(vim, 'a'); press(vim, ')');
    expect(vim.lines[0]).toBe('call');
  });

  it("dib est un alias exact de di( ", () => {
    const vim = make('wrap(inside) tail\n');
    moveToCol(vim, 7);
    press(vim, 'd'); press(vim, 'i'); press(vim, 'b');
    expect(vim.lines[0]).toBe('wrap() tail');
  });

  it('ci{ change le contenu entre accolades', () => {
    const vim = make('fn() { return 1; }\n');
    moveToCol(vim, 8); // inside the braces
    press(vim, 'c'); press(vim, 'i'); press(vim, '{');
    expect(vim.mode).toBe('insert');
    expect(vim.lines[0]).toBe('fn() {}');
  });

  it('diB est un alias exact de di{', () => {
    const vim = make('block { body here } end\n');
    moveToCol(vim, 10);
    press(vim, 'd'); press(vim, 'i'); press(vim, 'B');
    expect(vim.lines[0]).toBe('block {} end');
  });

  it('da{ supprime les accolades elles-mêmes', () => {
    const vim = make('x = { y } ;\n');
    moveToCol(vim, 6);
    press(vim, 'd'); press(vim, 'a'); press(vim, '{');
    expect(vim.lines[0]).toBe('x = ;');
  });

  it('di[ / da[ ciblent les crochets', () => {
    const vim = make('arr[index] end\n');
    moveToCol(vim, 5);
    press(vim, 'd'); press(vim, 'i'); press(vim, '[');
    expect(vim.lines[0]).toBe('arr[] end');
  });

  it("aucune parenthèse englobante sur la ligne : l'opérateur est annulé", () => {
    const vim = make('nothing here\n');
    moveToCol(vim, 3);
    press(vim, 'd'); press(vim, 'i'); press(vim, '(');
    expect(vim.lines[0]).toBe('nothing here');
  });
});
