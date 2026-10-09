import { END_OF_OPTIONS, GnuGetopt, type LongOption } from '../audit/tools/GnuGetopt';
import type { HostClock } from '../audit/tools/AuditHostClock';
import { ExitSignal, ToolOutput, type ToolResult } from '../audit/tools/AuditToolHost';

export const LASTLOG_RECORD_SIZE = 292;
export const LASTLOG_FILE = '/var/log/lastlog';
const LINE_SIZE = 32;
const HOST_SIZE = 256;
const IPV6_WIDTH = 25 + 1 + 16;
const DAY = 24 * 60 * 60;
const E_BAD_ARG = 3;

export interface PasswdEntry {
  name: string;
  uid: number;
}

export type LastlogFile = { kind: 'file'; bytes: Uint8Array } | { kind: 'error'; message: string };

export interface LastlogHost {
  nowSec(): number;
  clock: HostClock;
  passwd(): PasswdEntry[];
  loginDefs(): string | null;
  openLastlog(write: boolean): LastlogFile;
  writeLastlog(bytes: Uint8Array): boolean;
  changeRoot(directory: string): string | null;
  directoryExists(directory: string): boolean;
}

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'before', hasArg: 1, val: 98 },
  { name: 'clear', hasArg: 0, val: 67 },
  { name: 'help', hasArg: 0, val: 104 },
  { name: 'root', hasArg: 1, val: 82 },
  { name: 'set', hasArg: 0, val: 83 },
  { name: 'time', hasArg: 1, val: 116 },
  { name: 'user', hasArg: 1, val: 117 },
];

const USAGE = (program: string): string => `Usage: ${program} [options]

Options:
  -b, --before DAYS             print only lastlog records older than DAYS
  -C, --clear                   clear lastlog record of an user (usable only with -u)
  -h, --help                    display this help message and exit
  -R, --root CHROOT_DIR         directory to chroot into
  -S, --set                     set lastlog record to current time (usable only with -u)
  -t, --time DAYS               print only lastlog records more recent than DAYS
  -u, --user LOGIN              print lastlog record of the specified LOGIN

`;

function strtoul(text: string, base: number): { value: bigint; end: number; overflow: boolean } {
  let i = 0;
  while (i < text.length && ' \t\n\v\f\r'.includes(text[i])) i++;
  let negative = false;
  if (text[i] === '+' || text[i] === '-') {
    negative = text[i] === '-';
    i++;
  }
  let radix = base;
  if ((radix === 0 || radix === 16) && text[i] === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X') && /[0-9a-fA-F]/.test(text[i + 2] ?? '')) {
    i += 2;
    radix = 16;
  } else if (radix === 0) radix = text[i] === '0' ? 8 : 10;
  const first = i;
  let value = 0n;
  const big = BigInt(radix);
  for (; i < text.length; i++) {
    const digit = parseInt(text[i], 36);
    if (Number.isNaN(digit) || digit >= radix) break;
    value = value * big + BigInt(digit);
  }
  if (i === first) return { value: 0n, end: 0, overflow: false };
  const max = 18446744073709551615n;
  if (value > max) return { value: max, end: i, overflow: true };
  if (negative) value = (max + 1n - value) & max;
  return { value, end: i, overflow: false };
}

function getulong(text: string): bigint | null {
  const parsed = strtoul(text, 0);
  if (text === '' || parsed.end !== text.length || parsed.overflow) return null;
  return parsed.value;
}

interface Range {
  min: bigint;
  hasMin: boolean;
  max: bigint;
  hasMax: boolean;
}

function getrange(text: string): Range | null {
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
  const out: Range = { min: 0n, hasMin: false, max: 0n, hasMax: false };
  if (text[0] === '-') {
    if (!isDigit(text[1])) return null;
    const parsed = strtoul(text.slice(1), 10);
    if (parsed.end !== text.length - 1 || parsed.overflow) return null;
    out.hasMax = true;
    out.max = parsed.value;
    return out;
  }
  const first = strtoul(text, 10);
  if (first.overflow) return null;
  const rest = text.slice(first.end);
  if (rest === '') {
    out.hasMin = out.hasMax = true;
    out.min = out.max = first.value;
    return out;
  }
  if (rest[0] !== '-') return null;
  const tail = rest.slice(1);
  out.hasMin = true;
  out.min = first.value;
  if (tail === '') return out;
  if (!isDigit(tail[0])) return null;
  const second = strtoul(tail, 10);
  if (second.end !== tail.length || second.overflow) return null;
  out.hasMax = true;
  out.max = second.value;
  return out;
}

function loginDefsValue(content: string | null, item: string): string | null {
  if (content === null) return null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (match && match[1] === item) return match[2].replace(/^"(.*)"$/, '$1');
  }
  return null;
}

function cString(bytes: Uint8Array, limit: number): string {
  let out = '';
  for (let i = 0; i < Math.min(bytes.length, limit); i++) {
    if (bytes[i] === 0) break;
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function strftime(epoch: number, clock: HostClock): string {
  const tm = clock.localTime(epoch);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const two = (n: number): string => String(n).padStart(2, '0');
  const offset = Math.round(Date.UTC(tm.year, tm.mon, tm.mday, tm.hour, tm.min, tm.sec) / 1000) - epoch;
  const minutes = Math.abs(Math.trunc(offset / 60));
  const zone = `${offset < 0 ? '-' : '+'}${two(Math.trunc(minutes / 60))}${two(minutes % 60)}`;
  return `${days[tm.wday]} ${months[tm.mon]} ${String(tm.mday).padStart(2, ' ')} ${two(tm.hour)}:${two(tm.min)}:${two(tm.sec)} ${zone} ${tm.year}`;
}

export function runLastlog(host: LastlogHost, argv: string[], program = 'lastlog'): ToolResult {
  const out = new ToolOutput();
  let exitCode = 0;
  const exit = (code: number): never => { throw new ExitSignal(code); };
  const usage = (status: number): never => {
    if (status === 0) out.printf(USAGE(program)); else out.eprintf(USAGE(program));
    return exit(status);
  };
  try {
    let newRoot: string | null = null;
    for (let i = 0; i < argv.length; i++) {
      const value = argv[i];
      let given: string | null = null;
      if (value === '--root' || value === '-R') {
        if (i + 1 === argv.length) { out.eprintf(`${program}: option '${value}' requires an argument\n`); exit(E_BAD_ARG); }
        given = argv[++i];
      } else if (value.startsWith('--root=')) given = value.slice(7);
      if (given !== null) {
        if (newRoot !== null) { out.eprintf(`${program}: multiple --root options\n`); exit(E_BAD_ARG); }
        newRoot = given;
      }
    }
    if (newRoot !== null) {
      if (newRoot[0] !== '/') { out.eprintf(`${program}: invalid chroot path '${newRoot}', only absolute paths are supported.\n`); exit(E_BAD_ARG); }
      if (!host.directoryExists(newRoot)) { out.eprintf(`${program}: cannot access chroot directory ${newRoot}: No such file or directory\n`); exit(E_BAD_ARG); }
      const failure = host.changeRoot(newRoot);
      if (failure !== null) { out.eprintf(`${program}: ${failure}\n`); exit(E_BAD_ARG); }
    }

    let userMin = 0n;
    let hasMin = false;
    let userMax = 0n;
    let hasMax = false;
    let uflg = false;
    let tflg = false;
    let bflg = false;
    let Cflg = false;
    let Sflg = false;
    let seconds = 0n;
    let inverseSeconds = 0n;
    const getopt = new GnuGetopt([program, ...argv], 'b:ChR:St:u:', LONG_OPTIONS, { program, write: (text) => out.eprintf(text) });
    for (;;) {
      const { code, optarg } = getopt.next();
      if (code === END_OF_OPTIONS) break;
      switch (code) {
        case 98: {
          const days = getulong(optarg ?? '');
          if (days === null) { out.eprintf(`${program}: invalid numeric argument '${optarg}'\n`); exit(1); }
          inverseSeconds = BigInt.asIntN(64, (days as bigint) * BigInt(DAY));
          bflg = true;
          break;
        }
        case 67: Cflg = true; break;
        case 104: usage(0); break;
        case 82: break;
        case 83: Sflg = true; break;
        case 116: {
          const days = getulong(optarg ?? '');
          if (days === null) { out.eprintf(`${program}: invalid numeric argument '${optarg}'\n`); exit(1); }
          seconds = BigInt.asIntN(64, (days as bigint) * BigInt(DAY));
          tflg = true;
          break;
        }
        case 117: {
          uflg = true;
          const found = host.passwd().find((entry) => entry.name === optarg);
          if (found) {
            userMin = userMax = BigInt(found.uid);
            hasMin = hasMax = true;
          } else {
            const range = getrange(optarg ?? '');
            if (range === null) { out.eprintf(`${program}: Unknown user or range: ${optarg}\n`); exit(1); }
            ({ min: userMin, hasMin, max: userMax, hasMax } = range as Range);
          }
          break;
        }
        default: usage(1);
      }
    }
    if (getopt.optind < getopt.argv.length) {
      out.eprintf(`${program}: unexpected argument: ${getopt.argv[getopt.optind]}\n`);
      usage(1);
    }
    if (Cflg && Sflg) {
      out.eprintf(`${program}: Option -C cannot be used together with option -S\n`);
      usage(1);
    }
    if ((Cflg || Sflg) && !uflg) {
      out.eprintf(`${program}: Options -C and -S require option -u to specify the user\n`);
      usage(1);
    }

    const opened = host.openLastlog(Cflg || Sflg);
    if (opened.kind === 'error') { out.eprintf(`${LASTLOG_FILE}: ${opened.message}\n`); exit(1); }
    let bytes = (opened as { kind: 'file'; bytes: Uint8Array }).bytes;
    const entries = host.passwd();
    const defsValue = loginDefsValue(host.loginDefs(), 'LASTLOG_UID_MAX');
    let uidMax = 0xffffffffn;
    if (defsValue !== null) {
      const parsed = getulong(defsValue);
      if (parsed === null) out.eprintf(`configuration error - cannot parse LASTLOG_UID_MAX value: '${defsValue}'`);
      else uidMax = parsed;
    }
    const now = BigInt(host.nowSec());

    if (Cflg || Sflg) {
      if (!uflg) return { stdout: out.stdout, stderr: out.stderr, exitCode: 0, interleaved: out.interleaved };
      if ((hasMin && userMin > uidMax) || (hasMax && userMax > uidMax)) {
        out.eprintf(`${program}: Selected uid(s) are higher than LASTLOG_UID_MAX (${uidMax}),\n\tthey will not be updated.\n`);
        return { stdout: out.stdout, stderr: out.stderr, exitCode: 0, interleaved: out.interleaved };
      }
      const targets = hasMin && hasMax && userMin === userMax
        ? entries.filter((entry) => BigInt(entry.uid) === userMin).slice(0, 1)
        : entries.filter((entry) => !((hasMin && BigInt(entry.uid) < userMin) || (hasMax && BigInt(entry.uid) > userMax)));
      for (const entry of targets) {
        const offset = entry.uid * LASTLOG_RECORD_SIZE;
        if (bytes.length < offset + LASTLOG_RECORD_SIZE) {
          const grown = new Uint8Array(offset + LASTLOG_RECORD_SIZE);
          grown.set(bytes);
          bytes = grown;
        }
        const record = bytes.subarray(offset, offset + LASTLOG_RECORD_SIZE);
        record.fill(0);
        if (Sflg) {
          new DataView(record.buffer, record.byteOffset, record.byteLength).setInt32(0, Number(now), true);
          record.set(new TextEncoder().encode('lastlog'), 4);
          record.set(new TextEncoder().encode('localhost'), 4 + LINE_SIZE);
        }
      }
      if (!host.writeLastlog(bytes)) { out.eprintf(`${program}: Failed to update the lastlog file\n`); exit(1); }
      return { stdout: out.stdout, stderr: out.stderr, exitCode: 0, interleaved: out.interleaved };
    }

    if ((hasMin && userMin > uidMax) || (hasMax && userMax > uidMax)) {
      out.eprintf(`${program}: Selected uid(s) are higher than LASTLOG_UID_MAX (${uidMax}),\n\tthe output might be incorrect.\n`);
    }
    let once = false;
    const printOne = (entry: PasswdEntry): void => {
      const offset = entry.uid * LASTLOG_RECORD_SIZE;
      let record = new Uint8Array(LASTLOG_RECORD_SIZE);
      if (offset + LASTLOG_RECORD_SIZE <= bytes.length) record = bytes.subarray(offset, offset + LASTLOG_RECORD_SIZE);
      const time = new DataView(record.buffer, record.byteOffset, record.byteLength).getInt32(0, true);
      if (tflg && now - BigInt(time) > seconds) return;
      if (bflg && now - BigInt(time) < inverseSeconds) return;
      if (!once) {
        out.printf(`Username         Port     From${' '.repeat(IPV6_WIDTH - 3)}Latest\n`);
        once = true;
      }
      const stamp = time === 0 ? '**Never logged in**' : strftime(time, host.clock);
      const line = cString(record.subarray(4, 4 + LINE_SIZE), 8);
      const from = cString(record.subarray(4 + LINE_SIZE, 4 + LINE_SIZE + HOST_SIZE), HOST_SIZE);
      out.printf(`${pad(entry.name, 16)} ${pad(line, 8)} ${pad(from, IPV6_WIDTH)}${stamp}\n`);
    };
    if (uflg && hasMin && hasMax && userMin === userMax) {
      const found = entries.find((entry) => BigInt(entry.uid) === userMin);
      if (found) printOne(found);
    } else {
      for (const entry of entries) {
        const uid = BigInt(entry.uid);
        if (uflg && ((hasMin && uid < userMin) || (hasMax && uid > userMax))) continue;
        if (!uflg && uid > uidMax) continue;
        printOne(entry);
      }
    }
  } catch (error) {
    if (error instanceof ExitSignal) exitCode = error.code;
    else throw error;
  }
  return { stdout: out.stdout, stderr: out.stderr, exitCode, interleaved: out.interleaved };
}
