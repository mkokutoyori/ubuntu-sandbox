import { END_OF_OPTIONS, GnuGetopt, type LongOption } from '../audit/tools/GnuGetopt';
import { ExitSignal, ToolOutput, type ToolResult } from '../audit/tools/AuditToolHost';
import { fnmatch } from '../fs/Glob';
import { type SystemdClock, formatTimespan, formatTimestamp, parseSec, parseTimestamp, systemdClock } from '../systemd/SystemdTime';
import { isGlob, unitNameMangle } from '../systemd/UnitName';
import { type CatalogItem, type CatalogLocale, catalogForRecord, dumpCatalogEntry, findCatalogText, formatCatalogBlock, listCatalog } from './Catalog';
import { JournalMatches } from './JournalMatches';
import {
  type DisplayState, type JsonValue, type OutputFlags, type OutputMode, OUTPUT_MODES, dumpJson, isJsonMode, jsonString, showJournalEntry,
} from './JournalOutput';
import { type JournalCursor, type JournalRecord, cursorOf, parseCursor, parseId128 } from './JournalRecord';
import { formatBytes, text, utf8 } from './JournalText';

export const JOURNALCTL_VERSION = 'systemd 255 (255.4-1ubuntu8.14)';
const FEATURES = '+PAM +AUDIT +SELINUX +APPARMOR +IMA +SMACK +SECCOMP +GCRYPT -GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN +IPTC +KMOD +LIBCRYPTSETUP +LIBFDISK +PCRE2 -PWQUALITY +P11KIT +QRENCODE +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD -BPF_FRAMEWORK -XKBCOMMON +UTMP +SYSVINIT default-hierarchy=unified';

export type PathStat =
  | { errno: string }
  | { kind: 'regular'; executable: boolean; interpreter: string | null; interpreterIsLink: boolean; name: string }
  | { kind: 'device'; matches: string[] }
  | { kind: 'other' };

export interface JournalFileInfo {
  path: string;
  fileId: string;
  machineId: string;
  bootId: string;
  seqnumId: string;
  state: 'OFFLINE' | 'ONLINE' | 'ARCHIVED' | 'UNKNOWN';
  compatibleFlags: string[];
  incompatibleFlags: string[];
  headerSize: number;
  arenaSize: number;
  dataHashTableSize: number;
  fieldHashTableSize: number;
  rotateSuggested: boolean;
  headSeqnum: number;
  tailSeqnum: number;
  headRealtime: number;
  tailRealtime: number;
  tailMonotonic: number;
  objects: number;
  entries: number;
  data: number;
  fields: number;
  tags: number;
  entryArrays: number;
  fieldHashChainDepth: number;
  dataHashChainDepth: number;
  diskUsageBytes: number;
}

export type VarlinkOutcome = { ok: true } | { connectErrno: string } | { error: string };

export interface VacuumSpec {
  size: number;
  files: number;
  time: number;
}

export interface VacuumResult {
  directory: string;
  deleted: Array<{ name: string; bytes: number }>;
  freedBytes: number;
}

export interface JournalctlHost {
  files(): JournalFileInfo[];
  varlink(method: string, namespace: string | null): VarlinkOutcome;
  vacuum(spec: VacuumSpec): VacuumResult[];
  flushed(): boolean;
  newId128(): string;
  records(): readonly JournalRecord[];
  journalDirectory(): string;
  hasJournalFiles(): boolean;
  nowUsec(): number;
  zoneName(): string;
  uid(): number;
  canReadJournal(): boolean;
  currentBootId(): string;
  columns(): number;
  hasPersistentStorage(): boolean;
  statPath(path: string): PathStat;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): string | null;
  catalog(): CatalogItem[] | null;
  locale(): CatalogLocale;
  updateCatalog(): string | null;
  diskUsageBytes(): number;
}

const ERRNO_TEXT: Record<string, string> = {
  EINVAL: 'Invalid argument', ENOENT: 'No such file or directory', ENODATA: 'No data available', EACCES: 'Permission denied', ERANGE: 'Numerical result out of range',
  ENOTDIR: 'Not a directory', EPERM: 'Operation not permitted',
};

const LOG_LEVELS = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const FACILITY_NAMES = ['kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp', 'cron', 'authpriv', 'ftp', '12', '13', '14', '15', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'];
const ARG_LINES_DEFAULT = -2;
const ARG_LINES_ALL = -1;

const OPTIONS: readonly LongOption[] = [
  { name: 'help', hasArg: 0, val: 'h'.charCodeAt(0) }, { name: 'version', hasArg: 0, val: 0x100 }, { name: 'no-pager', hasArg: 0, val: 0x101 },
  { name: 'pager-end', hasArg: 0, val: 'e'.charCodeAt(0) }, { name: 'follow', hasArg: 0, val: 'f'.charCodeAt(0) }, { name: 'force', hasArg: 0, val: 0x10d },
  { name: 'output', hasArg: 1, val: 'o'.charCodeAt(0) }, { name: 'all', hasArg: 0, val: 'a'.charCodeAt(0) }, { name: 'full', hasArg: 0, val: 'l'.charCodeAt(0) },
  { name: 'no-full', hasArg: 0, val: 0x102 }, { name: 'lines', hasArg: 2, val: 'n'.charCodeAt(0) }, { name: 'truncate-newline', hasArg: 0, val: 0x120 },
  { name: 'no-tail', hasArg: 0, val: 0x103 }, { name: 'new-id128', hasArg: 0, val: 0x104 }, { name: 'quiet', hasArg: 0, val: 'q'.charCodeAt(0) },
  { name: 'merge', hasArg: 0, val: 'm'.charCodeAt(0) }, { name: 'this-boot', hasArg: 0, val: 0x105 }, { name: 'boot', hasArg: 2, val: 'b'.charCodeAt(0) },
  { name: 'list-boots', hasArg: 0, val: 0x106 }, { name: 'dmesg', hasArg: 0, val: 'k'.charCodeAt(0) }, { name: 'system', hasArg: 0, val: 0x108 },
  { name: 'user', hasArg: 0, val: 0x107 }, { name: 'directory', hasArg: 1, val: 'D'.charCodeAt(0) }, { name: 'file', hasArg: 1, val: 0x110 },
  { name: 'root', hasArg: 1, val: 0x109 }, { name: 'image', hasArg: 1, val: 0x10a }, { name: 'image-policy', hasArg: 1, val: 0x10b },
  { name: 'header', hasArg: 0, val: 0x10c }, { name: 'identifier', hasArg: 1, val: 't'.charCodeAt(0) }, { name: 'priority', hasArg: 1, val: 'p'.charCodeAt(0) },
  { name: 'facility', hasArg: 1, val: 0x10e }, { name: 'grep', hasArg: 1, val: 'g'.charCodeAt(0) }, { name: 'case-sensitive', hasArg: 2, val: 0x111 },
  { name: 'setup-keys', hasArg: 0, val: 0x112 }, { name: 'interval', hasArg: 1, val: 0x113 }, { name: 'verify', hasArg: 0, val: 0x114 },
  { name: 'verify-key', hasArg: 1, val: 0x115 }, { name: 'disk-usage', hasArg: 0, val: 0x116 }, { name: 'cursor', hasArg: 1, val: 'c'.charCodeAt(0) },
  { name: 'cursor-file', hasArg: 1, val: 0x117 }, { name: 'after-cursor', hasArg: 1, val: 0x118 }, { name: 'show-cursor', hasArg: 0, val: 0x119 },
  { name: 'since', hasArg: 1, val: 'S'.charCodeAt(0) }, { name: 'until', hasArg: 1, val: 'U'.charCodeAt(0) }, { name: 'unit', hasArg: 1, val: 'u'.charCodeAt(0) },
  { name: 'user-unit', hasArg: 1, val: 0x11a }, { name: 'field', hasArg: 1, val: 'F'.charCodeAt(0) }, { name: 'fields', hasArg: 0, val: 'N'.charCodeAt(0) },
  { name: 'catalog', hasArg: 0, val: 'x'.charCodeAt(0) }, { name: 'list-catalog', hasArg: 0, val: 0x11b }, { name: 'dump-catalog', hasArg: 0, val: 0x11c },
  { name: 'update-catalog', hasArg: 0, val: 0x11d }, { name: 'reverse', hasArg: 0, val: 'r'.charCodeAt(0) }, { name: 'machine', hasArg: 1, val: 'M'.charCodeAt(0) },
  { name: 'utc', hasArg: 0, val: 0x11e }, { name: 'flush', hasArg: 0, val: 0x11f }, { name: 'relinquish-var', hasArg: 0, val: 0x121 },
  { name: 'smart-relinquish-var', hasArg: 0, val: 0x122 }, { name: 'sync', hasArg: 0, val: 0x123 }, { name: 'rotate', hasArg: 0, val: 0x124 },
  { name: 'vacuum-size', hasArg: 1, val: 0x125 }, { name: 'vacuum-files', hasArg: 1, val: 0x126 }, { name: 'vacuum-time', hasArg: 1, val: 0x127 },
  { name: 'no-hostname', hasArg: 0, val: 0x128 }, { name: 'output-fields', hasArg: 1, val: 0x129 }, { name: 'namespace', hasArg: 1, val: 0x12a },
];

type Action = 'show' | 'new-id128' | 'list-catalog' | 'dump-catalog' | 'update-catalog' | 'flush' | 'relinquish-var' | 'sync' | 'rotate' | 'print-header'
| 'verify' | 'disk-usage' | 'list-boots' | 'vacuum' | 'rotate-and-vacuum' | 'list-fields' | 'list-field-names';

interface Args {
  action: Action;
  output: OutputMode;
  utc: boolean;
  follow: boolean;
  full: boolean;
  all: boolean;
  lines: number;
  linesOldest: boolean;
  noTail: boolean;
  truncateNewline: boolean;
  quiet: boolean;
  merge: boolean;
  boot: boolean;
  bootId: string | null;
  bootOffset: number;
  dmesg: boolean;
  noHostname: boolean;
  cursor: string | null;
  cursorFile: string | null;
  afterCursor: string | null;
  showCursor: boolean;
  directory: string | null;
  files: string[];
  fileStdin: boolean;
  priorities: number;
  facilities: number[];
  since: number;
  until: number;
  sinceSet: boolean;
  untilSet: boolean;
  syslogIdentifiers: string[];
  systemUnits: string[];
  userUnits: string[];
  field: string | null;
  catalog: boolean;
  reverse: boolean;
  journalType: number;
  root: string | null;
  image: string | null;
  machine: string | null;
  namespace: string | null;
  outputFields: Set<string> | null;
  pattern: string | null;
  caseMode: 'auto' | 'sensitive' | 'insensitive';
  vacuumSize: number;
  vacuumFiles: number;
  vacuumTime: number;
  jsonOutput: boolean;
}

const SYSTEM_TYPE = 1;
const CURRENT_USER_TYPE = 2;

function defaultArgs(): Args {
  return {
    action: 'show', output: 'short', utc: false, follow: false, full: true, all: false, lines: ARG_LINES_DEFAULT, linesOldest: false, noTail: false, truncateNewline: false,
    quiet: false, merge: false, boot: false, bootId: null, bootOffset: 0, dmesg: false, noHostname: false, cursor: null, cursorFile: null, afterCursor: null,
    showCursor: false, directory: null, files: [], fileStdin: false, priorities: 0xff, facilities: [], since: 0, until: 0, sinceSet: false, untilSet: false,
    syslogIdentifiers: [], systemUnits: [], userUnits: [], field: null, catalog: false, reverse: false, journalType: 0, root: null, image: null, machine: null,
    namespace: null, outputFields: null, pattern: null, caseMode: 'auto', vacuumSize: 0, vacuumFiles: 0, vacuumTime: 0, jsonOutput: false,
  };
}

function safeAtoi(input: string): number | 'EINVAL' | 'ERANGE' {
  let s = input.replace(/^[ \t\n\r]+/, '');
  let base = 0;
  const prefixed = /^(0[bB]|0[oO])/.exec(s);
  if (prefixed) {
    base = prefixed[1][1].toLowerCase() === 'b' ? 2 : 8;
    s = s.slice(2);
  }
  const sign = s[0] === '-' || s[0] === '+' ? s[0] : '';
  let body = sign ? s.slice(1) : s;
  if (base === 0) {
    if (/^0[xX]/.test(body)) {
      base = 16;
      body = body.slice(2);
    } else if (/^0/.test(body) && body.length > 1) {
      base = 8;
      body = body.slice(1);
    } else base = 10;
  }
  const digits = base === 16 ? /^[0-9a-fA-F]+$/ : base === 8 ? /^[0-7]+$/ : base === 2 ? /^[01]+$/ : /^[0-9]+$/;
  if (!digits.test(body)) return 'EINVAL';
  const value = parseInt(body, base) * (sign === '-' ? -1 : 1);
  if (value > 2147483647 || value < -2147483648) return 'ERANGE';
  return value;
}

function stringTableLookup(table: readonly string[], value: string, max: number): number | 'EINVAL' | 'ERANGE' {
  const index = table.indexOf(value);
  if (index >= 0) return index;
  if (!/^\s*[+-]?[0-9]+\s*$/.test(value) || /^\s*-/.test(value) && !/^\s*-0+\s*$/.test(value)) return 'EINVAL';
  const parsed = Number(value.trim());
  if (parsed > max) return 'ERANGE';
  return parsed;
}

function compilePattern(pattern: string, mode: Args['caseMode']): { regex: RegExp } | { error: string } {
  const insensitive = mode === 'insensitive' || (mode === 'auto' && !/[A-Z]/.test(pattern));
  let balanced = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      if (i >= pattern.length) return { error: '\\ at end of pattern' };
      continue;
    }
    if (inClass) {
      if (ch === ']' ) inClass = false;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '(') balanced++;
    else if (ch === ')') {
      balanced--;
      if (balanced < 0) return { error: 'unmatched closing parenthesis' };
    }
  }
  if (inClass) return { error: 'missing terminating ] for character class' };
  if (balanced > 0) return { error: 'missing closing parenthesis' };
  if (/^[*+?]/.test(pattern) || /(^|[(|])[*+?]/.test(pattern)) return { error: 'quantifier does not follow a repeatable item' };
  try {
    return { regex: new RegExp(pattern, insensitive ? 'i' : '') };
  } catch {
    return { error: 'regular expression is too large' };
  }
}

const HELP = (): string => {
  const heading = (title: string): string => `\x1b[0m${title}`;
  return [
    'journalctl [OPTIONS...] [MATCHES...]',
    '',
    'Query the journal.',
    '',
    heading('Source Options:'),
    '     --system                Show the system journal',
    '     --user                  Show the user journal for the current user',
    '  -M --machine=CONTAINER     Operate on local container',
    '  -m --merge                 Show entries from all available journals',
    '  -D --directory=PATH        Show journal files from directory',
    '     --file=PATH             Show journal file',
    '     --root=PATH             Operate on an alternate filesystem root',
    '     --image=PATH            Operate on disk image as filesystem root',
    '     --image-policy=POLICY   Specify disk image dissection policy',
    '     --namespace=NAMESPACE   Show journal data from specified journal namespace',
    '',
    heading('Filtering Options:'),
    '  -S --since=DATE            Show entries not older than the specified date',
    '  -U --until=DATE            Show entries not newer than the specified date',
    '  -c --cursor=CURSOR         Show entries starting at the specified cursor',
    '     --after-cursor=CURSOR   Show entries after the specified cursor',
    '     --cursor-file=FILE      Show entries after cursor in FILE and update FILE',
    '  -b --boot[=ID]             Show current boot or the specified boot',
    '  -u --unit=UNIT             Show logs from the specified unit',
    '     --user-unit=UNIT        Show logs from the specified user unit',
    '  -t --identifier=STRING     Show entries with the specified syslog identifier',
    '  -p --priority=RANGE        Show entries with the specified priority',
    '     --facility=FACILITY...  Show entries with the specified facilities',
    '  -g --grep=PATTERN          Show entries with MESSAGE matching PATTERN',
    '     --case-sensitive[=BOOL] Force case sensitive or insensitive matching',
    '  -k --dmesg                 Show kernel message log from the current boot',
    '',
    heading('Output Control Options:'),
    '  -o --output=STRING         Change journal output mode (short, short-precise,',
    '                               short-iso, short-iso-precise, short-full,',
    '                               short-monotonic, short-unix, verbose, export,',
    '                               json, json-pretty, json-sse, json-seq, cat,',
    '                               with-unit)',
    '     --output-fields=LIST    Select fields to print in verbose/export/json modes',
    '  -n --lines[=[+]INTEGER]    Number of journal entries to show',
    '  -r --reverse               Show the newest entries first',
    '     --show-cursor           Print the cursor after all the entries',
    '     --utc                   Express time in Coordinated Universal Time (UTC)',
    '  -x --catalog               Add message explanations where available',
    '     --no-hostname           Suppress output of hostname field',
    '     --no-full               Ellipsize fields',
    '  -a --all                   Show all fields, including long and unprintable',
    '  -f --follow                Follow the journal',
    '     --no-tail               Show all lines, even in follow mode',
    '     --truncate-newline      Truncate entries by first newline character',
    '  -q --quiet                 Do not show info messages and privilege warning',
    '',
    heading('Pager Control Options:'),
    '     --no-pager              Do not pipe output into a pager',
    '  -e --pager-end             Immediately jump to the end in the pager',
    '',
    heading('Forward Secure Sealing (FSS) Options:'),
    '     --interval=TIME         Time interval for changing the FSS sealing key',
    '     --verify-key=KEY        Specify FSS verification key',
    '     --force                 Override of the FSS key pair with --setup-keys',
    '',
    heading('Commands:'),
    '  -h --help                  Show this help text',
    '     --version               Show package version',
    '  -N --fields                List all field names currently used',
    '  -F --field=FIELD           List all values that a specified field takes',
    '     --list-boots            Show terse information about recorded boots',
    '     --disk-usage            Show total disk usage of all journal files',
    '     --vacuum-size=BYTES     Reduce disk usage below specified size',
    '     --vacuum-files=INT      Leave only the specified number of journal files',
    '     --vacuum-time=TIME      Remove journal files older than specified time',
    '     --verify                Verify journal file consistency',
    '     --sync                  Synchronize unwritten journal messages to disk',
    '     --relinquish-var        Stop logging to disk, log to temporary file system',
    '     --smart-relinquish-var  Similar, but NOP if log directory is on root mount',
    '     --flush                 Flush all journal data from /run into /var',
    '     --rotate                Request immediate rotation of the journal files',
    '     --header                Show journal header information',
    '     --list-catalog          Show all message IDs in the catalog',
    '     --dump-catalog          Show entries in the message catalog',
    '     --update-catalog        Update the message catalog database',
    '     --setup-keys            Generate a new FSS key pair',
    '',
    'See the journalctl(1) man page for details.',
    '',
  ].join('\n');
};

type PositionState =
  | { kind: 'head' } | { kind: 'tail' } | { kind: 'realtime'; usec: number } | { kind: 'cursor'; cursor: JournalCursor } | { kind: 'at'; index: number };

class JournalReader {
  private view: number[] = [];
  private state: PositionState = { kind: 'head' };

  constructor(private readonly all: readonly JournalRecord[], private readonly matches: JournalMatches) {
    this.refresh();
  }

  refresh(): void {
    this.view = [];
    for (let i = 0; i < this.all.length; i++) if (this.matches.matches(this.all[i])) this.view.push(i);
  }

  seekHead(): void { this.state = { kind: 'head' }; }
  seekTail(): void { this.state = { kind: 'tail' }; }
  seekRealtime(usec: number): void { this.state = { kind: 'realtime', usec }; }
  seekCursor(cursor: JournalCursor): void { this.state = { kind: 'cursor', cursor }; }

  current(): JournalRecord | null {
    return this.state.kind === 'at' ? this.all[this.state.index] : null;
  }

  private compareToCursor(record: JournalRecord, cursor: JournalCursor): number {
    if (cursor.seqnumId !== undefined && cursor.seqnum !== undefined && record.seqnumId === cursor.seqnumId) return Math.sign(record.seqnum - cursor.seqnum);
    if (cursor.bootId !== undefined && cursor.monotonic !== undefined && record.bootId === cursor.bootId) return Math.sign(record.monotonicUsec - cursor.monotonic);
    if (cursor.realtime !== undefined) return Math.sign(record.realtimeUsec - cursor.realtime);
    return 0;
  }

  step(forward: boolean): boolean {
    const view = this.view;
    let found = -1;
    switch (this.state.kind) {
      case 'head':
        if (forward && view.length > 0) found = view[0];
        break;
      case 'tail':
        if (!forward && view.length > 0) found = view[view.length - 1];
        break;
      case 'at': {
        const here = this.state.index;
        if (forward) found = view.find(index => index > here) ?? -1;
        else for (let k = view.length - 1; k >= 0; k--) if (view[k] < here) { found = view[k]; break; }
        break;
      }
      case 'realtime': {
        const usec = this.state.usec;
        if (forward) found = view.find(index => this.all[index].realtimeUsec >= usec) ?? -1;
        else for (let k = view.length - 1; k >= 0; k--) if (this.all[view[k]].realtimeUsec <= usec) { found = view[k]; break; }
        break;
      }
      case 'cursor': {
        const cursor = this.state.cursor;
        if (forward) found = view.find(index => this.compareToCursor(this.all[index], cursor) >= 0) ?? -1;
        else for (let k = view.length - 1; k >= 0; k--) if (this.compareToCursor(this.all[view[k]], cursor) <= 0) { found = view[k]; break; }
        break;
      }
    }
    if (found < 0) return false;
    this.state = { kind: 'at', index: found };
    return true;
  }

  previousSkip(skip: number): number {
    if (skip === 0) return this.step(false) ? 1 : 0;
    for (let i = 0; i < skip; i++) if (!this.step(false)) return i;
    return skip;
  }

  testCursor(cursor: JournalCursor): boolean {
    const record = this.current();
    if (record === null) return false;
    if (cursor.seqnum !== undefined && cursor.seqnumId !== undefined && (record.seqnum !== cursor.seqnum || record.seqnumId !== cursor.seqnumId)) return false;
    if (cursor.monotonic !== undefined && cursor.bootId !== undefined && (record.monotonicUsec !== cursor.monotonic || record.bootId !== cursor.bootId)) return false;
    if (cursor.realtime !== undefined && record.realtimeUsec !== cursor.realtime) return false;
    if (cursor.xorHash !== undefined && BigInt(`0x${record.xorHash}`) !== cursor.xorHash) return false;
    return true;
  }
}

interface Boot {
  id: string;
  firstUsec: number;
  lastUsec: number;
}

function listBoots(all: readonly JournalRecord[]): Boot[] {
  const boots: Boot[] = [];
  for (const record of all) {
    const known = boots.find(boot => boot.id === record.bootId);
    if (known === undefined) boots.push({ id: record.bootId, firstUsec: record.realtimeUsec, lastUsec: record.realtimeUsec });
    else known.lastUsec = record.realtimeUsec;
  }
  return boots;
}

export function runJournalctl(host: JournalctlHost, argv: string[], program = 'journalctl'): ToolResult {
  const out = new ToolOutput();
  const stdout: Uint8Array[] = [];
  const sink = { write: (bytes: Uint8Array): void => { stdout.push(bytes); out.printf(text(bytes)); } };
  const say = (line: string): void => sink.write(utf8(line));
  const fail = (message: string, errno: string | null = null, code = 1): never => {
    out.eprintf(`${message}${errno === null ? '' : `: ${ERRNO_TEXT[errno] ?? errno}`}\n`);
    throw new ExitSignal(code);
  };
  const notice = (message: string): void => out.eprintf(`${message}\n`);

  const args = defaultArgs();
  const clock: SystemdClock = systemdClock(host.zoneName());
  let exitCode = 0;
  try {
    const status = parseArgv(host, argv, args, out, program, clock, say, fail);
    if (status === 'done') return finish(out, 0);
    runAction(host, args, clock, sink, say, fail, notice, out);
  } catch (error) {
    if (error instanceof ExitSignal) exitCode = error.code;
    else throw error;
  }
  return finish(out, exitCode);
}

function finish(out: ToolOutput, exitCode: number): ToolResult {
  return { stdout: out.stdout, stderr: out.stderr, exitCode, interleaved: out.interleaved };
}

type Fail = (message: string, errno?: string | null, code?: number) => never;

function parseArgv(
  host: JournalctlHost, argv: string[], args: Args, out: ToolOutput, program: string, clock: SystemdClock, say: (text: string) => void, fail: Fail,
): 'continue' | 'done' {
  const rest = [program, ...argv];
  const getopt = new GnuGetopt(rest, 'hefo:aln::qmb::kD:p:g:c:S:U:t:u:NF:xrM:', OPTIONS, { program, write: text => out.eprintf(text) });
  let action: Action = 'show';
  const parseLines = (arg: string | null, graceful: boolean): boolean => {
    const defaultNoArg = (): boolean => {
      args.lines = 10;
      args.linesOldest = false;
      return false;
    };
    if (arg === null) return defaultNoArg();
    if (arg === 'all') {
      args.lines = ARG_LINES_ALL;
      return true;
    }
    const plus = arg.startsWith('+');
    const parsed = safeAtoi(plus ? arg.slice(1) : arg);
    if (typeof parsed !== 'number' || parsed < 0) {
      if (graceful) return defaultNoArg();
      return fail(`Failed to parse --lines='${arg}'.`);
    }
    args.lines = parsed;
    args.linesOldest = plus;
    return true;
  };
  const parseBootDescriptor = (value: string): { id: string | null; offset: number; all?: boolean } | null => {
    if (value === 'all') return { id: null, offset: 0, all: true };
    if (value.length >= 32) {
      let id: string | null = null;
      let tail = value;
      const head = value.slice(0, 32);
      const parsed = parseId128(head);
      if (parsed !== null) {
        id = parsed;
        tail = value.slice(32);
      }
      if (tail !== '' && tail[0] !== '-' && tail[0] !== '+') return null;
      let offset = 0;
      if (tail !== '') {
        const n = safeAtoi(tail);
        if (typeof n !== 'number') return null;
        offset = n;
      }
      return { id, offset };
    }
    const n = safeAtoi(value);
    return typeof n === 'number' ? { id: null, offset: n } : null;
  };
  for (;;) {
    const result = getopt.next();
    if (result.code === END_OF_OPTIONS) break;
    const optarg = result.optarg;
    const c = result.code;
    if (c === 63) throw new ExitSignal(1);
    switch (c) {
      case 0x68: say(HELP()); return 'done';
      case 0x100: say(`${JOURNALCTL_VERSION}\n${FEATURES}\n`); return 'done';
      case 0x101: break;
      case 0x65: if (args.lines === ARG_LINES_DEFAULT) args.lines = 1000; args.boot = true; break;
      case 0x66: args.follow = true; break;
      case 0x6f: {
        if (optarg === 'help') {
          say(`${OUTPUT_MODES.join('\n')}\n`);
          return 'done';
        }
        if (!OUTPUT_MODES.includes(optarg as OutputMode)) return fail(`Unknown output format '${optarg}'.`);
        args.output = optarg as OutputMode;
        if (['export', 'json', 'json-pretty', 'json-sse', 'json-seq', 'cat'].includes(args.output)) args.quiet = true;
        args.jsonOutput = isJsonMode(args.output);
        break;
      }
      case 0x6c: args.full = true; break;
      case 0x102: args.full = false; break;
      case 0x61: args.all = true; break;
      case 0x6e: {
        const used = parseLines(optarg ?? rest[getopt.optind] ?? null, optarg === null);
        if (used && optarg === null) getopt.optind++;
        break;
      }
      case 0x103: args.noTail = true; break;
      case 0x120: args.truncateNewline = true; break;
      case 0x104: args.action = action = 'new-id128'; break;
      case 0x71: args.quiet = true; break;
      case 0x6d: args.merge = true; break;
      case 0x105: args.boot = true; args.bootId = null; args.bootOffset = 0; break;
      case 0x62: {
        args.boot = true;
        args.bootId = null;
        args.bootOffset = 0;
        if (optarg !== null) {
          const parsed = parseBootDescriptor(optarg);
          if (parsed === null) return fail(`Failed to parse boot descriptor '${optarg}'`);
          args.bootId = parsed.id;
          args.bootOffset = parsed.offset;
          args.boot = parsed.all !== true;
        } else if (getopt.optind < rest.length) {
          const parsed = parseBootDescriptor(rest[getopt.optind]);
          if (parsed !== null) {
            args.bootId = parsed.id;
            args.bootOffset = parsed.offset;
            args.boot = parsed.all !== true;
            getopt.optind++;
          }
        }
        break;
      }
      case 0x106: args.action = action = 'list-boots'; break;
      case 0x6b: args.boot = args.dmesg = true; break;
      case 0x108: args.journalType |= SYSTEM_TYPE; break;
      case 0x107: args.journalType |= CURRENT_USER_TYPE; break;
      case 0x4d: args.machine = optarg; break;
      case 0x12a:
        if (optarg === '*') args.namespace = null;
        else if (optarg !== null && optarg.startsWith('+')) args.namespace = optarg.slice(1);
        else args.namespace = optarg === '' ? null : optarg;
        break;
      case 0x44: args.directory = optarg; break;
      case 0x110: if (optarg === '-') args.fileStdin = true; else args.files.push(optarg as string); break;
      case 0x109: args.root = optarg; break;
      case 0x10a: args.image = optarg; break;
      case 0x10b: break;
      case 0x63: args.cursor = optarg; break;
      case 0x117: args.cursorFile = optarg; break;
      case 0x118: args.afterCursor = optarg; break;
      case 0x119: args.showCursor = true; break;
      case 0x10c: args.action = action = 'print-header'; break;
      case 0x114: args.action = action = 'verify'; break;
      case 0x116: args.action = action = 'disk-usage'; break;
      case 0x125: {
        const size = parseSize(optarg as string);
        if (size === null) return fail(`Failed to parse vacuum size: ${optarg}`);
        args.vacuumSize = size;
        args.action = action = action === 'rotate' ? 'rotate-and-vacuum' : 'vacuum';
        break;
      }
      case 0x126:
        if (!/^[0-9]+$/.test((optarg as string).trim())) return fail(`Failed to parse vacuum files: ${optarg}`);
        args.vacuumFiles = Number(optarg);
        args.action = action = action === 'rotate' ? 'rotate-and-vacuum' : 'vacuum';
        break;
      case 0x127: {
        const parsed = parseSec(optarg as string);
        if (!parsed.ok) return fail(`Failed to parse vacuum time: ${optarg}`);
        args.vacuumTime = parsed.usec;
        args.action = action = action === 'rotate' ? 'rotate-and-vacuum' : 'vacuum';
        break;
      }
      case 0x10d: case 0x112: case 0x115: case 0x113:
        return fail('Compiled without forward-secure sealing support.');
      case 0x70: {
        const value = optarg as string;
        const dots = value.indexOf('..');
        if (dots >= 0) {
          const from = stringTableLookup(LOG_LEVELS, value.slice(0, dots), 7);
          const to = stringTableLookup(LOG_LEVELS, value.slice(dots + 2), 7);
          if (typeof from !== 'number' || typeof to !== 'number') return fail(`Failed to parse log level range ${value}`);
          args.priorities = 0;
          const [low, high] = from < to ? [from, to] : [to, from];
          for (let i = low; i <= high; i++) args.priorities |= 1 << i;
        } else {
          const p = stringTableLookup(LOG_LEVELS, value, 7);
          if (typeof p !== 'number') return fail(`Unknown log level ${value}`);
          args.priorities = 0;
          for (let i = 0; i <= p; i++) args.priorities |= 1 << i;
        }
        break;
      }
      case 0x10e: {
        for (const word of (optarg as string).split(',').filter(piece => piece !== '')) {
          if (word === 'help') {
            if (!args.quiet) say('Available facilities:\n');
            say(`${FACILITY_NAMES.join('\n')}\n`);
            return 'done';
          }
          const named = FACILITY_NAMES.indexOf(word);
          const number = named >= 0 && named < 12 || named >= 16 ? named : stringTableLookup(FACILITY_NAMES.map((name, i) => (i >= 12 && i < 16 ? '' : name)), word, 0x3ff >> 3);
          if (typeof number !== 'number') return fail(`Bad --facility= argument "${word}".`);
          if (!args.facilities.includes(number)) args.facilities.push(number);
        }
        break;
      }
      case 0x67: args.pattern = optarg; break;
      case 0x111:
        if (optarg !== null) {
          const lowered = optarg.toLowerCase();
          if (['1', 'yes', 'y', 'true', 't', 'on'].includes(lowered)) args.caseMode = 'sensitive';
          else if (['0', 'no', 'n', 'false', 'f', 'off'].includes(lowered)) args.caseMode = 'insensitive';
          else return fail(`Bad --case-sensitive= argument "${optarg}"`, 'EINVAL');
        } else args.caseMode = 'sensitive';
        break;
      case 0x53: {
        const parsed = parseTimestamp(optarg as string, host.nowUsec(), clock);
        if (parsed === null) return fail(`Failed to parse timestamp: ${optarg}`);
        args.since = parsed;
        args.sinceSet = true;
        break;
      }
      case 0x55: {
        const parsed = parseTimestamp(optarg as string, host.nowUsec(), clock);
        if (parsed === null) return fail(`Failed to parse timestamp: ${optarg}`);
        args.until = parsed;
        args.untilSet = true;
        break;
      }
      case 0x74: args.syslogIdentifiers.push(optarg as string); break;
      case 0x75: args.systemUnits.push(optarg as string); break;
      case 0x11a: args.userUnits.push(optarg as string); break;
      case 0x46: args.action = action = 'list-fields'; args.field = optarg; break;
      case 0x4e: args.action = action = 'list-field-names'; break;
      case 0x128: args.noHostname = true; break;
      case 0x78: args.catalog = true; break;
      case 0x11b: args.action = action = 'list-catalog'; break;
      case 0x11c: args.action = action = 'dump-catalog'; break;
      case 0x11d: args.action = action = 'update-catalog'; break;
      case 0x72: args.reverse = true; break;
      case 0x11e: args.utc = true; break;
      case 0x11f: args.action = action = 'flush'; break;
      case 0x121: case 0x122: args.action = action = 'relinquish-var'; break;
      case 0x124: args.action = action = action === 'vacuum' ? 'rotate-and-vacuum' : 'rotate'; break;
      case 0x123: args.action = action = 'sync'; break;
      case 0x129: {
        const pieces = (optarg as string).split(',').filter(piece => piece !== '');
        if (pieces.length > 0) {
          const set = args.outputFields ?? new Set<string>();
          for (const piece of pieces) set.add(piece);
          args.outputFields = set;
        }
        break;
      }
      default: break;
    }
  }
  const matchArgs = rest.slice(getopt.optind);
  (args as Args & { matchArgs: string[] }).matchArgs = matchArgs;
  if (args.noTail) args.lines = ARG_LINES_ALL;
  if (args.follow && !args.sinceSet && args.lines === ARG_LINES_DEFAULT) args.lines = 10;
  if (args.follow && !args.merge && !args.boot) {
    args.boot = true;
    args.bootId = null;
    args.bootOffset = 0;
  }
  const sources = [args.directory, args.files.length > 0 || args.fileStdin ? 'file' : null, args.machine, args.root, args.image].filter(value => value !== null).length;
  if (sources > 1) return fail('Please specify at most one of -D/--directory=, --file=, -M/--machine=, --root=, --image=.');
  if (args.sinceSet && args.untilSet && args.since > args.until) return fail('--since= must be before --until=.');
  if ((args.cursor !== null ? 1 : 0) + (args.afterCursor !== null ? 1 : 0) + (args.sinceSet ? 1 : 0) > 1) return fail('Please specify only one of --since=, --cursor=, and --after-cursor=.');
  if (args.follow && args.reverse) return fail('Please specify either --reverse or --follow, not both.');
  if (args.lines >= 0 && args.linesOldest && (args.reverse || args.follow)) return fail('--lines=+N is unsupported when --reverse or --follow is specified.');
  if (!['show', 'dump-catalog', 'list-catalog'].includes(action) && matchArgs.length > 0) return fail(`Extraneous arguments starting with '${matchArgs[0]}'`);
  if ((args.boot || action === 'list-boots') && args.merge) return fail('Using --boot or --list-boots with --merge is not supported.');
  if (args.systemUnits.length > 0 && args.journalType === CURRENT_USER_TYPE) {
    args.userUnits.push(...args.systemUnits);
    args.systemUnits = [];
  }
  if (args.pattern !== null) {
    const compiled = compilePattern(args.pattern, args.caseMode);
    if ('error' in compiled) return fail(`Bad pattern "${args.pattern}": ${compiled.error}`);
    (args as Args & { regex: RegExp }).regex = compiled.regex;
    if (args.lines >= 0 && !args.linesOldest && !args.follow) args.reverse = true;
  }
  return 'continue';
}

function parseSize(input: string): number | null {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGTPE]?)(?:i?B)?\s*$/i.exec(input);
  if (match === null) return null;
  const factors: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5, E: 1024 ** 6 };
  return Math.floor(Number(match[1]) * factors[match[2].toUpperCase()]);
}

function runAction(
  host: JournalctlHost, args: Args, clock: SystemdClock, sink: { write(bytes: Uint8Array): void }, say: (text: string) => void, fail: Fail, notice: (message: string) => void, out: ToolOutput,
): void {
  const extra = args as Args & { matchArgs: string[]; regex?: RegExp };
  if (args.action === 'new-id128') {
    const id = host.newId128();
    say(`As string:\n${id}\n\nAs UUID:\n${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}\n\nAs systemd-id128(1) macro:\n#define XYZ SD_ID128_MAKE(${id.match(/../g)!.join(',')})\n\nAs Python constant:\n>>> import uuid\n>>> XYZ = uuid.UUID('${id}')\n`);
    return;
  }
  if (args.action === 'flush' || args.action === 'relinquish-var' || args.action === 'sync' || args.action === 'rotate') {
    const table = {
      flush: ['--flush', 'io.systemd.Journal.FlushToVar'],
      'relinquish-var': ['--relinquish-var/--smart-relinquish-var', 'io.systemd.Journal.RelinquishVar'],
      sync: ['--sync', 'io.systemd.Journal.Synchronize'],
      rotate: ['--rotate', 'io.systemd.Journal.Rotate'],
    } as const;
    if (args.action === 'flush' && host.flushed()) return;
    const [option, method] = table[args.action];
    varlinkCall(host, args, option, method, fail);
    return;
  }
  const all = host.records();
  if (args.directory !== null && args.directory !== host.journalDirectory()) return fail(`Failed to open ${args.directory}`, 'ENOENT');
  if (args.root !== null || args.image !== null || args.files.length > 0 || args.fileStdin || args.machine !== null) {
    const target = args.root ?? args.image ?? args.files[0] ?? args.machine ?? 'files';
    return fail(`Failed to open ${args.files.length > 0 ? 'files' : target}`, 'ENOENT');
  }
  if (!host.canReadJournal()) {
    if (!args.quiet) {
      notice(`Hint: You are currently not seeing messages from ${args.journalType === CURRENT_USER_TYPE || args.userUnits.length > 0 ? 'the system' : 'other users and the system'}.\n      Users in the 'systemd-journal' group can see all messages. Pass -q to\n      turn off this notice.`);
    }
    return fail('No journal files were opened due to insufficient permissions.', null);
  }
  if (!host.hasJournalFiles() && !args.quiet) notice('No journal files were found.');

  if (args.action === 'list-catalog' || args.action === 'dump-catalog' || args.action === 'update-catalog') {
    runCatalogAction(host, args, extra.matchArgs, say, fail, notice);
    return;
  }
  if (args.action === 'disk-usage') {
    say(`Archived and active journals take up ${formatBytes(host.diskUsageBytes())} in the file system.\n`);
    return;
  }
  if (args.action === 'list-boots') {
    const boots = listBoots(all);
    if (boots.length === 0) return;
    printBoots(boots, args, clock, say);
    return;
  }
  if (args.action === 'list-field-names') {
    const names: string[] = [];
    for (const record of all) for (const [name] of record.fields) if (!names.includes(name)) names.push(name);
    say(names.map(name => `${name}\n`).join(''));
    return;
  }
  if (args.action === 'print-header') {
    say(host.files().map(file => formatHeader(file, clock)).join('\n'));
    return;
  }
  if (args.action === 'verify') {
    for (const file of host.files()) notice(`PASS: ${file.path}`);
    return;
  }
  if (args.action === 'vacuum' || args.action === 'rotate-and-vacuum') {
    if (args.action === 'rotate-and-vacuum') varlinkCall(host, args, '--rotate', 'io.systemd.Journal.Rotate', fail);
    for (const result of host.vacuum({ size: args.vacuumSize, files: args.vacuumFiles, time: args.vacuumTime })) {
      for (const entry of result.deleted) notice(`Deleted archived journal ${result.directory}/${entry.name} (${formatBytes(entry.bytes)}).`);
      notice(`Vacuuming done, freed ${formatBytes(result.freedBytes)} of archived journals from ${result.directory}.`);
    }
    return;
  }

  const matches = new JournalMatches();
  const boots = listBoots(all);
  if (args.boot) {
    if (args.bootOffset === 0 && args.bootId === null && args.directory === null && args.files.length === 0 && args.root === null) {
      matches.addMatch(`_BOOT_ID=${host.currentBootId()}`);
      matches.addConjunction();
    } else {
      let bootId = args.bootId;
      if (bootId === null) {
        const found = findBootByOffset(boots, args.bootOffset);
        if (found === null) return fail(`No journal boot entry found from the specified boot offset (${args.bootOffset >= 0 ? '+' : ''}${args.bootOffset}).`);
        bootId = found;
      } else if (!boots.some(boot => boot.id === bootId)) {
        return fail(`No journal boot entry found from the specified boot ID (${bootId}).`);
      }
      matches.addMatch(`_BOOT_ID=${bootId}`);
      matches.addConjunction();
    }
  }
  if (args.dmesg) {
    matches.addMatch('_TRANSPORT=kernel');
    matches.addConjunction();
  }
  addUnits(all, matches, args, fail, notice);
  if (args.syslogIdentifiers.length > 0) {
    for (const identifier of args.syslogIdentifiers) {
      matches.addMatch(`SYSLOG_IDENTIFIER=${identifier}`);
      matches.addDisjunction();
    }
    matches.addConjunction();
  }
  if (args.priorities !== 0xff) {
    for (let i = 0; i <= 7; i++) if (args.priorities & (1 << i)) matches.addMatch(`PRIORITY=${i}`);
    matches.addConjunction();
  }
  for (const facility of args.facilities) matches.addMatch(`SYSLOG_FACILITY=${facility}`);
  addMatchArgs(host, matches, extra.matchArgs, fail);

  if (args.action === 'list-fields') {
    const field = args.field as string;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(field) || field.length > 64) return fail('Failed to query unique data objects', 'EINVAL');
    const seen: string[] = [];
    const decoder = new TextDecoder();
    for (const record of all) {
      for (const [name, value] of record.fields) if (name === field) {
        const rendered = decoder.decode(value);
        if (!seen.includes(rendered)) seen.push(rendered);
      }
    }
    let shown = 0;
    for (const value of seen.reverse()) {
      if (args.lines >= 0 && shown >= args.lines) break;
      say(`${value}\n`);
      shown++;
    }
    return;
  }

  showEntries(host, args, extra, clock, sink, say, fail, all, matches, out);
}

function runCatalogAction(
  host: JournalctlHost, args: Args, items: string[], say: (text: string) => void, fail: Fail, notice: (message: string) => void,
): void {
  if (args.action === 'update-catalog') {
    const error = host.updateCatalog();
    if (error !== null) fail('Failed to list catalog', error);
    return;
  }
  const database = host.catalog();
  if (database === null) return fail('Failed to list catalog', 'ENOENT');
  const oneline = args.action === 'list-catalog';
  const locale = host.locale();
  if (items.length === 0) {
    say(listCatalog(database, locale, oneline));
    return;
  }
  let failure: string | null = null;
  for (const item of items) {
    const id = parseId128(item);
    if (id === null) {
      notice(`Failed to parse id128 '${item}': ${ERRNO_TEXT.EINVAL}`);
      failure = failure ?? 'EINVAL';
      continue;
    }
    const body = findCatalogText(database, id, locale.messages);
    if (body === null) {
      notice(`Failed to retrieve catalog entry for '${item}': ${ERRNO_TEXT.ENOENT}`);
      failure = failure ?? 'ENOENT';
      continue;
    }
    say(dumpCatalogEntry(id, body, oneline));
  }
  if (failure !== null) return fail('Failed to list catalog', failure);
}

function varlinkCall(host: JournalctlHost, args: Args, option: string, method: string, fail: Fail): void {
  if (args.machine !== null) return fail(`${option} is not supported in conjunction with --machine=.`, 'EOPNOTSUPP');
  const address = args.namespace !== null ? `/run/systemd/journal.${args.namespace}/io.systemd.journal` : '/run/systemd/journal/io.systemd.journal';
  const outcome = host.varlink(method, args.namespace);
  if ('connectErrno' in outcome) return fail(`Failed to connect to ${address}`, outcome.connectErrno);
  if ('error' in outcome) return fail(`Failed to execute varlink call: ${outcome.error}`);
}

function formatHeader(file: JournalFileInfo, clock: SystemdClock): string {
  const stamp = (usec: number): string => formatTimestamp(usec, 'pretty', clock) ?? '(null)';
  const flags = (names: string[]): string => names.map(name => ` ${name}`).join('');
  let out = `File path: ${file.path}\nFile ID: ${file.fileId}\nMachine ID: ${file.machineId}\nBoot ID: ${file.bootId}\nSequential number ID: ${file.seqnumId}\nState: ${file.state}\n`;
  out += `Compatible flags:${flags(file.compatibleFlags)}\nIncompatible flags:${flags(file.incompatibleFlags)}\nHeader size: ${file.headerSize}\nArena size: ${file.arenaSize}\n`;
  out += `Data hash table size: ${file.dataHashTableSize}\nField hash table size: ${file.fieldHashTableSize}\nRotate suggested: ${file.rotateSuggested ? 'yes' : 'no'}\n`;
  out += `Head sequential number: ${file.headSeqnum} (${file.headSeqnum.toString(16)})\nTail sequential number: ${file.tailSeqnum} (${file.tailSeqnum.toString(16)})\n`;
  out += `Head realtime timestamp: ${stamp(file.headRealtime)} (${file.headRealtime.toString(16)})\nTail realtime timestamp: ${stamp(file.tailRealtime)} (${file.tailRealtime.toString(16)})\n`;
  out += `Tail monotonic timestamp: ${formatTimespan(file.tailMonotonic, 1000)} (${file.tailMonotonic.toString(16)})\nObjects: ${file.objects}\nEntry objects: ${file.entries}\n`;
  out += `Data objects: ${file.data}\nData hash table fill: ${(100 * file.data / file.dataHashTableSize).toFixed(1)}%\n`;
  out += `Field objects: ${file.fields}\nField hash table fill: ${(100 * file.fields / file.fieldHashTableSize).toFixed(1)}%\n`;
  out += `Tag objects: ${file.tags}\nEntry array objects: ${file.entryArrays}\nDeepest field hash chain: ${file.fieldHashChainDepth}\nDeepest data hash chain: ${file.dataHashChainDepth}\n`;
  out += `Disk usage: ${formatBytes(file.diskUsageBytes)}\n`;
  return out;
}

function findBootByOffset(boots: Boot[], offset: number): string | null {
  const index = offset <= 0 ? boots.length - 1 + offset : offset - 1;
  return index >= 0 && index < boots.length ? boots[index].id : null;
}

function printBoots(boots: Boot[], args: Args, clock: SystemdClock, say: (text: string) => void): void {
  const ordered = boots.map((boot, i) => ({ boot, index: i - boots.length + 1 }));
  if (args.reverse) ordered.reverse();
  if (args.jsonOutput) {
    const rows: JsonValue = ordered.map(({ boot, index }): JsonValue => ({
      object: [['index', index], ['boot_id', jsonString(utf8(boot.id))], ['first_entry', boot.firstUsec], ['last_entry', boot.lastUsec]],
    }));
    say(dumpJson(rows, args.output));
    return;
  }
  const rows = ordered.map(({ boot, index }) => [String(index), boot.id, formatTimestamp(boot.firstUsec, 'pretty', clock) ?? '', formatTimestamp(boot.lastUsec, 'pretty', clock) ?? '']);
  const header = ['IDX', 'BOOT ID', 'FIRST ENTRY', 'LAST ENTRY'];
  const shown = args.quiet ? rows : [header, ...rows];
  const widths = header.map((_, column) => Math.max(...shown.map(row => row[column].length)));
  const render = (row: string[]): string => `${row.map((cell, column) => (column === 0 ? cell.padStart(widths[0]) : column < 3 ? cell.padEnd(widths[column]) : cell)).join(' ')}\n`;
  say(shown.map(render).join(''));
}

function addMatchArgs(host: JournalctlHost, matches: JournalMatches, matchArgs: string[], fail: Fail): void {
  let haveTerm = false;
  for (const arg of matchArgs) {
    if (arg === '+') {
      if (!haveTerm) break;
      matches.addDisjunction();
      haveTerm = false;
      continue;
    }
    if (arg.startsWith('/')) {
      const stat = host.statPath(arg);
      if ('errno' in stat) return fail("Couldn't canonicalize path", stat.errno);
      if (stat.kind === 'regular' && stat.executable) {
        if (stat.interpreter !== null) {
          matches.addMatch(`_COMM=${stat.name.slice(0, 15)}`);
          if (!stat.interpreterIsLink) matches.addMatch(`_EXE=${stat.interpreter}`);
        } else matches.addMatch(`_EXE=${arg}`);
      } else if (stat.kind === 'device') {
        for (const match of stat.matches) matches.addMatch(match);
      } else return fail(`File is neither a device node, nor regular file, nor executable: ${arg}`);
      haveTerm = true;
      continue;
    }
    if (matches.addMatch(arg) !== null) return fail(`Failed to add match '${arg}'`, 'EINVAL');
    haveTerm = true;
  }
  if (matchArgs.length > 0 && !haveTerm) return fail('"+" can only be used between terms');
}

function addUnitMatches(matches: JournalMatches, unit: string): void {
  matches.addMatch(`_SYSTEMD_UNIT=${unit}`);
  matches.addDisjunction();
  matches.addMatch('MESSAGE_ID=fc2e22bc6ee647b6b90729ab34a250b1');
  matches.addMatch('_UID=0');
  matches.addMatch(`COREDUMP_UNIT=${unit}`);
  matches.addDisjunction();
  matches.addMatch('_PID=1');
  matches.addMatch(`UNIT=${unit}`);
  matches.addDisjunction();
  matches.addMatch('_UID=0');
  matches.addMatch(`OBJECT_SYSTEMD_UNIT=${unit}`);
  if (unit.endsWith('.slice')) {
    matches.addDisjunction();
    matches.addMatch(`_SYSTEMD_SLICE=${unit}`);
  }
}

function addUserUnitMatches(matches: JournalMatches, unit: string, uid: number): void {
  matches.addMatch(`_SYSTEMD_USER_UNIT=${unit}`);
  matches.addMatch(`_UID=${uid}`);
  matches.addDisjunction();
  matches.addMatch(`USER_UNIT=${unit}`);
  matches.addMatch(`_UID=${uid}`);
  matches.addDisjunction();
  matches.addMatch('COREDUMP_USER_UNIT=' + unit);
  matches.addMatch(`_UID=${uid}`);
  matches.addDisjunction();
  matches.addMatch(`OBJECT_SYSTEMD_USER_UNIT=${unit}`);
  matches.addMatch(`_UID=${uid}`);
  if (unit.endsWith('.slice')) {
    matches.addDisjunction();
    matches.addMatch(`_SYSTEMD_USER_SLICE=${unit}`);
    matches.addMatch(`_UID=${uid}`);
  }
}

const SYSTEM_UNIT_FIELDS = ['_SYSTEMD_UNIT', 'COREDUMP_UNIT', 'UNIT', 'OBJECT_SYSTEMD_UNIT', '_SYSTEMD_SLICE'];
const USER_UNIT_FIELDS = ['_SYSTEMD_USER_UNIT', 'USER_UNIT', 'COREDUMP_USER_UNIT', 'OBJECT_SYSTEMD_USER_UNIT', '_SYSTEMD_USER_SLICE'];

function possibleUnits(all: readonly JournalRecord[], fields: string[], patterns: string[]): string[] {
  const found: string[] = [];
  const decoder = new TextDecoder();
  for (const field of fields) {
    const values: string[] = [];
    for (const record of all) for (const [name, value] of record.fields) if (name === field) {
      const rendered = decoder.decode(value);
      if (!values.includes(rendered)) values.push(rendered);
    }
    for (const value of values) {
      if (patterns.some(pattern => fnmatch(pattern.replace(/\\/g, '[\\]'), value)) && !found.includes(value)) found.push(value);
    }
  }
  return found;
}

function addUnits(all: readonly JournalRecord[], matches: JournalMatches, args: Args, fail: Fail, notice: (message: string) => void): void {
  let count = 0;
  const process = (units: string[], user: boolean): void => {
    const patterns: string[] = [];
    for (const unit of units) {
      const mangled = unitNameMangle(unit, { glob: true, warn: !args.quiet });
      for (const line of mangled.notices) notice(line);
      if (mangled.name === null) return fail('Failed to add filter for units', 'EINVAL');
      if (isGlob(mangled.name)) patterns.push(mangled.name);
      else {
        if (user) addUserUnitMatches(matches, mangled.name, 0);
        else addUnitMatches(matches, mangled.name);
        matches.addDisjunction();
        count++;
      }
    }
    if (patterns.length > 0) {
      for (const unit of possibleUnits(all, user ? USER_UNIT_FIELDS : SYSTEM_UNIT_FIELDS, patterns)) {
        if (user) addUserUnitMatches(matches, unit, 0);
        else addUnitMatches(matches, unit);
        matches.addDisjunction();
        count++;
      }
    }
  };
  process(args.systemUnits, false);
  process(args.userUnits, true);
  if ((args.systemUnits.length > 0 || args.userUnits.length > 0) && count === 0) return fail('Failed to add filter for units', 'ENODATA');
  matches.addConjunction();
}

function showEntries(
  host: JournalctlHost, args: Args, extra: Args & { regex?: RegExp }, clock: SystemdClock, sink: { write(bytes: Uint8Array): void }, say: (text: string) => void, fail: Fail,
  all: readonly JournalRecord[], matches: JournalMatches, out: ToolOutput,
): void {
  void out;
  const reader = new JournalReader(all, matches);
  let { lines } = args;
  let needSeek = false;
  let sinceSeeked = false;
  const linesNeedSeekEnd = (): boolean => lines >= 0 && !args.linesOldest;
  let cursor = args.cursor;
  let afterCursor = false;
  if (args.cursorFile !== null) {
    const content = host.readFile(args.cursorFile);
    if (content !== null && content.split('\n')[0] !== '') {
      cursor = content.split('\n')[0];
      afterCursor = true;
    } else cursor = args.cursor ?? args.afterCursor;
  } else {
    if (args.afterCursor !== null) {
      cursor = args.afterCursor;
      afterCursor = true;
    }
  }
  let positioned: boolean;
  if (cursor !== null) {
    const parsed = parseCursor(cursor);
    if (parsed === 'EINVAL') return fail('Failed to seek to cursor', 'EINVAL');
    reader.seekCursor(parsed);
    positioned = reader.step(!args.reverse);
    if (afterCursor && positioned && reader.testCursor(parsed)) positioned = reader.step(!args.reverse);
    if (!positioned) lines = 0;
  } else if (args.untilSet && (args.reverse || linesNeedSeekEnd())) {
    reader.seekRealtime(args.until);
    if (args.reverse) positioned = reader.step(false);
    else positioned = reader.previousSkip(lines) > 0;
  } else if (args.reverse) {
    reader.seekTail();
    positioned = reader.step(false);
  } else if (linesNeedSeekEnd()) {
    reader.seekTail();
    positioned = reader.previousSkip(lines) > 0;
  } else if (args.sinceSet) {
    reader.seekRealtime(args.since);
    sinceSeeked = true;
    positioned = reader.step(true);
  } else {
    reader.seekHead();
    positioned = reader.step(true);
  }
  if (!positioned) needSeek = true;

  const flags: OutputFlags = { showAll: args.all, fullWidth: args.full, utc: args.utc, truncateNewline: args.truncateNewline, noHostname: args.noHostname, catalog: args.catalog };
  const state: DisplayState = { previousRealtime: null, previousMonotonic: null, previousBootId: null };
  const catalogItems = args.catalog ? host.catalog() : null;
  const locale = host.locale();
  const context = {
    clock,
    columns: host.columns(),
    utf8Locale: locale.utf8,
    catalogBlock: (record: JournalRecord): Uint8Array | null => {
      if (catalogItems === null) return null;
      const body = catalogForRecord(catalogItems, record, locale);
      return body === null ? null : formatCatalogBlock(body, locale.utf8);
    },
  };
  let previousBoot: string | null = null;
  let shown = 0;
  while (lines < 0 || shown < lines) {
    if (needSeek && !reader.step(!args.reverse)) break;
    const record = reader.current() as JournalRecord;
    if (args.untilSet && !args.reverse && (lines < 0 || args.sinceSet)) {
      if (record.realtimeUsec > args.until) break;
    }
    if (args.sinceSet && (args.reverse || !sinceSeeked)) {
      if (record.realtimeUsec < args.since) {
        if (args.reverse) break;
        reader.seekRealtime(args.since);
        sinceSeeked = true;
        needSeek = true;
        continue;
      }
      sinceSeeked = true;
    }
    if (!args.merge && !args.quiet) {
      if (previousBoot !== null && previousBoot !== record.bootId) say(`-- Boot ${record.bootId} --\n`);
      previousBoot = record.bootId;
    }
    if (extra.regex) {
      const message = record.fields.find(([name]) => name === 'MESSAGE');
      if (message === undefined) {
        needSeek = true;
        continue;
      }
      if (!extra.regex.test(text(message[1]))) {
        needSeek = true;
        continue;
      }
    }
    const result = showJournalEntry(sink, record, args.output, flags, args.outputFields, state, context);
    needSeek = true;
    if (result.status < 0) return fail(result.error ?? 'Failed to show entry', null);
    shown++;
  }
  if (shown === 0 && !args.quiet) say('-- No entries --\n');
  updateCursor(host, args, reader, say, fail);
  if (extra.regex && shown === 0) throw new ExitSignal(1);
}

function updateCursor(host: JournalctlHost, args: Args, reader: JournalReader, say: (text: string) => void, fail: Fail): void {
  if (!args.showCursor && args.cursorFile === null) return;
  const record = reader.current();
  if (record === null) return;
  const cursor = cursorOf(record);
  if (args.showCursor) say(`-- cursor: ${cursor}\n`);
  if (args.cursorFile !== null) {
    const error = host.writeFile(args.cursorFile, `${cursor}\n`);
    if (error !== null) return fail(`Failed to write new cursor to ${args.cursorFile}`, error);
  }
}

