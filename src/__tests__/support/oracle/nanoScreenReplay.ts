import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey, type EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import { plainRowText } from '@/network/devices/linux/editors/screen/EditorScreen';
import { parseNanoCommandLine, type NanoInvocation } from '@/network/devices/linux/editors/nano/NanoCommandLine';

export interface NanoRecorded { y: number; x: number; rows: string[]; height: number; width: number }

export interface NanoScreenCase {
  id: string;
  text: string[];
  files?: Record<string, string[]>;
  rows: number;
  cols: number;
  flags?: string[];
  args?: string[];
  steps: string[];
  opened: NanoRecorded;
  after: NanoRecorded[];
}

const NAMED: Record<string, Partial<EditorKeyInput> & { key: string }> = {
  Left: { key: 'ArrowLeft' }, Right: { key: 'ArrowRight' }, Up: { key: 'ArrowUp' }, Down: { key: 'ArrowDown' },
  Home: { key: 'Home' }, End: { key: 'End' }, PageUp: { key: 'PageUp' }, PageDown: { key: 'PageDown' },
  Enter: { key: 'Enter' }, Tab: { key: 'Tab' }, BSpace: { key: 'Backspace' }, DC: { key: 'Delete' },
  'C-Left': { key: 'ArrowLeft', ctrl: true }, 'C-Right': { key: 'ArrowRight', ctrl: true },
  'M-Up': { key: 'ArrowUp', alt: true }, 'M-Down': { key: 'ArrowDown', alt: true },
};

export function nanoKeysOf(step: string): EditorKeyInput[] {
  const named = NAMED[step];
  if (named) return [editorKey(named.key, named)];
  const control = /^C-(.)$/.exec(step);
  if (control) return [editorKey(control[1], { ctrl: true })];
  const meta = /^M-(.)$/.exec(step);
  if (meta) return [editorKey(meta[1], { alt: true })];
  return [...step].map((ch) => editorKey(ch));
}

export function recordedArguments(c: NanoScreenCase): string[] {
  return c.args ?? [...(c.flags ?? []), 't.txt'];
}

export function launchNano(invocation: Extract<NanoInvocation, { kind: 'open' }>, c: NanoScreenCase): NanoEngine {
  const first = invocation.files[0];
  const name = first?.path ?? '';
  const lines = name === 't.txt' ? c.text : c.files?.[name];
  const content = lines === undefined ? null : lines.join('\n') + '\n';
  const fs = new InMemoryEditorFsContext(content === null ? {} : { [`/tmp/${name}`]: content });
  const engine = new NanoEngine(fs, name === '' ? '' : `/tmp/${name}`, content ?? '', content === null, false, undefined, false, {
    settings: invocation.settings, start: first?.start ?? null, displayName: name,
  });
  engine.resize(c.rows, c.cols);
  return engine;
}

export function compareNanoScreen(engine: NanoEngine, want: NanoRecorded): string | null {
  const screen = engine.screen;
  const got = screen.rows.map((row) => plainRowText(row).replace(/\s+$/, ''));
  const rowsOk = JSON.stringify(got) === JSON.stringify(want.rows);
  const cursor = screen.cursor;
  const cursorOk = cursor !== null && cursor.row === want.y && cursor.col === want.x;
  if (rowsOk && cursorOk) return null;
  return `\n  want y=${want.y} x=${want.x} rows=${JSON.stringify(want.rows)}\n  got  y=${cursor?.row} x=${cursor?.col} rows=${JSON.stringify(got)}`;
}

export function replayNanoScreenCase(c: NanoScreenCase): string | null {
  const args = recordedArguments(c);
  const invocation = parseNanoCommandLine(args);
  if (invocation.kind !== 'open') return `${c.id} ${JSON.stringify(args)} did not open an editor: ${JSON.stringify(invocation)}`;
  const engine = launchNano(invocation, c);
  const opened = compareNanoScreen(engine, c.opened);
  if (opened) return `${c.id} ${c.rows}x${c.cols} ${JSON.stringify(args)} opened${opened}`;
  for (let s = 0; s < c.after.length; s++) {
    const step = c.steps[s];
    if (step.startsWith('@')) {
      const [rows, cols] = step.slice(1).split('x').map(Number);
      engine.resize(rows, cols);
    } else {
      for (const k of nanoKeysOf(step)) engine.applyKey(k);
    }
    const failure = compareNanoScreen(engine, c.after[s]);
    if (failure) return `${c.id} ${c.rows}x${c.cols} ${JSON.stringify(args)} step ${s} ${JSON.stringify(c.steps.slice(0, s + 1))}${failure}`;
  }
  return null;
}
