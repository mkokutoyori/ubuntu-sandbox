import { installRealChildShell } from './nanoShellBridge';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey, type EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import { paintKey, plainRowText, type ScreenRow, type ScreenStyle } from '@/network/devices/linux/editors/screen/EditorScreen';
import { codePointWidth } from '@/network/devices/linux/editors/vim/VimCells';
import { parseNanoCommandLine, type NanoInvocation } from '@/network/devices/linux/editors/nano/NanoCommandLine';
import { buildNanoLock, parseNanoLock, type NanoLockData } from '@/network/devices/linux/editors/nano/NanoLock';
import { launchedFilePath, type EditorLaunch } from '@/network/devices/linux/editors/editorLaunch';

export type RecordedDisk = Record<string, string | { lock: NanoLockData }>;

export interface NanoRecorded { y: number; x: number; rows: string[]; height: number; width: number; disk?: RecordedDisk; attrs?: string[]; paint?: string[] }

export interface NanoScreenCase {
  id: string;
  casedir?: string;
  text: string[];
  files?: Record<string, string[]>;
  rows: number;
  cols: number;
  flags?: string[];
  args?: string[];
  steps: string[];
  disk?: boolean;
  hidden?: boolean;
  raw?: Record<string, string>;
  modes?: Record<string, number>;
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
  'C-Up': { key: 'ArrowUp', ctrl: true }, 'C-Down': { key: 'ArrowDown', ctrl: true },
  'M-Up': { key: 'ArrowUp', alt: true }, 'M-Down': { key: 'ArrowDown', alt: true }, Space: { key: ' ' },
};

export function nanoKeysOf(step: string): EditorKeyInput[] {
  const named = NAMED[step];
  if (named) return [editorKey(named.key, named)];
  const functionKey = /^F(\d{1,2})$/.exec(step);
  if (functionKey) return [editorKey(step)];
  const control = /^C-(.)$/.exec(step);
  if (control) return [editorKey(control[1], { ctrl: true })];
  const meta = /^M-(.)$/.exec(step);
  if (meta) return [editorKey(meta[1], { alt: true })];
  return [...step].map((ch) => (ch === '\t' ? editorKey('Tab') : editorKey(ch)));
}

const MOUSE_STEP = /^(click|wheel-up|wheel-down)@(\d+),(\d+)$/;

export function applyNanoStep(engine: NanoEngine, step: string): void {
  const mouse = MOUSE_STEP.exec(step);
  if (mouse === null) {
    for (const k of nanoKeysOf(step)) engine.applyKey(k);
    return;
  }
  const row = Number(mouse[2]);
  const col = Number(mouse[3]);
  if (mouse[1] === 'click') engine.clickAt(row, col);
  else engine.wheelAt(row, col, mouse[1] === 'wheel-down');
}

export function recordedArguments(c: NanoScreenCase): string[] {
  return c.args ?? [...(c.flags ?? []), 't.txt'];
}

export function workingDirectoryOf(c: NanoScreenCase): string {
  return c.casedir ?? '/tmp';
}

export function seededFileSystem(c: NanoScreenCase, extra: Record<string, string> = {}): InMemoryEditorFsContext {
  const directory = workingDirectoryOf(c);
  const initial: Record<string, string> = { [`${directory}/t.txt`]: c.text.join('\n') + '\n', ...extra };
  for (const [extra, extraLines] of Object.entries(c.files ?? {})) initial[`${directory}/${extra}`] = extraLines.join('\n') + '\n';
  for (const [rawName, hex] of Object.entries(c.raw ?? {})) initial[`${directory}/${rawName}`] = Buffer.from(hex, 'hex').toString('utf8');
  for (const [lockName, lock] of Object.entries(c.locks ?? {})) initial[`${directory}/${lockName}`] = buildNanoLock(lock);
  const fs = new InMemoryEditorFsContext(initial, undefined, undefined, directory);
  fs.refuseWritesIntoMissingDirectories();
  installRealChildShell(fs, directory);
  for (const [modeName, mode] of Object.entries(c.modes ?? {})) fs.setMode(`${directory}/${modeName}`, mode);
  return fs;
}

export function launchNano(invocation: Extract<NanoInvocation, { kind: 'open' }>, c: NanoScreenCase): { engine: NanoEngine; fs: InMemoryEditorFsContext } {
  const first = invocation.files[0];
  const name = first?.path ?? '';
  const fs = seededFileSystem(c);
  const launch: EditorLaunch = { editor: 'nano', filePath: name, nano: { settings: invocation.settings, start: first?.start ?? null } };
  const absolute = launchedFilePath(fs, launch);
  const content = absolute === '' ? null : fs.readFile(absolute);
  const engine = new NanoEngine(fs, absolute, content ?? '', content === null, false, undefined, false, {
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

export function compareDisk(fs: InMemoryEditorFsContext, want: RecordedDisk, hidden: boolean, directory: string, ignoredPrefixes: readonly string[] = []): string | null {
  const failures: string[] = [];
  for (const [name, expected] of Object.entries(want)) {
    const content = fs.readFile(`${directory}/${name}`);
    if (typeof expected === 'string') {
      if (content !== expected) failures.push(`\n  disk ${name} want ${JSON.stringify(expected)}\n  disk ${name} got  ${JSON.stringify(content)}`);
    } else {
      const failure = compareLock(name, expected.lock, content);
      if (failure !== null) failures.push(failure);
    }
  }
  const present = fs.fileNames().filter((path) => !ignoredPrefixes.some((prefix) => path.startsWith(prefix))).map((path) => (path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : path)).filter((file) => hidden || !file.split('/').some((part) => part.startsWith('.')));
  const unexpected = present.filter((file) => !(file in want));
  if (unexpected.length > 0) failures.push(`\n  disk has unexpected files ${JSON.stringify(unexpected)}`);
  return failures.length === 0 ? null : failures.join('');
}

const STYLE_LETTERS: Partial<Record<ScreenStyle, string>> = { reverse: 'r', bold: 'b', alert: 'a', search: 'y' };
const BLANK_LETTERS: Readonly<Record<string, string>> = { b: '.', a: 'R' };

export function attributeLetters(row: ScreenRow, width: number): string {
  const letters = new Array<string>(width).fill('.');
  for (const span of row.spans) {
    for (let cell = Math.max(0, span.from); cell < Math.min(width, span.to); cell++) letters[cell] = STYLE_LETTERS[span.style] ?? '?';
  }
  return letters.join('');
}

function visibleLetters(letters: string, text: string): string {
  const blank = new Set<number>();
  let cell = 0;
  for (const ch of text) {
    const span = codePointWidth(ch.codePointAt(0)!);
    if (ch === ' ') blank.add(cell);
    cell += span;
  }
  return [...letters].map((letter, index) => (index >= cell || blank.has(index) ? BLANK_LETTERS[letter] ?? letter : letter)).join('');
}

const DEFAULT_PAINT = '-/-/';
const STYLE_KEYS: Partial<Record<ScreenStyle, string>> = { reverse: '-/-/r', bold: '-/-/b', alert: '7/1/b', search: '0/11/' };

function blankColumns(text: string, width: number): boolean[] {
  const blank = new Array<boolean>(width).fill(true);
  let cell = 0;
  for (const ch of text) {
    const span = codePointWidth(ch.codePointAt(0)!);
    for (let k = 0; k < Math.max(span, 1) && cell + k < width; k++) blank[cell + k] = ch === ' ';
    cell += span;
  }
  return blank;
}

function settledKey(key: string, blank: boolean): string {
  if (!blank) return key;
  const [fg, bg, flags] = key.split('/');
  const reverse = flags.includes('r');
  return `${reverse ? fg : '-'}/${bg}/${flags.replace(/[bi]/g, '')}`;
}

export function paintKeys(row: ScreenRow, width: number): string[] {
  const keys = new Array<string>(width).fill(DEFAULT_PAINT);
  for (const span of row.spans) {
    const key = span.style === 'paint' ? paintKey(span.paint!) : STYLE_KEYS[span.style] ?? `?${span.style}`;
    for (let cell = Math.max(0, span.from); cell < Math.min(width, span.to); cell++) keys[cell] = key;
  }
  return keys;
}

function paintDifference(row: ScreenRow, text: string, wanted: string, legend: Readonly<Record<string, string>>, width: number, index: number): string | null {
  const blank = blankColumns(text, width);
  const gotKeys = paintKeys(row, width).map((key, cell) => settledKey(key, blank[cell]));
  const wantKeys = [...wanted].map((letter, cell) => settledKey(legend[letter] ?? `?${letter}`, blank[cell] ?? true));
  const differing = wantKeys.flatMap((key, cell) => (key === gotKeys[cell] ? [] : [`    col ${cell} ${JSON.stringify(text[cell] ?? ' ')} want ${key} got ${gotKeys[cell]}`]));
  return differing.length === 0 ? null : `\n  paint row ${index} ${JSON.stringify(text)}\n${differing.slice(0, 6).join('\n')}${differing.length > 6 ? `\n    ... ${differing.length - 6} more` : ''}`;
}

export function compareNanoScreen(engine: NanoEngine, fs: InMemoryEditorFsContext, want: NanoRecorded, hidden = false, directory = '/tmp', ignoredPrefixes: readonly string[] = [], legend: Readonly<Record<string, string>> | null = null): string | null {
  const screen = engine.screen;
  const got = screen.rows.map((row) => plainRowText(row).replace(/\s+$/, ''));
  const rowsOk = JSON.stringify(got) === JSON.stringify(want.rows);
  const cursor = screen.cursor;
  const cursorOk = cursor !== null && cursor.row === want.y && cursor.col === want.x;
  const diskFailure = want.disk === undefined ? null : compareDisk(fs, want.disk, hidden, directory, ignoredPrefixes);
  const gotAttrs = screen.rows.map((row, index) => visibleLetters(attributeLetters(row, want.width), got[index]));
  const wantAttrs = want.attrs?.map((letters, index) => visibleLetters(letters, want.rows[index] ?? ''));
  const attrsOk = wantAttrs === undefined || JSON.stringify(gotAttrs) === JSON.stringify(wantAttrs);
  const paintLines = want.paint === undefined || legend === null ? [] : want.paint.flatMap((letters, index) => {
    const difference = paintDifference(screen.rows[index] ?? { text: '', spans: [] }, want.rows[index] ?? '', letters, legend, want.width, index);
    return difference === null ? [] : [difference];
  });
  if (rowsOk && cursorOk && attrsOk && paintLines.length === 0) return diskFailure;
  const attrLines = attrsOk ? '' : wantAttrs!.map((expected, index) => (expected === gotAttrs[index] ? null : `\n  attrs row ${index} ${JSON.stringify(got[index] ?? '')}\n    want ${expected}\n    got  ${gotAttrs[index]}`)).filter((line) => line !== null).join('');
  return `${diskFailure ?? ''}\n  want y=${want.y} x=${want.x} rows=${JSON.stringify(want.rows)}\n  got  y=${cursor?.row} x=${cursor?.col} rows=${JSON.stringify(got)}${attrLines}${paintLines.join('')}`;
}

export function replayNanoScreenCase(c: NanoScreenCase): string | null {
  const args = recordedArguments(c);
  const invocation = parseNanoCommandLine(args);
  if (invocation.kind !== 'open') return `${c.id} ${JSON.stringify(args)} did not open an editor: ${JSON.stringify(invocation)}`;
  const { engine, fs } = launchNano(invocation, c);
  const opened = compareNanoScreen(engine, fs, c.opened, c.hidden === true, workingDirectoryOf(c));
  if (opened) return `${c.id} ${c.rows}x${c.cols} ${JSON.stringify(args)} opened${opened}`;
  for (let s = 0; s < c.after.length; s++) {
    const step = c.steps[s];
    if (step.startsWith('@')) {
      const [rows, cols] = step.slice(1).split('x').map(Number);
      engine.resize(rows, cols);
    } else {
      applyNanoStep(engine, step);
    }
    const failure = compareNanoScreen(engine, fs, c.after[s], c.hidden === true, workingDirectoryOf(c));
    if (failure) return `${c.id} ${c.rows}x${c.cols} ${JSON.stringify(args)} step ${s} ${JSON.stringify(c.steps.slice(0, s + 1))}${failure}`;
  }
  if (c.exit_step === undefined) return null;
  applyNanoStep(engine, c.exit_step);
  if (!engine.exited) return `${c.id} ${JSON.stringify(args)} ${JSON.stringify(c.exit_step)} should have made nano exit`;
  const final = c.final_disk === undefined ? null : compareDisk(fs, c.final_disk, c.hidden === true, workingDirectoryOf(c));
  return final === null ? null : `${c.id} ${JSON.stringify(args)} after exit${final}`;
}
