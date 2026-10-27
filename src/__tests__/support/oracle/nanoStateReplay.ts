import { posix } from 'path';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import type { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { parseNanoCommandLine } from '@/network/devices/linux/editors/nano/NanoCommandLine';
import { editorLaunchFailure, launchedFilePath, withRcfiles, type EditorLaunch } from '@/network/devices/linux/editors/editorLaunch';
import { NANO_PACKAGE_FILES, NANO_PACKAGE_LINKS } from '@/network/devices/linux/editors/nano/NanoPackageFiles';
import { applyNanoStep, compareDisk, compareNanoScreen, seededFileSystem, type NanoRecorded, type NanoScreenCase, type RecordedDisk } from './nanoScreenReplay';

export interface RecordedEntry { mode: number; content?: string }

export interface NanoStateRun {
  args: string[];
  steps: string[];
  opened: NanoRecorded;
  after: NanoRecorded[];
  exit_step?: string;
  exit_rows?: string[];
  exit_disk?: RecordedDisk;
  home: Record<string, RecordedEntry>;
  xdg?: Record<string, RecordedEntry>;
}

export interface NanoStateCase {
  id: string;
  casedir: string;
  lab: string;
  text: string[];
  files?: Record<string, string[]>;
  rows: number;
  cols: number;
  home: Record<string, string>;
  xdg: Record<string, string>;
  env: Record<string, string>;
  rc?: boolean;
  package?: boolean;
  etc_nanorc?: string;
  paint?: boolean;
  legend?: Record<string, string>;
  runs: NanoStateRun[];
}

const HOME = '/root';
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIRECTORY_MODE = 0o755;

function withTokens(text: string, c: NanoStateCase): string {
  return text.replace(/@WORK@/g, c.casedir).replace(/@LAB@/g, c.lab);
}

function shippedPackageFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of NANO_PACKAGE_FILES) files[file.path] = file.content;
  for (const link of NANO_PACKAGE_LINKS) files[link.path] = files[posix.normalize(`${posix.dirname(link.path)}/${link.target}`)];
  return files;
}

function seededState(c: NanoStateCase): InMemoryEditorFsContext {
  const extra: Record<string, string> = c.package ? shippedPackageFiles() : c.rc ? { '/etc/nanorc': withTokens(c.etc_nanorc ?? '', c) } : {};
  const directories: string[] = [];
  for (const [tree, root] of [[c.home, HOME], [c.xdg, `${c.lab}/xdg`]] as const) {
    for (const [relative, content] of Object.entries(tree)) {
      if (relative.endsWith('/')) directories.push(`${root}/${relative.replace(/\/$/, '')}`);
      else extra[`${root}/${relative}`] = withTokens(content, c);
    }
  }
  const fs = seededFileSystem({ id: c.id, casedir: c.casedir, text: c.text, files: c.files, rows: c.rows, cols: c.cols, steps: [] } as unknown as NanoScreenCase, extra);
  for (const directory of directories) {
    for (let slash = directory.indexOf('/', 1); slash > 0; slash = directory.indexOf('/', slash + 1)) fs.makeDirectory(directory.slice(0, slash), DEFAULT_DIRECTORY_MODE);
    fs.makeDirectory(directory, DEFAULT_DIRECTORY_MODE);
  }
  for (const [name, value] of Object.entries(c.env)) fs.useEnvironmentVariable(name, withTokens(value, c));
  return fs;
}

function treeOf(fs: InMemoryEditorFsContext, root: string, mountPoint: string): Record<string, RecordedEntry> {
  const entries: Record<string, RecordedEntry> = {};
  for (const directory of fs.directoryPaths()) {
    if (directory.startsWith(`${root}/`)) entries[`${mountPoint}${directory.slice(root.length)}/`] = { mode: fs.modeOf(directory) ?? DEFAULT_DIRECTORY_MODE };
  }
  for (const file of fs.fileNames()) {
    if (file.startsWith(`${root}/`)) entries[`${mountPoint}${file.slice(root.length)}`] = { mode: fs.modeOf(file) ?? DEFAULT_FILE_MODE, content: fs.readFile(file) ?? '' };
  }
  return entries;
}

function compareTree(label: string, want: Record<string, RecordedEntry>, got: Record<string, RecordedEntry>): string {
  const failures: string[] = [];
  for (const name of new Set([...Object.keys(want), ...Object.keys(got)])) {
    const expected = want[name];
    const actual = got[name];
    if (expected === undefined) failures.push(`\n  ${label} has unexpected ${name} ${JSON.stringify(actual)}`);
    else if (actual === undefined) failures.push(`\n  ${label} lacks ${name} ${JSON.stringify(expected)}`);
    else if (expected.mode !== actual.mode || expected.content !== actual.content) {
      failures.push(`\n  ${label} ${name}\n    want ${expected.mode.toString(8)} ${JSON.stringify(expected.content)}\n    got  ${actual.mode.toString(8)} ${JSON.stringify(actual.content)}`);
    }
  }
  return failures.join('');
}

function withRealPaths(disk: RecordedDisk, casedir: string): RecordedDisk {
  const spelled = casedir.replaceAll('/', '!');
  return Object.fromEntries(Object.entries(disk).map(([name, entry]) => [name.replace('!tmp', spelled), entry]));
}

function noticeRows(notice: string, width: number, height: number): string[] {
  const lines = notice === '' ? [] : notice.replace(/\n$/, '').split('\n');
  const rows = lines.flatMap((line) => (line.length <= width ? [line] : (line.match(new RegExp(`.{1,${width}}`, 'g')) ?? [line]))).map((row) => row.trimEnd());
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop();
  return rows.length > height - 1 ? rows.slice(rows.length - (height - 1)) : rows;
}

function wantedNoticeRows(rows: string[] | undefined): string[] {
  const kept = [...(rows ?? [])];
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept;
}

export function replayNanoStateCase(c: NanoStateCase): string | null {
  const fs = seededState(c);
  const ignored = [`${HOME}/`, `${c.lab}/xdg/`, '/etc/nanorc', '/usr/share/nano/'];
  for (let index = 0; index < c.runs.length; index++) {
    const run = c.runs[index];
    const label = `${c.id} run ${index} ${c.rows}x${c.cols} ${JSON.stringify(run.args)}`;
    const invocation = parseNanoCommandLine(run.args.map((argument) => withTokens(argument, c)));
    if (invocation.kind !== 'open') return `${label} did not open an editor: ${JSON.stringify(invocation)}`;
    const first = invocation.files[0];
    const name = first?.path ?? '';
    const parsed: EditorLaunch = { editor: 'nano', filePath: name, nano: { settings: invocation.settings, start: first?.start ?? null, memory: invocation.memory, rc: null } };
    const launch = c.rc ? withRcfiles(fs, parsed) : parsed;
    const failure = editorLaunchFailure(fs, launch);
    if (failure !== null) {
      const shown = run.opened.rows.filter((row) => row.trim() !== '').join('');
      if (shown !== failure) return `${label} refused to open\n  want ${JSON.stringify(shown)}\n  got  ${JSON.stringify(failure)}`;
      continue;
    }
    const absolute = launchedFilePath(fs, launch);
    const content = absolute === '' ? null : fs.readFile(absolute);
    const engine = new NanoEngine(fs, absolute, content ?? '', content === null, false, undefined, false, {
      settings: launch.nano!.settings, start: first?.start ?? null, displayName: name, rc: launch.nano!.rc, menuFlags: launch.nano!.menuFlags,
    });
    engine.resize(c.rows, c.cols);
    const opened = compareNanoScreen(engine, fs, run.opened, true, c.casedir, ignored, c.legend ?? null);
    if (opened) return `${label} opened${opened}`;
    for (let s = 0; s < run.after.length; s++) {
      applyNanoStep(engine, run.steps[s]);
      const failure = compareNanoScreen(engine, fs, run.after[s], true, c.casedir, ignored, c.legend ?? null);
      if (failure) return `${label} step ${s} ${JSON.stringify(run.steps.slice(0, s + 1))}${failure}`;
    }
    if (run.exit_step !== undefined) {
      applyNanoStep(engine, run.exit_step);
      if (!engine.exited) return `${label} ${JSON.stringify(run.exit_step)} should have made nano exit`;
      const wantRows = wantedNoticeRows(run.exit_rows);
      const gotRows = noticeRows(engine.exitNotice, c.cols, c.rows);
      if (JSON.stringify(wantRows) !== JSON.stringify(gotRows)) return `${label} exit notice\n  want ${JSON.stringify(wantRows)}\n  got  ${JSON.stringify(gotRows)}`;
      const disk = run.exit_disk === undefined ? null : compareDisk(fs, withRealPaths(run.exit_disk, c.casedir), true, c.casedir, ignored);
      if (disk !== null) return `${label} after exit${disk}`;
    } else if (engine.exited) return `${label} exited although nano kept running after ${JSON.stringify(run.steps)}`;
    const homeFailure = compareTree('home', run.home, treeOf(fs, HOME, HOME));
    const xdgFailure = run.xdg === undefined ? '' : compareTree('xdg', run.xdg, treeOf(fs, `${c.lab}/xdg`, `${c.lab}/xdg`));
    if (homeFailure + xdgFailure !== '') return `${label} state files after ${JSON.stringify(run.steps)}${homeFailure}${xdgFailure}`;
  }
  return null;
}
