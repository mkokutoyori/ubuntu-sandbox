import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey, type EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import { plainRowText } from '@/network/devices/linux/editors/screen/EditorScreen';
import { parseNanoCommandLine, type NanoInvocation } from '@/network/devices/linux/editors/nano/NanoCommandLine';
import { buildNanoLock, parseNanoLock, type NanoLockData } from '@/network/devices/linux/editors/nano/NanoLock';

export type RecordedDisk = Record<string, string | { lock: NanoLockData }>;

export interface NanoRecorded { y: number; x: number; rows: string[]; height: number; width: number; disk?: RecordedDisk }

export interface NanoScreenCase {
  id: string;
  text: string[];
  files?: Record<string, string[]>;
  rows: number;
  cols: number;
  flags?: string[];
  args?: string[];
  steps: string[];
  disk?: boolean;
  hidden?: boolean;
  locks?: Record<string, NanoLockData>;
  exit_step?: string;
  final_disk?: RecordedDisk;
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
  return [...step].map((ch) => (ch === '\t' ? editorKey('Tab') : editorKey(ch)));
}

export function recordedArguments(c: NanoScreenCase): string[] {
  return c.args ?? [...(c.flags ?? []), 't.txt'];
}

export function launchNano(invocation: Extract<NanoInvocation, { kind: 'open' }>, c: NanoScreenCase): { engine: NanoEngine; fs: InMemoryEditorFsContext } {
  const first = invocation.files[0];
  const name = first?.path ?? '';
  const lines = name === 't.txt' ? c.text : c.files?.[name];
  const content = lines === undefined ? null : lines.join('\n') + '\n';
  const initial: Record<string, string> = { '/tmp/t.txt': c.text.join('\n') + '\n' };
  for (const [extra, extraLines] of Object.entries(c.files ?? {})) initial[`/tmp/${extra}`] = extraLines.join('\n') + '\n';
  for (const [lockName, lock] of Object.entries(c.locks ?? {})) initial[`/tmp/${lockName}`] = buildNanoLock(lock);
  const fs = new InMemoryEditorFsContext(initial);
  if (content === null) fs.deleteFile(`/tmp/${name}`);
  const engine = new NanoEngine(fs, name === '' ? '' : `/tmp/${name}`, content ?? '', content === null, false, undefined, false, {
    settings: invocation.settings, start: first?.start ?? null, displayName: name,
  });
  engine.resize(c.rows, c.cols);
  return { engine, fs };
}

function compareLock(name: string, want: NanoLockData, content: string | null): string | null {
  if (content === null) return `\n  disk ${name} want a lock file, got none`;
  const got = parseNanoLock(content);
  if (got === null) return `\n  disk ${name} want a lock file, got ${JSON.stringify(content.slice(0, 40))}`;
  const holderKnown = got.pid > 0 && got.user !== '' && got.host !== '';
  const same = got.program === want.program && got.name === want.name && got.modified === want.modified && holderKnown;
  return same ? null : `\n  disk ${name} want ${JSON.stringify(want)} got ${JSON.stringify(got)}`;
}

function compareDisk(fs: InMemoryEditorFsContext, want: RecordedDisk, hidden: boolean): string | null {
  const failures: string[] = [];
  for (const [name, expected] of Object.entries(want)) {
    const content = fs.readFile(`/tmp/${name}`);
    if (typeof expected === 'string') {
      if (content !== expected) failures.push(`\n  disk ${name} want ${JSON.stringify(expected)}\n  disk ${name} got  ${JSON.stringify(content)}`);
    } else {
      const failure = compareLock(name, expected.lock, content);
      if (failure !== null) failures.push(failure);
    }
  }
  const present = fs.fileNames().map((path) => path.replace(/^\/tmp\//, '')).filter((file) => hidden || !file.startsWith('.'));
  const unexpected = present.filter((file) => !(file in want));
  if (unexpected.length > 0) failures.push(`\n  disk has unexpected files ${JSON.stringify(unexpected)}`);
  return failures.length === 0 ? null : failures.join('');
}

export function compareNanoScreen(engine: NanoEngine, fs: InMemoryEditorFsContext, want: NanoRecorded, hidden = false): string | null {
  const screen = engine.screen;
  const got = screen.rows.map((row) => plainRowText(row).replace(/\s+$/, ''));
  const rowsOk = JSON.stringify(got) === JSON.stringify(want.rows);
  const cursor = screen.cursor;
  const cursorOk = cursor !== null && cursor.row === want.y && cursor.col === want.x;
  const diskFailure = want.disk === undefined ? null : compareDisk(fs, want.disk, hidden);
  if (rowsOk && cursorOk) return diskFailure;
  return `${diskFailure ?? ''}\n  want y=${want.y} x=${want.x} rows=${JSON.stringify(want.rows)}\n  got  y=${cursor?.row} x=${cursor?.col} rows=${JSON.stringify(got)}`;
}

export function replayNanoScreenCase(c: NanoScreenCase): string | null {
  const args = recordedArguments(c);
  const invocation = parseNanoCommandLine(args);
  if (invocation.kind !== 'open') return `${c.id} ${JSON.stringify(args)} did not open an editor: ${JSON.stringify(invocation)}`;
  const { engine, fs } = launchNano(invocation, c);
  const opened = compareNanoScreen(engine, fs, c.opened, c.hidden === true);
  if (opened) return `${c.id} ${c.rows}x${c.cols} ${JSON.stringify(args)} opened${opened}`;
  for (let s = 0; s < c.after.length; s++) {
    const step = c.steps[s];
    if (step.startsWith('@')) {
      const [rows, cols] = step.slice(1).split('x').map(Number);
      engine.resize(rows, cols);
    } else {
      for (const k of nanoKeysOf(step)) engine.applyKey(k);
    }
    const failure = compareNanoScreen(engine, fs, c.after[s], c.hidden === true);
    if (failure) return `${c.id} ${c.rows}x${c.cols} ${JSON.stringify(args)} step ${s} ${JSON.stringify(c.steps.slice(0, s + 1))}${failure}`;
  }
  if (c.exit_step === undefined) return null;
  for (const k of nanoKeysOf(c.exit_step)) engine.applyKey(k);
  if (!engine.exited) return `${c.id} ${JSON.stringify(args)} ${JSON.stringify(c.exit_step)} should have made nano exit`;
  const final = c.final_disk === undefined ? null : compareDisk(fs, c.final_disk, c.hidden === true);
  return final === null ? null : `${c.id} ${JSON.stringify(args)} after exit${final}`;
}
