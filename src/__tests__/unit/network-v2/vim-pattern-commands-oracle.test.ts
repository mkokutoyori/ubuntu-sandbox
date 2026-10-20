/**
 * Les commandes qui consomment un motif -- `:s`, `:g`, `:g!`, `:v`, `/`, `?`, `*`, `#`, `n` -- rejouees contre un
 * vrai vim 9.1 (scripts/oracle/record_vim_patterns.py --ex, `vim -u NONE -N -es`) : chaque cas est une commande ex ou
 * une suite de touches normales sur un tampon, avec ou sans 'ignorecase', et vim note le tampon apres coup, la
 * position du curseur et l'erreur levee (v:exception).  Le moteur rejoue la commande touche par touche dans
 * VimEngine ; on compare le tampon, le curseur et le code d'erreur -- avec son texte quand il est de la forme
 * `E<n>: ...` -- ainsi que le message `Pattern not found: ...` de `:g`.
 *
 * Mesure avec `git stash push -- src/network` : 299 des 496 cas tombaient avant (le tampon etait parfois juste,
 * mais pas l'erreur : `\(`, `\)`, `a\{2`, `\1`, `[b-a]` ne levaient pas E54, E55, E554, E65, E944 ; et `\zs`, `\ze`,
 * `\%l`, `\%c`, `\%v`, `\{-}`, `\V`, `\v`, `\t`, `\k`, `\%[` n'etaient pas lus comme vim les lit ; `~` n'existait pas ; `:g!` et `:v` non plus) ; il en reste 8 apres,
 * tous listes ci-dessous.  Les cas qui passent des deux cotes (`:s/foo/X/`, `:g/foo/d`, `/foo`) servent de temoins.
 *
 * Non porte, mesure et NON epingle (UNPORTED_CASES) : `:s` sur un motif qui contient un saut de ligne (`\n`,
 * `$\n^`) -- vim joint les lignes, le moteur traite chaque ligne separement et ne trouve rien.  Un cas de la liste
 * qui se met a passer fait echouer le test pour qu'on le retire.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

interface CommandCase {
  readonly id: string;
  readonly lines: readonly string[];
  readonly setup: readonly string[];
  readonly cmd?: string;
  readonly keys?: string;
  readonly result: { readonly lines: readonly string[]; readonly pos: readonly [number, number]; readonly err: string; readonly output: string };
}

const UNPORTED_CASES: ReadonlySet<string> = new Set([
  'ex0-53-0', 'ex0-53-1', 'ex0-54-0', 'ex0-54-1', 'ex1-53-0', 'ex1-53-1', 'ex1-54-0', 'ex1-54-1',
]);

const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/vim-patterns/vim-9.1-pattern-commands.json', 'utf8')) as { vim: string; cases: CommandCase[] };

function typeKeys(engine: VimEngine, text: string): void {
  for (const character of text) engine.applyKey(character === '\r' ? editorKey('Enter') : editorKey(character));
}

function runEx(engine: VimEngine, command: string): void {
  engine.applyKey(editorKey(':'));
  typeKeys(engine, command);
  engine.applyKey(editorKey('Enter'));
}

function failure(c: CommandCase): string | null {
  const content = `${c.lines.join('\n')}\n`;
  const engine = new VimEngine(new InMemoryEditorFsContext({ '/tmp/t.txt': content }), '/tmp/t.txt', content, false, 'vim');
  for (const line of c.setup) runEx(engine, line);
  if (c.keys !== undefined) typeKeys(engine, c.keys);
  else runEx(engine, c.cmd!);
  const wanted = c.result;
  const problems: string[] = [];
  if (JSON.stringify(engine.lines) !== JSON.stringify(wanted.lines)) problems.push(`lines ${JSON.stringify(engine.lines)}, vim ${JSON.stringify(wanted.lines)}`);
  if (engine.cursorLine !== wanted.pos[0] || engine.cursorCol !== wanted.pos[1]) problems.push(`cursor [${engine.cursorLine},${engine.cursorCol}], vim ${JSON.stringify(wanted.pos)}`);
  const message = engine.message.startsWith('E') ? engine.message : '';
  const wantedError = /^E(486|384|385):/.test(wanted.err) ? wanted.err.split(':')[0] : wanted.err;
  const gotError = /^E(486|384|385):/.test(message) ? message.split(':')[0] : message;
  if (gotError !== wantedError) problems.push(`error ${JSON.stringify(message)}, vim ${JSON.stringify(wanted.err)}`);
  if (wanted.output.startsWith('Pattern') && engine.message !== wanted.output) problems.push(`message ${JSON.stringify(engine.message)}, vim ${JSON.stringify(wanted.output)}`);
  return problems.length === 0 ? null : `${c.id} ${JSON.stringify(c.cmd ?? c.keys)} ic=${c.setup.length}: ${problems.join('; ')}`;
}

describe('vim pattern commands recorded from a real vim', () => {
  it('replays :s, :g, :v and the search keys with the same buffer, cursor and error', () => {
    const outcomes = fixture.cases.map((c) => ({ id: c.id, failure: failure(c) }));
    const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
    const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
    expect(unexpected.length > 0 ? `${unexpected.length} of ${fixture.cases.length}\n${unexpected.slice(0, 5).join('\n')}` : '').toBe('');
    expect(nowPassing).toEqual([]);
    expect(outcomes.filter((o) => o.failure === null).length).toBeGreaterThan(450);
  });
});
