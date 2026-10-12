import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey, type EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import { plainRowText } from '@/network/devices/linux/editors/screen/EditorScreen';

type AttrRuns = [from: number, to: number, attr: string][];
interface Recorded { y: number; x: number; rows: string[]; last: string; height: number; width: number; attrs?: AttrRuns[] }
export interface ScreenCase { id: string; text: string[]; rows: number; cols: number; setup: string[]; steps: string[]; after: Recorded[]; mouse?: string }

const NAMED: Record<string, [string, Partial<EditorKeyInput>]> = {
  Esc: ['Escape', {}], CR: ['Enter', {}], Tab: ['Tab', {}], BS: ['Backspace', {}], Space: [' ', {}],
  Up: ['ArrowUp', {}], Down: ['ArrowDown', {}], Left: ['ArrowLeft', {}], Right: ['ArrowRight', {}],
  Home: ['Home', {}], End: ['End', {}], PageUp: ['PageUp', {}], PageDown: ['PageDown', {}], Del: ['Delete', {}],
};

function keysOf(step: string): EditorKeyInput[] {
  const out: EditorKeyInput[] = [];
  for (let i = 0; i < step.length;) {
    const named = /^<(C-([a-z[])|[A-Za-z]+)>/.exec(step.slice(i));
    if (named) {
      if (named[2] !== undefined) { out.push(editorKey(named[2], { ctrl: true })); i += named[0].length; continue; }
      const entry = NAMED[named[1]];
      if (entry) { out.push(editorKey(entry[0], entry[1])); i += named[0].length; continue; }
    }
    const cp = step.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out.push(editorKey(ch));
    i += ch.length;
  }
  return out;
}

function textRows(engine: VimEngine): string[] {
  return engine.screen.rows.slice(0, -1).map((row) => plainRowText(row).replace(/\s+$/, ''));
}

const STYLE_ATTRIBUTE: Readonly<Record<string, string>> = { search: 'b103', incsearch: '+7' };

function wantedCells(want: Recorded, rowCount: number, style: string): string[] {
  const cells: string[] = [];
  (want.attrs ?? []).slice(0, rowCount).forEach((runs, row) => {
    for (const [from, to, attr] of runs) {
      if (attr.split(',').includes(STYLE_ATTRIBUTE[style])) for (let col = from; col < to; col++) cells.push(`${row}:${col}`);
    }
  });
  return cells;
}

function paintedCells(engine: VimEngine, rowCount: number, style: string): string[] {
  const cells: string[] = [];
  engine.screen.rows.slice(0, rowCount).forEach((row, index) => {
    for (const span of row.spans) {
      if (span.style === style) for (let col = span.from; col < span.to; col++) cells.push(`${index}:${col}`);
    }
  });
  return cells;
}

export function replayScreenCase(c: ScreenCase): string | null {
  const content = c.text.join('\n') + '\n';
  const fs = new InMemoryEditorFsContext({ '/tmp/s.txt': content });
  const engine = new VimEngine(fs, '/tmp/s.txt', content, false, 'vim');
  engine.resize(c.rows, c.cols);
  const setup = c.mouse === undefined ? c.setup : [`set mouse=${c.mouse}`, ...c.setup];
  for (const line of setup) for (const k of keysOf(`:${line}<CR>`)) engine.applyKey(k);
  for (let s = 0; s < c.after.length; s++) {
    const step = c.steps[s];
    if (step.startsWith('@click:')) {
      const [, row, col] = step.split(':').map(Number);
      engine.clickAt(row, col);
    } else if (step.startsWith('@')) {
      const [rows, cols] = step.slice(1).split('x').map(Number);
      engine.resize(rows, cols);
    } else {
      for (const k of keysOf(step)) engine.applyKey(k);
    }
    const want = c.after[s];
    const got = textRows(engine);
    const screen = engine.screen;
    const rowsOk = JSON.stringify(got) === JSON.stringify(want.rows.slice(0, got.length).map((r) => r.replace(/\s+$/, '')));
    const wantAtCommandLine = want.y >= want.height - 1;
    const typing = engine.mode === 'search' || engine.mode === 'command';
    const cursorOk = typing
      ? screen.cursor !== null && screen.cursor.row === want.y && screen.cursor.col === want.x
      : wantAtCommandLine || (screen.cursor !== null && screen.cursor.row === want.y && screen.cursor.col === want.x);
    const styleDiffs = want.attrs === undefined ? [] : Object.keys(STYLE_ATTRIBUTE).flatMap((style) => {
      const wanted = wantedCells(want, got.length, style);
      const painted = paintedCells(engine, got.length, style);
      return JSON.stringify(wanted) === JSON.stringify(painted) ? [] : [`\n  want ${style}=${JSON.stringify(wanted)}\n  got  ${style}=${JSON.stringify(painted)}`];
    });
    if (!rowsOk || !cursorOk || styleDiffs.length > 0) {
      return `${c.id} ${c.rows}x${c.cols} ${JSON.stringify(c.setup)} step ${s} ${JSON.stringify(c.steps.slice(0, s + 1))}\n  want y=${want.y} x=${want.x} rows=${JSON.stringify(want.rows)}\n  got  y=${screen.cursor?.row} x=${screen.cursor?.col} rows=${JSON.stringify(got)}${styleDiffs.join('')}`;
    }
  }
  return null;
}
