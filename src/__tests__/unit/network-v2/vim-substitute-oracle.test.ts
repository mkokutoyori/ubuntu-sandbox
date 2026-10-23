/**
 * `:s` et ses parents rejoues contre un vrai vim 9.1 (scripts/oracle/record_vim_substitute.py, chaque cas dans son
 * propre `vim -u NONE -i NONE -N -es`, les touches envoyees par `feedkeys(..., 'xt')` pour que les commandes voient
 * KeyTyped comme dans une session interactive).  Un cas est un tampon, des commandes de preparation, une ligne de
 * depart et une commande ex ou des touches normales ; vim note le tampon, la position du curseur, la premiere
 * erreur affichee, le dernier message, le dernier motif de recherche (`@/`) et le tampon une fois TOUS les
 * changements defaits.  Le moteur rejoue la meme chose touche par touche dans VimEngine.
 *
 * Familles : es (echappements du remplacement : & \0-\9 \r \n \t \u \U \l \L \e \E ~), ml (motifs qui contiennent
 * un saut de ligne : \n, \_s, \_., $\n^), fl (drapeaux g c n e p # l r & i I, comptes, enchainements par |, formes
 * courtes `:s`, `:&`, `:~`), rg (plages), rp (seuil 'report' et 'gdefault'), tl (le `~` du remplacement), bd (marques
 * et zone visuelle), nm (`&`, `g&`, `:&&`, `:~` et la memoire des motifs), ic ('ignorecase') et ex/ey/xi (le
 * remplacement par expression `\=` : operateurs, nombres 64 bits, flottants au format de vim, chaines, listes,
 * dictionnaires, lambdas, 74 fonctions, et les erreurs E15 E110 E116 E117 E118 E119 E121 E488 ...).
 *
 * Mesure avec `git stash push -- src/network` : 2909 des 3860 cas tombaient avant (es 217 sur 372, ml 454 sur 564,
 * fl 856 sur 1380, rg 84 sur 90, rp 125 sur 210, tl 44 sur 54, bd 42 sur 42, nm 114 sur 114, ex 737 sur 741,
 * ey 202 sur 250, xi 13 sur 13, ic 21 sur 30) ; aucun ne tombe apres.  Les 950 qui passent des deux cotes sont
 * des TEMOINS ou des non-regressions : le `:s/motif/texte/` d'une seule ligne et ses drapeaux g I i r &, les plages
 * `%` `N,M` `.,$` `.+1`, les noms longs `su` `sub` `substitute`, les autres delimiteurs (`s#o#0#`, `s;o;0;`), les
 * correspondances de largeur nulle (`\zs`, `\ze`, `\(\)`, `x*`, `.\{-}`) et l'incomplet `s/`, `s//0/`, `sx` - ce
 * que l'ancien moteur faisait deja bien et que la reecriture ne doit pas perdre.  Le cas `s/o/0/|` finit sur la
 * ligne courante : un vim interactif ne bouge pas, alors qu'un vim en mode Ex descend d'une ligne, ce que le
 * recorder evite en ne rejouant pas la commande vide.
 *
 * Limites assumees, aucune n'est epinglee comme contrat : les dictionnaires de vim se parcourent dans l'ordre de
 * leur table de hachage, ce moteur dans l'ordre d'insertion (`keys()`, `values()`, `string()` d'un dictionnaire de
 * plusieurs cles) ; les fonctions d'un vim qui ne sont pas dans la table repondent E117 comme si elles n'existaient pas ;
 * `{s -> ...}` est une lambda, mais les variables `g:` `s:` `l:` `b:` et `:let` n'existent pas encore ; une option
 * que ni la table de VimOptions ni VimOptionDefaults ne connait repond E113.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

interface SubstituteCase {
  readonly id: string;
  readonly lines: readonly string[];
  readonly setup: readonly string[];
  readonly start: number;
  readonly cmd?: string;
  readonly keys?: readonly string[];
  readonly steps: readonly string[];
  readonly result: {
    readonly lines: readonly string[]; readonly pos: readonly [number, number]; readonly err: string;
    readonly output: string; readonly search: string; readonly undone: readonly string[];
  };
}

const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/vim-patterns/vim-9.1-substitute.json', 'utf8')) as { vim: string; cases: SubstituteCase[] };

const firstErrors = new WeakMap<VimEngine, string>();

function press(engine: VimEngine, key: ReturnType<typeof editorKey>): void {
  engine.applyKey(key);
  if (!firstErrors.has(engine) && /^E\d+/.test(engine.message)) firstErrors.set(engine, engine.message);
}

function beginStep(engine: VimEngine): void {
  (engine as unknown as { _message: string })._message = '';
  firstErrors.delete(engine);
}

function typeKeys(engine: VimEngine, text: string): void {
  for (const character of text) {
    if (character === '\r') press(engine, editorKey('Enter'));
    else if (character === '\x1b') press(engine, editorKey('Escape'));
    else press(engine, editorKey(character));
  }
}

function runEx(engine: VimEngine, command: string): void {
  press(engine, editorKey(':'));
  typeKeys(engine, command);
  press(engine, editorKey('Enter'));
}

function failure(c: SubstituteCase): string | null {
  const content = `${c.lines.join('\n')}\n`;
  const engine = new VimEngine(new InMemoryEditorFsContext({ '/tmp/t.txt': content }), '/tmp/t.txt', content, false, 'vim');
  for (const line of c.setup) {
    if (line.startsWith('normal! ')) typeKeys(engine, line.slice('normal! '.length));
    else runEx(engine, line);
  }
  typeKeys(engine, `${c.start}G0`);
  const undoDepth = () => (engine as unknown as { undoStack: unknown[] }).undoStack.length;
  const baseline = undoDepth();
  beginStep(engine);
  if (c.keys !== undefined) for (const step of c.keys) { beginStep(engine); typeKeys(engine, step); }
  else runEx(engine, c.cmd!);
  if (engine.mode === 'ask-swap-range') typeKeys(engine, 'y');
  const wanted = c.result;
  const problems: string[] = [];
  if (JSON.stringify(engine.lines) !== JSON.stringify(wanted.lines)) problems.push(`lines ${JSON.stringify(engine.lines)}, vim ${JSON.stringify(wanted.lines)}`);
  if (engine.cursorLine !== wanted.pos[0] || engine.cursorCol !== wanted.pos[1]) problems.push(`cursor [${engine.cursorLine},${engine.cursorCol}], vim ${JSON.stringify(wanted.pos)}`);
  const message = engine.message;
  const gotError = firstErrors.get(engine) ?? '';
  if (gotError !== wanted.err) problems.push(`error ${JSON.stringify(gotError)}, vim ${JSON.stringify(wanted.err)}`);
  if (wanted.err === '') {
    const wantedMessage = wanted.output.split('\n').pop() ?? '';
    if (message !== wantedMessage) problems.push(`message ${JSON.stringify(message)}, vim ${JSON.stringify(wanted.output)}`);
  }
  const search = (engine as unknown as { lastSearch: { pattern: string } | null }).lastSearch?.pattern ?? '';
  if (search !== wanted.search) problems.push(`search ${JSON.stringify(search)}, vim ${JSON.stringify(wanted.search)}`);
  for (let attempts = 0; undoDepth() > baseline && attempts < 20; attempts++) typeKeys(engine, 'u');
  if (JSON.stringify(engine.lines) !== JSON.stringify(wanted.undone)) problems.push(`undone ${JSON.stringify(engine.lines)}, vim ${JSON.stringify(wanted.undone)}`);
  return problems.length === 0 ? null : `${c.id} ${JSON.stringify(c.cmd ?? c.keys)} setup=${JSON.stringify(c.setup)} start=${c.start}: ${problems.join('; ')}`;
}

describe('vim :s recorded from a real vim', () => {
  it('has the cases of every family', () => {
    const families = new Set(fixture.cases.map((c) => c.id.replace(/\d+-\d+$/, '')));
    expect([...families].sort()).toEqual(['bd', 'es', 'ex', 'ey', 'fl', 'ic', 'ml', 'nm', 'rg', 'rp', 'tl', 'xi']);
    expect(fixture.cases.length).toBeGreaterThan(3800);
  });

  it('replays every case with the same buffer, cursor, error, message, search pattern and undo', () => {
    const failed = fixture.cases.map(failure).filter((outcome): outcome is string => outcome !== null);
    expect(failed.length > 0 ? `${failed.length} of ${fixture.cases.length}\n${failed.slice(0, 8).join('\n')}` : '').toBe('');
  });
});
