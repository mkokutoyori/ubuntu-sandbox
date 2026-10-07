import { simulationDate } from '@/network/core/SystemClock';
import { ZonedDate } from '@/network/core/time/ZonedDate';
import { formatDotNetDate } from '@/powershell/runtime/dotnetDateFormat';

import type { WinFileCommandContext } from './WinFileCommands';
import { hasWildcard, joinPath, nameMatcher, splitFileSpec } from './WinPathSpec';
import {
  isDefaultVisible, parseDirAttributeSpec, selectionAccepts,
  type AttributeSelection,
} from './fileAttributes';

type SortKey = 'name' | 'extension' | 'group' | 'size' | 'date';

interface SortTerm {
  readonly key: SortKey;
  readonly descending: boolean;
}

type TimeField = 'written' | 'created';

interface DirOptions {
  wide: boolean;
  columnMajor: boolean;
  recursive: boolean;
  bare: boolean;
  lowercase: boolean;
  thousands: boolean;
  selection: AttributeSelection | null;
  sort: SortTerm[];
  timeField: TimeField;
  zone?: string;
}

interface Row {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly written: Date;
  readonly created: Date;
  readonly attributes: ReadonlySet<string>;
}

interface Block {
  readonly path: string;
  readonly rows: Row[];
}

interface Target {
  readonly directory: string;
  readonly pattern: string | null;
}

const NO_ATTRIBUTES: ReadonlySet<string> = new Set();
const ORDER_LETTERS: Record<string, SortKey> = {
  n: 'name', e: 'extension', g: 'group', s: 'size', d: 'date',
};
const DEFAULT_ORDER: SortTerm[] = [
  { key: 'group', descending: false },
  { key: 'name', descending: false },
];
const DIRECTORY_MARKER = '    <DIR>          ';
const SIZE_FIELD_WIDTH = 18;
const WIDE_COLUMNS = 4;
const WIDE_COLUMN_WIDTH = 20;

const LETTER_FLAGS: Record<string, (options: DirOptions) => void> = {
  w: options => { options.wide = true; },
  d: options => { options.wide = true; options.columnMajor = true; },
  s: options => { options.recursive = true; },
  b: options => { options.bare = true; },
  l: options => { options.lowercase = true; },
  c: options => { options.thousands = true; },
  p: () => undefined,
  n: () => undefined,
  q: () => undefined,
  x: () => undefined,
  '4': () => undefined,
};

export function volumeHeading(ctx: WinFileCommandContext, letter: string): string {
  const label = ctx.fs.getVolumeLabel(letter);
  return label
    ? ` Volume in drive ${letter} is ${label}`
    : ` Volume in drive ${letter} has no label.`;
}

export function groupDigits(value: number, thousands = true): string {
  return thousands ? value.toLocaleString('en-US') : String(value);
}

export function fileSummaryLine(count: number, bytes: number, thousands = true): string {
  return `${String(count).padStart(16)} File(s) ${groupDigits(bytes, thousands).padStart(14)} bytes`;
}

export function dirSummaryLine(count: number, freeBytes: number, thousands = true): string {
  return `${String(count).padStart(16)} Dir(s) ${groupDigits(freeBytes, thousands).padStart(15)} bytes free`;
}

const invalidSwitch = (text: string): string => `Invalid switch - "${text}".`;

function parseOrder(spec: string): SortTerm[] | null {
  if (spec === '') return DEFAULT_ORDER;
  const terms: SortTerm[] = [];
  let descending = false;
  for (const letter of spec) {
    if (letter === '-') { descending = true; continue; }
    const key = ORDER_LETTERS[letter];
    if (key === undefined) return null;
    terms.push({ key, descending });
    descending = false;
  }
  return terms;
}

function applySwitch(options: DirOptions, text: string): string | null {
  const lower = text.toLowerCase();
  const head = lower[0] ?? '';
  const rest = lower.slice(1);
  const argument = rest.replace(/^:/, '');

  if (lower === '-c') { options.thousands = false; return null; }
  if (head === 'a') {
    if (argument === '') { options.selection = { required: [], forbidden: [] }; return null; }
    const selection = parseDirAttributeSpec(argument);
    if (selection === null) return invalidSwitch(text);
    options.selection = selection;
    return null;
  }
  if (head === 'o') {
    const terms = parseOrder(argument);
    if (terms === null) return invalidSwitch(text);
    options.sort = terms;
    return null;
  }
  if (head === 't') {
    if (argument === 'c') options.timeField = 'created';
    else if (argument === 'w' || argument === 'a') options.timeField = 'written';
    else return invalidSwitch(text);
    return null;
  }
  const flag = rest === '' ? LETTER_FLAGS[head] : undefined;
  if (flag === undefined) return invalidSwitch(text);
  flag(options);
  return null;
}

function parseArguments(args: readonly string[]): { options: DirOptions; positionals: string[] } | string {
  const options: DirOptions = {
    wide: false, columnMajor: false, recursive: false, bare: false, lowercase: false,
    thousands: true, selection: null, sort: [], timeField: 'written',
  };
  const positionals: string[] = [];
  const switches: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith('/')) { positionals.push(arg); continue; }
    switches.push(...arg.slice(1).split('/'));
  }
  if (switches.includes('?')) return dirHelp();
  for (const text of switches) {
    const refusal = applySwitch(options, text);
    if (refusal !== null) return refusal;
  }
  return { options, positionals };
}

const isVolumeRoot = (path: string): boolean => /^[A-Za-z]:\\?$/.test(path);

function resolveTarget(ctx: WinFileCommandContext, positionals: readonly string[]): Target | null {
  const spec = positionals[0];
  if (spec === undefined) return { directory: ctx.cwd, pattern: null };

  const second = positionals[1];
  if (second !== undefined && hasWildcard(second) && !hasWildcard(spec)) {
    const directory = ctx.fs.normalizePath(spec, ctx.cwd);
    return ctx.fs.isDirectory(directory) ? { directory, pattern: second } : null;
  }

  return splitFileSpec(ctx.fs, ctx.cwd, spec);
}

function dotRows(ctx: WinFileCommandContext, directory: string): Row[] {
  const own = ctx.fs.resolve(directory);
  const parentPath = directory.slice(0, directory.lastIndexOf('\\'));
  const parent = ctx.fs.resolve(isVolumeRoot(parentPath) ? `${parentPath.slice(0, 2)}\\` : parentPath) ?? own;
  const now = simulationDate();
  return [
    { name: '.', isDirectory: true, size: 0, written: own?.mtime ?? now, created: own?.ctime ?? now, attributes: NO_ATTRIBUTES },
    { name: '..', isDirectory: true, size: 0, written: parent?.mtime ?? now, created: parent?.ctime ?? now, attributes: NO_ATTRIBUTES },
  ];
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function timeOf(row: Row, field: TimeField): number {
  return (field === 'created' ? row.created : row.written).getTime();
}

function compareBy(key: SortKey, a: Row, b: Row, field: TimeField): number {
  switch (key) {
    case 'name': return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    case 'extension': return extensionOf(a.name).localeCompare(extensionOf(b.name));
    case 'group': return Number(!a.isDirectory) - Number(!b.isDirectory);
    case 'size': return a.size - b.size;
    case 'date': return timeOf(a, field) - timeOf(b, field);
  }
}

function ordered(rows: Row[], options: DirOptions): Row[] {
  if (options.sort.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const { key, descending } of options.sort) {
      const difference = compareBy(key, a, b, options.timeField);
      if (difference !== 0) return descending ? -difference : difference;
    }
    return 0;
  });
}

function accepts(row: Row, selection: AttributeSelection | null): boolean {
  return selection === null
    ? isDefaultVisible(row.attributes)
    : selectionAccepts(selection, row.attributes, row.isDirectory);
}

function collect(ctx: WinFileCommandContext, target: Target, options: DirOptions): Block[] {
  const matches = nameMatcher(target.pattern);
  const blocks: Block[] = [];
  const walk = (directory: string): void => {
    const listing = ctx.fs.listDirectory(directory);
    const candidates: Row[] = options.bare || isVolumeRoot(directory) ? [] : dotRows(ctx, directory);
    for (const { name, entry } of listing) {
      candidates.push({
        name, isDirectory: entry.type === 'directory', size: entry.size,
        written: entry.mtime, created: entry.ctime, attributes: entry.attributes,
      });
    }
    const rows = candidates.filter(row => matches(row.name) && accepts(row, options.selection));
    if (rows.length > 0) blocks.push({ path: directory, rows: ordered(rows, options) });
    if (!options.recursive) return;
    for (const { name, entry } of listing) {
      if (entry.type !== 'directory') continue;
      if (options.selection === null && !isDefaultVisible(entry.attributes)) continue;
      walk(joinPath(directory, name));
    }
  };
  walk(target.directory);
  return blocks;
}

export function fileDateTime(d: Date, zone?: string): string {
  return formatDotNetDate(ZonedDate.in(d.getTime(), zone), 'MM/dd/yyyy  hh:mm tt');
}

const shown = (text: string, options: DirOptions): string => (options.lowercase ? text.toLowerCase() : text);

function rowLine(row: Row, options: DirOptions): string {
  const date = fileDateTime(options.timeField === 'created' ? row.created : row.written, options.zone);
  const name = shown(row.name, options);
  return row.isDirectory
    ? `${date}${DIRECTORY_MARKER}${name}`
    : `${date}${groupDigits(row.size, options.thousands).padStart(SIZE_FIELD_WIDTH)} ${name}`;
}

function wideLines(rows: readonly Row[], options: DirOptions): string[] {
  const cells = rows.map(row => {
    const name = shown(row.name, options);
    return row.isDirectory ? `[${name}]` : name;
  });
  const height = Math.ceil(cells.length / WIDE_COLUMNS);
  const lines: string[] = [];
  for (let line = 0; line < height; line++) {
    const picked: string[] = [];
    for (let column = 0; column < WIDE_COLUMNS; column++) {
      const index = options.columnMajor ? column * height + line : line * WIDE_COLUMNS + column;
      if (index < cells.length) picked.push(cells[index].padEnd(WIDE_COLUMN_WIDTH));
    }
    lines.push(picked.join('').trimEnd());
  }
  return lines;
}

function tally(rows: readonly Row[]): { files: number; bytes: number; directories: number } {
  let files = 0;
  let bytes = 0;
  let directories = 0;
  for (const row of rows) {
    if (row.isDirectory) directories++;
    else { files++; bytes += row.size; }
  }
  return { files, bytes, directories };
}

function renderBare(blocks: readonly Block[], options: DirOptions): string {
  const lines: string[] = [];
  for (const block of blocks) {
    for (const row of block.rows) {
      lines.push(shown(options.recursive ? joinPath(block.path, row.name) : row.name, options));
    }
  }
  return lines.join('\n');
}

function renderFull(ctx: WinFileCommandContext, blocks: readonly Block[], start: string, options: DirOptions): string {
  const drive = start[0];
  const free = ctx.fs.getFreeDiskSpace(drive);
  const lines: string[] = [
    volumeHeading(ctx, drive),
    ` Volume Serial Number is ${ctx.fs.getVolumeSerialNumber(drive)}`,
    '',
  ];
  let totalFiles = 0;
  let totalBytes = 0;
  let totalDirectories = 0;
  for (const block of blocks) {
    const { files, bytes, directories } = tally(block.rows);
    lines.push(` Directory of ${block.path}`, '');
    if (options.wide) lines.push(...wideLines(block.rows, options));
    else lines.push(...block.rows.map(row => rowLine(row, options)));
    lines.push(fileSummaryLine(files, bytes, options.thousands));
    if (options.recursive) lines.push('');
    else lines.push(dirSummaryLine(directories, free, options.thousands));
    totalFiles += files;
    totalBytes += bytes;
    totalDirectories += directories;
  }
  if (options.recursive) {
    lines.push(
      '     Total Files Listed:',
      fileSummaryLine(totalFiles, totalBytes, options.thousands),
      dirSummaryLine(totalDirectories, free, options.thousands),
    );
  }
  return lines.join('\n');
}

export function cmdDir(ctx: WinFileCommandContext, args: string[]): string {
  const parsed = parseArguments(args);
  if (typeof parsed === 'string') return parsed;
  const { options, positionals } = parsed;
  options.zone = ctx.timezone;

  const target = resolveTarget(ctx, positionals);
  if (target === null) return 'File Not Found';

  const blocks = collect(ctx, target, options);
  if (blocks.length === 0) {
    const emptyRoot = target.pattern === null && !options.recursive && isVolumeRoot(target.directory)
      && options.selection === null;
    if (!emptyRoot) return 'File Not Found';
    blocks.push({ path: target.directory, rows: [] });
  }

  return options.bare
    ? renderBare(blocks, options)
    : renderFull(ctx, blocks, target.directory, options);
}

function dirHelp(): string {
  return [
    'Displays a list of files and subdirectories in a directory.',
    '',
    'DIR [drive:][path][filename] [/A[[:]attributes]] [/B] [/C] [/D] [/L] [/N]',
    '  [/O[[:]sortorder]] [/P] [/Q] [/S] [/T[[:]timefield]] [/W] [/X] [/4]',
    '',
    '  [drive:][path][filename]',
    '              Specifies drive, directory, and/or files to list.',
    '',
    '  /A          Displays files with specified attributes.',
    '  attributes   D  Directories                R  Read-only files',
    '               H  Hidden files               A  Files ready for archiving',
    '               S  System files               I  Not content indexed files',
    '               L  Reparse Points             O  Offline files',
    '               -  Prefix meaning not',
    '  /B          Uses bare format (no heading information or summary).',
    '  /C          Display the thousand separator in file sizes.  This is the',
    '              default.  Use /-C to disable display of separator.',
    '  /D          Same as wide but files are list sorted by column.',
    '  /L          Uses lowercase.',
    '  /N          New long list format where filenames are on the far right.',
    '  /O          List by files in sorted order.',
    '  sortorder    N  By name (alphabetic)       S  By size (smallest first)',
    '               E  By extension (alphabetic)  D  By date/time (oldest first)',
    '               G  Group directories first    -  Prefix to reverse order',
    '  /P          Pauses after each screenful of information.',
    '  /Q          Display the owner of the file.',
    '  /S          Displays files in specified directory and all subdirectories.',
    '  /T          Controls which time field displayed or used for sorting',
    '  timefield   C  Creation',
    '              A  Last Access',
    '              W  Last Written',
    '  /W          Uses wide list format.',
    '  /X          This displays the short names generated for non-8dot3 file',
    '              names.',
    '  /4          Displays four-digit years',
  ].join('\n');
}
