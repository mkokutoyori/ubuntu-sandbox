import type { WinFileCommandContext } from './WinFileCommands';
import type { WinDirEntry, WinFSEntry } from './WindowsFileSystem';
import { longDateTime, slashedTimestamp } from './WinSystemCommands';
import { hasWildcard, joinPath, nameMatcher } from './WinPathSpec';

const BANNER_RULE = '-'.repeat(79);
const SECTION_RULE = '-'.repeat(78);
const TITLE = '   ROBOCOPY     ::     Robust File Copy for Windows'.padEnd(79);
const DEFAULT_RETRIES = 1_000_000;
const DEFAULT_WAIT = 30;
const RETRY_CAP = 3;
const MEBIBYTE = 1_048_576;
const GIBIBYTE = 1_073_741_824;

const EXIT_COPIED = 1;
const EXIT_EXTRA = 2;
const EXIT_MISMATCH = 4;
const EXIT_FAILED = 8;
const EXIT_FATAL = 16;

const ECHO_ORDER = [
  '/L', '/S', '/E', '/LEV', '/DCOPY', '/COPY', '/PURGE', '/MIR', '/MOV', '/MOVE', '/IS', '/IT',
  '/XO', '/XN', '/XC', '/XL', '/MAX', '/MIN', '/MAXAGE', '/MINAGE', '/A', '/M', '/A+', '/A-',
  '/CREATE', '/FFT', '/DST', '/Z', '/B', '/ZB', '/J', '/MT', '/NOOFFLOAD', '/V', '/X', '/TS',
  '/FP', '/BYTES', '/NS', '/NC', '/NFL', '/NDL', '/NP', '/ETA', '/TEE', '/LOG', '/R', '/W',
];

const PASSIVE_SWITCHES: ReadonlySet<string> = new Set(['Z', 'B', 'ZB', 'J', 'DST', 'NOOFFLOAD', 'ETA', '256', 'COMPRESS', 'EFSRAW']);

const USAGE = [
  '             Simple Usage :: ROBOCOPY source destination /MIR',
  '',
  '                  source :: Source Directory (drive:\\path or \\\\server\\share\\path).',
  '             destination :: Destination Dir  (drive:\\path or \\\\server\\share\\path).',
  '                    /MIR :: Mirror a complete directory tree.',
  '',
  '    For more usage information run ROBOCOPY /?',
  '',
  '',
  '****  /MIR can DELETE files as well as copy them !',
];

const HELP = [
  '             Usage :: ROBOCOPY source destination [file [file]...] [options]',
  '',
  '             source :: Source Directory (drive:\\path or \\\\server\\share\\path).',
  '        destination :: Destination Dir  (drive:\\path or \\\\server\\share\\path).',
  '               file :: File(s) to copy  (names/wildcards: default is "*.*").',
  '',
  '::',
  ':: Copy options :',
  '::',
  '                 /S :: copy Subdirectories, but not empty ones.',
  '                 /E :: copy subdirectories, including Empty ones.',
  '             /LEV:n :: only copy the top n LEVels of the source directory tree.',
  '       /COPY:copyflag[s] :: what to COPY for files (default is /COPY:DAT).',
  '                          (copyflags : D=Data, A=Attributes, T=Timestamps).',
  '                          (S=Security=NTFS ACLs, O=Owner info, U=aUditing info).',
  '                /SEC :: copy files with SECurity (equivalent to /COPY:DATS).',
  '            /COPYALL :: COPY ALL file info (equivalent to /COPY:DATSOU).',
  '              /PURGE :: delete dest files/dirs that no longer exist in source.',
  '                /MIR :: MIRror a directory tree (equivalent to /E plus /PURGE).',
  '                /MOV :: MOVe files (delete from source after copying).',
  '               /MOVE :: MOVE files AND dirs (delete from source after copying).',
  '          /A+:[RASH] :: add the given Attributes to copied files.',
  '          /A-:[RASH] :: remove the given Attributes from copied files.',
  '             /CREATE :: CREATE directory tree and zero-length files only.',
  '           /R:n :: number of Retries on failed copies: default 1 million.',
  '           /W:n :: Wait time between retries: default is 30 seconds.',
  '',
  '::',
  ':: File Selection Options :',
  '::',
  '                 /A :: copy only files with the Archive attribute set.',
  '                 /M :: copy only files with the Archive attribute and reset it.',
  '    /XF file [file]... :: eXclude Files matching given names/paths/wildcards.',
  '    /XD dir [dir]... :: eXclude Directories matching given names/paths.',
  '                /XC :: eXclude Changed files.',
  '                /XN :: eXclude Newer files.',
  '                /XO :: eXclude Older files.',
  '                /XL :: eXclude Lonely files and directories.',
  '                /IS :: Include Same files.',
  '                /IT :: Include Tweaked files.',
  '            /MAX:n :: MAXimum file size - exclude files bigger than n bytes.',
  '            /MIN:n :: MINimum file size - exclude files smaller than n bytes.',
  '         /MAXAGE:n :: MAXimum file AGE - exclude files older than n days/date.',
  '         /MINAGE:n :: MINimum file AGE - exclude files newer than n days/date.',
  '               /FFT :: assume FAT File Times (2-second granularity).',
  '',
  '::',
  ':: Logging Options :',
  '::',
  '                 /L :: List only - don\'t copy, timestamp or delete any files.',
  '                 /V :: produce Verbose output, showing skipped files.',
  '                /TS :: include Source file Time Stamps in the output.',
  '                /FP :: include Full Pathname of files in the output.',
  '            /BYTES :: Print sizes as bytes.',
  '                /NS :: No Size - don\'t log file sizes.',
  '                /NC :: No Class - don\'t log file classes.',
  '               /NFL :: No File List - don\'t log file names.',
  '               /NDL :: No Directory List - don\'t log directory names.',
  '                /NP :: No Progress - don\'t display percentage copied.',
  '          /LOG:file :: output status to LOG file (overwrite existing log).',
  '         /LOG+:file :: output status to LOG file (append to existing log).',
  '               /TEE :: output to console window, as well as the log file.',
  '               /NJH :: No Job Header.',
  '               /NJS :: No Job Summary.',
];

interface RobocopyOptions {
  subdirectories: boolean;
  emptyDirectories: boolean;
  depth: number | null;
  purge: boolean;
  moveFiles: boolean;
  moveDirectories: boolean;
  excludeFiles: string[];
  excludeDirectories: string[];
  excludeOlder: boolean;
  excludeNewer: boolean;
  excludeChanged: boolean;
  excludeLonely: boolean;
  includeSame: boolean;
  includeTweaked: boolean;
  listOnly: boolean;
  verbose: boolean;
  timestamps: boolean;
  fullPath: boolean;
  bytes: boolean;
  noSize: boolean;
  noClass: boolean;
  noFileList: boolean;
  noDirList: boolean;
  noProgress: boolean;
  noHeader: boolean;
  noSummary: boolean;
  tee: boolean;
  log: { path: string; append: boolean } | null;
  copyFlags: string;
  maxSize: number | null;
  minSize: number | null;
  maxAge: number | null;
  minAge: number | null;
  archiveOnly: boolean;
  archiveReset: boolean;
  addAttributes: string;
  removeAttributes: string;
  createOnly: boolean;
  fatTimes: boolean;
  retries: number;
  wait: number;
}

type Parsed =
  | { kind: 'run'; options: RobocopyOptions; source: string; destination: string; patterns: string[]; echo: string }
  | { kind: 'help' }
  | { kind: 'usage' }
  | { kind: 'invalid'; index: number; token: string };

function newOptions(): RobocopyOptions {
  return {
    subdirectories: false, emptyDirectories: false, depth: null, purge: false, moveFiles: false, moveDirectories: false,
    excludeFiles: [], excludeDirectories: [], excludeOlder: false, excludeNewer: false, excludeChanged: false,
    excludeLonely: false, includeSame: false, includeTweaked: false, listOnly: false, verbose: false, timestamps: false,
    fullPath: false, bytes: false, noSize: false, noClass: false, noFileList: false, noDirList: false, noProgress: false,
    noHeader: false, noSummary: false, tee: false, log: null, copyFlags: 'DAT', maxSize: null, minSize: null,
    maxAge: null, minAge: null, archiveOnly: false, archiveReset: false, addAttributes: '', removeAttributes: '',
    createOnly: false, fatTimes: false, retries: DEFAULT_RETRIES, wait: DEFAULT_WAIT,
  };
}

const isNumber = (text: string): boolean => /^\d+$/.test(text);
const attributeLetters = (text: string): string | null => (/^[RASHCNETO]*$/i.test(text) ? text.toUpperCase() : null);

function parseArguments(args: readonly string[]): Parsed {
  if (args.length === 0) return { kind: 'usage' };
  if (args.some(argument => argument === '/?')) return { kind: 'help' };
  const options = newOptions();
  const echoes = new Map<string, string>();
  const echo = (key: string, text: string = key): void => { echoes.set(key, text); };
  const operands: string[] = [];
  const patterns: string[] = [];
  let collecting: 'files' | 'directories' | null = null;
  let copyFlags = 'DAT';
  let dcopy = 'DA';
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('/')) {
      if (collecting === 'files') options.excludeFiles.push(token);
      else if (collecting === 'directories') options.excludeDirectories.push(token);
      else if (operands.length < 2) operands.push(token);
      else patterns.push(token);
      continue;
    }
    collecting = null;
    const colon = token.indexOf(':');
    const name = (colon < 0 ? token.slice(1) : token.slice(1, colon)).toUpperCase();
    const value = colon < 0 ? null : token.slice(colon + 1);
    const invalid: Parsed = { kind: 'invalid', index: index + 1, token };
    const plain = value === null;
    switch (name) {
      case 'S': options.subdirectories = true; echo('/S'); break;
      case 'E': options.subdirectories = true; options.emptyDirectories = true; echo('/S'); echo('/E'); break;
      case 'LEV': {
        if (value === null || !isNumber(value)) return invalid;
        options.depth = Number(value);
        echo('/LEV', `/LEV:${value}`);
        break;
      }
      case 'PURGE': options.purge = true; echo('/PURGE'); break;
      case 'MIR':
        options.subdirectories = true; options.emptyDirectories = true; options.purge = true;
        echo('/S'); echo('/E'); echo('/PURGE'); echo('/MIR');
        break;
      case 'MOV': options.moveFiles = true; echo('/MOV'); break;
      case 'MOVE': options.moveFiles = true; options.moveDirectories = true; echo('/MOVE'); break;
      case 'XF': collecting = 'files'; break;
      case 'XD': collecting = 'directories'; break;
      case 'XO': options.excludeOlder = true; echo('/XO'); break;
      case 'XN': options.excludeNewer = true; echo('/XN'); break;
      case 'XC': options.excludeChanged = true; echo('/XC'); break;
      case 'XL': options.excludeLonely = true; echo('/XL'); break;
      case 'IS': options.includeSame = true; echo('/IS'); break;
      case 'IT': options.includeTweaked = true; echo('/IT'); break;
      case 'L': options.listOnly = true; echo('/L'); break;
      case 'V': options.verbose = true; echo('/V'); break;
      case 'TS': options.timestamps = true; echo('/TS'); break;
      case 'FP': options.fullPath = true; echo('/FP'); break;
      case 'BYTES': options.bytes = true; echo('/BYTES'); break;
      case 'NS': options.noSize = true; echo('/NS'); break;
      case 'NC': options.noClass = true; echo('/NC'); break;
      case 'NFL': options.noFileList = true; echo('/NFL'); break;
      case 'NDL': options.noDirList = true; echo('/NDL'); break;
      case 'NP': options.noProgress = true; echo('/NP'); break;
      case 'NJH': options.noHeader = true; break;
      case 'NJS': options.noSummary = true; break;
      case 'TEE': options.tee = true; echo('/TEE'); break;
      case 'X': echo('/X'); break;
      case 'FFT': options.fatTimes = true; echo('/FFT'); break;
      case 'CREATE': options.createOnly = true; echo('/CREATE'); break;
      case 'A': {
        if (plain) { options.archiveOnly = true; echo('/A'); break; }
        return invalid;
      }
      case 'M': options.archiveOnly = true; options.archiveReset = true; echo('/M'); break;
      case 'A+': case 'A-': {
        const letters = value === null ? null : attributeLetters(value);
        if (letters === null) return invalid;
        if (name === 'A+') options.addAttributes += letters;
        else options.removeAttributes += letters;
        echo(`/${name}`, `/${name}:${letters}`);
        break;
      }
      case 'COPY': {
        if (value === null || !/^[DATSOU]+$/i.test(value)) return invalid;
        copyFlags = value.toUpperCase();
        break;
      }
      case 'COPYALL': copyFlags = 'DATSOU'; break;
      case 'SEC': copyFlags = 'DATS'; break;
      case 'DCOPY': {
        if (value === null || !/^[DAT]+$/i.test(value)) return invalid;
        dcopy = value.toUpperCase();
        break;
      }
      case 'MAX': case 'MIN': case 'MAXAGE': case 'MINAGE': case 'R': case 'W': {
        if (value === null || !isNumber(value)) return invalid;
        const amount = Number(value);
        if (name === 'MAX') options.maxSize = amount;
        else if (name === 'MIN') options.minSize = amount;
        else if (name === 'MAXAGE') options.maxAge = amount;
        else if (name === 'MINAGE') options.minAge = amount;
        else if (name === 'R') options.retries = amount;
        else options.wait = amount;
        if (name === 'R' || name === 'W') echo(`/${name}`, `/${name}:${amount}`);
        else echo(`/${name}`, `/${name}:${value}`);
        break;
      }
      case 'LOG': case 'LOG+': case 'UNILOG': case 'UNILOG+': {
        if (value === null || value === '') return invalid;
        options.log = { path: value, append: name.endsWith('+') };
        echo('/LOG', `/${name}:${value}`);
        break;
      }
      case 'MT': echo('/MT', value === null ? '/MT' : `/MT:${value}`); break;
      default:
        if (PASSIVE_SWITCHES.has(name)) echo(`/${name}`);
        else return invalid;
    }
  }
  if (operands.length < 2) return { kind: 'usage' };
  options.copyFlags = copyFlags;
  echo('/COPY', `/COPY:${copyFlags}`);
  echo('/DCOPY', `/DCOPY:${dcopy}`);
  echo('/R', `/R:${options.retries}`);
  echo('/W', `/W:${options.wait}`);
  const ordered = ECHO_ORDER.filter(key => echoes.has(key)).map(key => echoes.get(key)!);
  const shownPatterns = patterns.length === 0 ? ['*.*'] : patterns;
  return {
    kind: 'run', options, source: operands[0], destination: operands[1], patterns: shownPatterns,
    echo: `${shownPatterns.join(' ')} ${ordered.join(' ')} `,
  };
}

interface Counter {
  total: number;
  copied: number;
  skipped: number;
  mismatch: number;
  failed: number;
  extras: number;
}

const newCounter = (): Counter => ({ total: 0, copied: 0, skipped: 0, mismatch: 0, failed: 0, extras: 0 });

type FileClass = 'new' | 'newer' | 'older' | 'changed' | 'same' | 'tweaked';

const CLASS_LABELS: Readonly<Record<FileClass | 'extra' | 'named', string>> = {
  new: '    New File  ',
  newer: '    Newer     ',
  older: '    Older     ',
  changed: '    Changed   ',
  same: '    same      ',
  tweaked: '    Tweaked   ',
  extra: '  *EXTRA File ',
  named: '    named     ',
};

interface Run {
  readonly ctx: WinFileCommandContext;
  readonly options: RobocopyOptions;
  readonly matches: (name: string) => boolean;
  readonly destinationRoot: string;
  readonly now: number;
  readonly lines: string[];
  readonly dirs: Counter;
  readonly files: Counter;
  readonly bytes: Counter;
  exit: number;
}

const withSeparator = (path: string): string => (path.endsWith('\\') ? path : `${path}\\`);

function sizeText(run: Run, size: number): string {
  if (run.options.bytes || size < MEBIBYTE) return String(size);
  if (size < GIBIBYTE) return `${(size / MEBIBYTE).toFixed(1)} m`;
  return `${(size / GIBIBYTE).toFixed(1)} g`;
}

function summarySize(run: Run, size: number): string {
  if (run.options.bytes || size < MEBIBYTE) return String(size);
  if (size < GIBIBYTE) return `${(size / MEBIBYTE).toFixed(2)} m`;
  return `${(size / GIBIBYTE).toFixed(2)} g`;
}

function fileLine(run: Run, label: string, entry: WinFSEntry, shownName: string): string {
  const { options } = run;
  const cells = [options.noClass ? '' : label];
  cells.push('');
  if (!options.noSize) cells.push(sizeText(run, entry.size).padStart(8));
  const stamp = options.timestamps ? `${slashedTimestamp(run.ctx.timezone, entry.mtime.getTime())} ` : '';
  return `\t${cells.join('\t')}\t${stamp}${shownName}`;
}

function directoryLine(label: string, count: number, path: string): string {
  return `\t${label}${String(count).padStart(20 - label.length)}\t${withSeparator(path)}`;
}

function matchesPattern(pattern: string, name: string, fullPath: string): boolean {
  const text = pattern.includes('\\') ? fullPath : name;
  return nameMatcher(pattern)(text) || (!hasWildcard(pattern) && text.toLowerCase() === pattern.toLowerCase());
}

function excludedByFilters(run: Run, name: string, path: string, entry: WinFSEntry): boolean {
  const { options } = run;
  if (options.excludeFiles.some(pattern => matchesPattern(pattern, name, path))) return true;
  if (options.maxSize !== null && entry.size > options.maxSize) return true;
  if (options.minSize !== null && entry.size < options.minSize) return true;
  const ageDays = (run.now - entry.mtime.getTime()) / 86_400_000;
  if (options.maxAge !== null && options.maxAge < 1900 && ageDays > options.maxAge) return true;
  if (options.minAge !== null && options.minAge < 1900 && ageDays < options.minAge) return true;
  if (options.archiveOnly && !entry.attributes.has('archive')) return true;
  return false;
}

function classify(run: Run, source: WinFSEntry, destination: WinFSEntry): FileClass {
  const difference = source.mtime.getTime() - destination.mtime.getTime();
  const tolerance = run.options.fatTimes ? 2000 : 0;
  if (Math.abs(difference) <= tolerance) {
    if (source.size !== destination.size) return 'changed';
    const differs = ['readonly', 'hidden', 'system'].some(
      attribute => source.attributes.has(attribute) !== destination.attributes.has(attribute));
    return differs ? 'tweaked' : 'same';
  }
  return difference > 0 ? 'newer' : 'older';
}

function wantsCopy(run: Run, fileClass: FileClass): boolean {
  const { options } = run;
  switch (fileClass) {
    case 'new': return !options.excludeLonely;
    case 'newer': return !options.excludeNewer;
    case 'older': return !options.excludeOlder;
    case 'changed': return !options.excludeChanged;
    case 'same': return options.includeSame;
    case 'tweaked': return options.includeTweaked;
  }
}

function applyCopyFlags(run: Run, source: WinFSEntry, target: string): void {
  const copy = run.ctx.fs.resolve(target);
  if (copy === null) return;
  const { options } = run;
  if (!options.copyFlags.includes('T')) copy.mtime = new Date(run.now);
  if (!options.copyFlags.includes('A')) copy.attributes = new Set(['archive']);
  const letters: Readonly<Record<string, string>> = { R: 'readonly', A: 'archive', S: 'system', H: 'hidden' };
  for (const letter of options.addAttributes) if (letters[letter] !== undefined) copy.attributes.add(letters[letter]);
  for (const letter of options.removeAttributes) if (letters[letter] !== undefined) copy.attributes.delete(letters[letter]);
  if (options.createOnly) {
    copy.content = '';
    copy.size = 0;
  }
  if (options.archiveReset) source.attributes.delete('archive');
}

function reportFailure(run: Run, verb: string, path: string): void {
  const { options } = run;
  const stamp = slashedTimestamp(run.ctx.timezone, run.now);
  const attempts = Math.min(options.retries, RETRY_CAP);
  for (let attempt = 0; attempt <= attempts; attempt++) {
    run.lines.push(`${stamp} ERROR 5 (0x00000005) ${verb} ${path}`, 'Access is denied.', '');
    if (attempt < attempts) run.lines.push(`Waiting ${options.wait} seconds... Retrying...`);
  }
  if (options.retries > 0) run.lines.push('ERROR : RETRY LIMIT EXCEEDED.', '');
}

function transfer(
  run: Run, label: string, sourcePath: string, source: WinFSEntry, destinationPath: string, name: string,
): void {
  const { options, ctx } = run;
  const shown = options.fullPath ? sourcePath : name;
  if (!options.noFileList) run.lines.push(fileLine(run, label, source, shown));
  if (options.listOnly) {
    run.files.copied++;
    run.bytes.copied += source.size;
    run.exit |= EXIT_COPIED;
    return;
  }
  const existing = ctx.fs.resolve(destinationPath);
  const security = /[SO]/.test(options.copyFlags);
  if (existing !== null && existing.attributes.has('readonly')) {
    reportFailure(run, 'Copying File', sourcePath);
    run.files.failed++;
    run.bytes.failed += source.size;
    run.exit |= EXIT_FAILED;
    return;
  }
  const result = ctx.fs.copyFile(sourcePath, destinationPath, { security });
  if (!result.ok) {
    reportFailure(run, 'Copying File', sourcePath);
    run.files.failed++;
    run.bytes.failed += source.size;
    run.exit |= EXIT_FAILED;
    return;
  }
  applyCopyFlags(run, source, destinationPath);
  if (!options.noProgress) run.lines.push('  0%  ', '100%  ');
  run.files.copied++;
  run.bytes.copied += source.size;
  run.exit |= EXIT_COPIED;
  if (options.moveFiles) ctx.fs.deleteFile(sourcePath);
}

function handleFile(run: Run, sourceDir: string, destinationDir: string, source: WinDirEntry, destination: WinDirEntry | undefined): void {
  const { options } = run;
  const sourcePath = joinPath(sourceDir, source.name);
  const destinationPath = joinPath(destinationDir, source.name);
  run.files.total++;
  run.bytes.total += source.entry.size;
  const skip = (label: string | null): void => {
    run.files.skipped++;
    run.bytes.skipped += source.entry.size;
    if (label !== null && options.verbose && !options.noFileList) run.lines.push(fileLine(run, label, source.entry, source.name));
  };
  if (excludedByFilters(run, source.name, sourcePath, source.entry)) {
    skip(CLASS_LABELS.named);
    return;
  }
  if (destination === undefined) {
    if (!wantsCopy(run, 'new')) skip(CLASS_LABELS.new);
    else transfer(run, CLASS_LABELS.new, sourcePath, source.entry, destinationPath, source.name);
    return;
  }
  if (destination.entry.type === 'directory') {
    run.files.mismatch++;
    run.bytes.mismatch += source.entry.size;
    run.exit |= EXIT_MISMATCH;
    return;
  }
  const fileClass = classify(run, source.entry, destination.entry);
  if (wantsCopy(run, fileClass)) {
    transfer(run, CLASS_LABELS[fileClass], sourcePath, source.entry, destinationPath, source.name);
    return;
  }
  run.files.skipped++;
  run.bytes.skipped += source.entry.size;
  if ((fileClass === 'same' || options.verbose) && !options.noFileList) {
    run.lines.push(fileLine(run, CLASS_LABELS[fileClass], source.entry, options.fullPath ? sourcePath : source.name));
  }
}

function handleExtraFile(run: Run, destinationDir: string, extra: WinDirEntry): void {
  const path = joinPath(destinationDir, extra.name);
  run.files.total++;
  run.files.extras++;
  run.bytes.total += extra.entry.size;
  run.bytes.extras += extra.entry.size;
  run.exit |= EXIT_EXTRA;
  if (!run.options.noFileList) {
    run.lines.push(fileLine(run, CLASS_LABELS.extra, extra.entry, run.options.fullPath ? path : extra.name));
  }
  if (run.options.purge && !run.options.listOnly) run.ctx.fs.deleteFile(path);
}

function handleExtraDirectory(run: Run, destinationDir: string, extra: WinDirEntry): void {
  const path = joinPath(destinationDir, extra.name);
  run.dirs.total++;
  run.dirs.extras++;
  run.exit |= EXIT_EXTRA;
  if (!run.options.noDirList) run.lines.push(directoryLine('*EXTRA Dir', -1, path));
  const walk = (directory: string): void => {
    for (const child of run.ctx.fs.listDirectory(directory)) {
      if (child.entry.type === 'file') handleExtraFile(run, directory, child);
      else {
        run.dirs.total++;
        run.dirs.extras++;
        if (!run.options.noDirList) run.lines.push(directoryLine('*EXTRA Dir', -1, joinPath(directory, child.name)));
        walk(joinPath(directory, child.name));
      }
    }
  };
  walk(path);
  if (run.options.purge && !run.options.listOnly) run.ctx.fs.deleteDirectory(path);
}

function containsMatchingFile(run: Run, directory: string): boolean {
  return run.ctx.fs.listDirectory(directory).some(({ name, entry }) => (
    entry.type === 'file' ? run.matches(name) : containsMatchingFile(run, joinPath(directory, name))));
}

const byName = (first: WinDirEntry, second: WinDirEntry): number =>
  first.name.toLowerCase().localeCompare(second.name.toLowerCase());

function scan(run: Run, sourceDir: string, destinationDir: string, level: number): void {
  const { ctx, options } = run;
  const sourceEntries = ctx.fs.listDirectory(sourceDir);
  const destinationExists = ctx.fs.isDirectory(destinationDir);
  const destinationEntries = destinationExists ? ctx.fs.listDirectory(destinationDir) : [];
  const sourceFiles = sourceEntries.filter(item => item.entry.type === 'file' && run.matches(item.name));

  run.dirs.total++;
  if (destinationExists) run.dirs.skipped++;
  else run.dirs.copied++;
  if (!options.noDirList) run.lines.push(directoryLine(destinationExists ? '' : '  New Dir', sourceFiles.length, sourceDir));
  if (!destinationExists && !options.listOnly) ctx.fs.mkdirp(destinationDir);

  const names = new Map<string, { source?: WinDirEntry; destination?: WinDirEntry }>();
  for (const item of sourceFiles) names.set(item.name.toLowerCase(), { source: item });
  for (const item of destinationEntries) {
    if (item.entry.type === 'file' && run.matches(item.name) || (item.entry.type === 'directory' && names.has(item.name.toLowerCase()))) {
      names.set(item.name.toLowerCase(), { ...names.get(item.name.toLowerCase()), destination: item });
    }
  }
  const ordered = [...names.values()].sort((a, b) => byName((a.source ?? a.destination)!, (b.source ?? b.destination)!));
  for (const pair of ordered) {
    if (pair.source !== undefined) handleFile(run, sourceDir, destinationDir, pair.source, pair.destination);
    else if (pair.destination !== undefined && pair.destination.entry.type === 'file') handleExtraFile(run, destinationDir, pair.destination);
  }

  const descend = options.subdirectories && (options.depth === null || level + 1 < options.depth);
  if (descend) {
    const sourceDirectories = sourceEntries.filter(item => item.entry.type === 'directory');
    const destinationDirectories = destinationEntries.filter(item => item.entry.type === 'directory');
    const known = new Set(sourceDirectories.map(item => item.name.toLowerCase()));
    const folders = [
      ...sourceDirectories.map(item => ({ item, inSource: true })),
      ...destinationDirectories.filter(item => !known.has(item.name.toLowerCase())).map(item => ({ item, inSource: false })),
    ].sort((a, b) => byName(a.item, b.item));
    for (const { item, inSource } of folders) {
      const sourceChild = joinPath(sourceDir, item.name);
      const destinationChild = joinPath(destinationDir, item.name);
      if (!inSource) {
        handleExtraDirectory(run, destinationDir, item);
        continue;
      }
      if (destinationChild.toLowerCase() === run.destinationRoot.toLowerCase()) continue;
      const blocking = ctx.fs.resolve(destinationChild);
      if (blocking !== null && blocking.type === 'file') {
        run.dirs.total++;
        run.dirs.mismatch++;
        run.exit |= EXIT_MISMATCH;
        continue;
      }
      if (options.excludeDirectories.some(pattern => matchesPattern(pattern, item.name, sourceChild))) {
        run.dirs.total++;
        run.dirs.skipped++;
        continue;
      }
      if (!options.emptyDirectories && !containsMatchingFile(run, sourceChild)) continue;
      scan(run, sourceChild, destinationChild, level + 1);
    }
  }
  if (options.moveDirectories && !options.listOnly && ctx.fs.listDirectory(sourceDir).length === 0) {
    ctx.fs.deleteDirectory(sourceDir);
  }
}

function summaryRows(run: Run): string[] {
  const cells = (counter: Counter, render: (value: number) => string): string =>
    [counter.total, counter.copied, counter.skipped, counter.mismatch, counter.failed, counter.extras]
      .map(value => render(value).padStart(10)).join('');
  const plain = (value: number): string => String(value);
  return [
    '               Total    Copied   Skipped  Mismatch    FAILED    Extras',
    `    Dirs :${cells(run.dirs, plain)}`,
    `   Files :${cells(run.files, plain)}`,
    `   Bytes :${cells(run.bytes, value => summarySize(run, value))}`,
    `   Times :   0:00:00   0:00:00${' '.repeat(20)}   0:00:00   0:00:00`,
    '',
    '',
    '   Speed :                   0 Bytes/sec.',
    '   Speed :               0.000 MegaBytes/min.',
  ];
}

function headerLines(ctx: WinFileCommandContext, started: number): string[] {
  return ['', BANNER_RULE, TITLE, BANNER_RULE, '', `  Started : ${longDateTime(ctx.timezone, started)}`];
}

function finishWithLog(ctx: WinFileCommandContext, options: RobocopyOptions, text: string, exit: number): string {
  ctx.setExitCode(exit);
  if (options.log === null) return text;
  const path = ctx.fs.normalizePath(options.log.path, ctx.cwd);
  const body = `${text}\r\n`;
  if (options.log.append && ctx.fs.exists(path)) ctx.fs.appendFile(path, body);
  else ctx.fs.createFile(path, body);
  return options.tee ? text : '';
}

export function cmdRobocopy(ctx: WinFileCommandContext, args: string[]): string {
  const started = Date.now();
  const parsed = parseArguments(args);
  if (parsed.kind === 'help') {
    ctx.setExitCode(0);
    return [...headerLines(ctx, started), '', ...HELP].join('\n');
  }
  if (parsed.kind === 'usage') {
    ctx.setExitCode(EXIT_FATAL);
    return [...headerLines(ctx, started), '', ...USAGE].join('\n');
  }
  if (parsed.kind === 'invalid') {
    ctx.setExitCode(EXIT_FATAL);
    return [...headerLines(ctx, started), '', `ERROR : Invalid Parameter #${parsed.index} : "${parsed.token}"`, '', ...USAGE].join('\n');
  }

  const { options } = parsed;
  const source = ctx.fs.normalizePath(parsed.source, ctx.cwd);
  const destination = ctx.fs.normalizePath(parsed.destination, ctx.cwd);
  const lines: string[] = [];
  if (!options.noHeader) {
    lines.push(...headerLines(ctx, started));
    lines.push(`   Source : ${withSeparator(source)}`, `     Dest : ${withSeparator(destination)}`, '');
    lines.push(`    Files : ${parsed.patterns.join(' ')}`, '\t    ');
    if (options.excludeFiles.length > 0) lines.push(`Exc Files : ${options.excludeFiles.join(' ')}`);
    if (options.excludeDirectories.length > 0) lines.push(` Exc Dirs : ${options.excludeDirectories.join(' ')}`);
    if (options.excludeFiles.length > 0 || options.excludeDirectories.length > 0) lines.push('\t    ');
    lines.push(`  Options : ${parsed.echo}`, '', SECTION_RULE, '');
  }

  if (!ctx.fs.isDirectory(source)) {
    const missing = ctx.fs.exists(source);
    lines.push(
      `${slashedTimestamp(ctx.timezone, started)} ERROR ${missing ? '267 (0x0000010B)' : '3 (0x00000003)'} Accessing Source Directory ${withSeparator(source)}`,
      missing ? 'The directory name is invalid.' : 'The system cannot find the path specified.',
    );
    return finishWithLog(ctx, options, lines.join('\n'), EXIT_FATAL);
  }

  const matchers = parsed.patterns.map(pattern => nameMatcher(pattern));
  const run: Run = {
    ctx, options, matches: name => matchers.some(matches => matches(name)), destinationRoot: destination,
    now: started, lines, dirs: newCounter(), files: newCounter(), bytes: newCounter(), exit: 0,
  };
  scan(run, source, destination, 0);

  if (!options.noSummary) {
    lines.push('', SECTION_RULE, '', ...summaryRows(run), `   Ended : ${longDateTime(ctx.timezone, Date.now())}`);
  }
  return finishWithLog(ctx, options, lines.join('\n'), run.exit);
}
