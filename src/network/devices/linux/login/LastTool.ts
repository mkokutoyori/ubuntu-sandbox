import { inetNtop6 } from '../audit/tools/AuditSearchParser';
import type { HostClock } from '../audit/tools/AuditHostClock';
import { END_OF_OPTIONS, GnuGetopt, type LongOption } from '../audit/tools/GnuGetopt';
import { ExitSignal, ToolOutput, type ToolResult } from '../audit/tools/AuditToolHost';
import { ctimeText, isoTimestamp, parseTimestamp } from './UtilLinuxTime';
import { UT, UTMPX_SIZE, Utmpx } from './UtmpxRecord';

export const UTIL_LINUX_VERSION = 'util-linux 2.39.3';

const LAST_LOGIN_LEN = 8;
const LAST_DOMAIN_LEN = 16;
const FINAL_SIZE = 512;

const enum Listing { Crash = 1, Down, Normal, Now, Reboot, Phantom, TimeChange }
const enum TimeFormat { None = 0, Short, Ctime, Iso8601, Hhmm }

interface TimeFormatSpec {
  name: string;
  inLen: number;
  inFmt: number;
  outLen: number;
  outFmt: number;
}

const TIME_FORMATS: readonly TimeFormatSpec[] = [
  { name: 'notime', inLen: 0, inFmt: 0, outLen: 0, outFmt: 0 },
  { name: 'short', inLen: 16, inFmt: TimeFormat.Ctime, outLen: 7, outFmt: TimeFormat.Hhmm },
  { name: 'full', inLen: 24, inFmt: TimeFormat.Ctime, outLen: 26, outFmt: TimeFormat.Ctime },
  { name: 'iso', inLen: 25, inFmt: TimeFormat.Iso8601, outLen: 27, outFmt: TimeFormat.Iso8601 },
];

export type LastFile =
  | { kind: 'file'; bytes: Uint8Array; ctime: number }
  | { kind: 'directory'; ctime: number }
  | { kind: 'error'; message: string };

export interface LastHost {
  openFile(path: string): LastFile;
  nowSec(): number;
  bootTimeSec(): number;
  clock: HostClock;
  userExists(name: string): { uid: number } | null;
  loginUid(pid: number): number | null | undefined;
  deviceOwner(line: string): number | null;
  reverseName(address: Uint8Array): string | null;
  utf8(): boolean;
}

interface Control {
  lastb: boolean;
  extended: boolean;
  showHost: boolean;
  altList: boolean;
  useDns: boolean;
  useIp: boolean;
  nameLen: number;
  domainLen: number;
  maxRecords: number;
  show: string[] | null;
  since: number;
  until: number;
  present: number;
  timeFormat: number;
}

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'limit', hasArg: 1, val: 110 },
  { name: 'help', hasArg: 0, val: 104 },
  { name: 'file', hasArg: 1, val: 102 },
  { name: 'nohostname', hasArg: 0, val: 82 },
  { name: 'version', hasArg: 0, val: 86 },
  { name: 'hostlast', hasArg: 0, val: 97 },
  { name: 'since', hasArg: 1, val: 115 },
  { name: 'until', hasArg: 1, val: 116 },
  { name: 'present', hasArg: 1, val: 112 },
  { name: 'system', hasArg: 0, val: 120 },
  { name: 'dns', hasArg: 0, val: 100 },
  { name: 'ip', hasArg: 0, val: 105 },
  { name: 'fulltimes', hasArg: 0, val: 70 },
  { name: 'fullnames', hasArg: 0, val: 119 },
  { name: 'time-format', hasArg: 1, val: 128 },
];

const OPTSTRING = 'hVf:n:RxadFit:p:s:0123456789w';
const OPT_TIME_FORMAT = 128;

const isSpaceByte = (b: number): boolean => b === 32 || (b >= 9 && b <= 13);
const isPrintByte = (b: number): boolean => b >= 32 && b < 127;

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  let out = '';
  for (let i = 0; i < (end < 0 ? bytes.length : end); i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function precision(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function fieldSample(text: string, width: number, limit: number): string {
  return padRight(precision(text, limit), width);
}

function sameLine(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return false;
    if (a[i] === 0) return true;
  }
  return true;
}

function writeCString(target: Uint8Array, text: string): void {
  for (let i = 0; i < text.length; i++) target[i] = text.charCodeAt(i) & 0xff;
  target[text.length] = 0;
}

class LastRun {
  private recordsDone = 0;
  private currentDate = 0;
  private lastDate = 0;
  private readonly bytesOut: number[] = [];

  constructor(
    private readonly host: LastHost,
    private readonly ctl: Control,
    private readonly out: ToolOutput,
    private readonly program: string,
  ) {}

  private warn(message: string): void {
    this.flush();
    this.out.eprintf(`${this.program}: ${message}\n`);
  }

  private fail(message: string): never {
    this.warn(message);
    throw new ExitSignal(1);
  }

  private flush(): void {
    if (this.bytesOut.length === 0) return;
    this.out.printf(new TextDecoder().decode(Uint8Array.from(this.bytesOut)));
    this.bytesOut.length = 0;
  }

  finish(): void {
    this.flush();
  }

  print(text: string): void {
    for (let i = 0; i < text.length; i++) this.bytesOut.push(text.charCodeAt(i) & 0xff);
  }

  private timeText(format: number, epoch: number): string {
    switch (format) {
      case TimeFormat.None: return '';
      case TimeFormat.Hhmm: {
        const tm = this.host.clock.localTime(epoch);
        return `${String(tm.hour).padStart(2, '0')}:${String(tm.min).padStart(2, '0')}`;
      }
      case TimeFormat.Ctime: return ctimeText(epoch, this.host.clock);
      default: return isoTimestamp(epoch, this.host.clock);
    }
  }

  private dnsLookup(address: Uint8Array): string | null {
    const word = (i: number): number => new DataView(address.buffer, address.byteOffset, 16).getUint32(i * 4, true);
    const mapped = word(0) === 0 && word(1) === 0 && word(2) === 0xffff0000;
    const v4 = mapped || (word(1) === 0 && word(2) === 0 && word(3) === 0);
    if (!this.ctl.useIp) {
      const name = this.host.reverseName(address);
      if (name !== null) return name;
    }
    if (v4) {
      const at = mapped ? 12 : 0;
      return `${address[at]}.${address[at + 1]}.${address[at + 2]}.${address[at + 3]}`;
    }
    const view = new DataView(address.buffer, address.byteOffset, 16);
    return inetNtop6(Array.from({ length: 8 }, (_, i) => view.getUint16(i * 2, false)));
  }

  private careful(final: string): void {
    const utf8 = this.host.utf8();
    for (let i = 0; i < final.length; i++) {
      const b = final.charCodeAt(i);
      if (b === 10) { this.bytesOut.push(10); continue; }
      if (isPrintByte(b) || b === 7 || b === 9 || b === 13) { this.bytesOut.push(b); continue; }
      if (b >= 0x80) {
        if (utf8) {
          const length = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 ? 2 : 0;
          let valid = length > 0 && i + length <= final.length;
          for (let k = 1; valid && k < length; k++) valid = (final.charCodeAt(i + k) & 0xc0) === 0x80;
          if (valid) {
            for (let k = 0; k < length; k++) this.bytesOut.push(final.charCodeAt(i + k));
            i += length - 1;
            continue;
          }
        }
        this.print(`\\${b.toString(8).padStart(3, ' ')}`);
        continue;
      }
      this.bytesOut.push(42, b ^ 0x40);
    }
  }

  private list(entry: Utmpx, logoutTime: number, what: Listing): boolean {
    const lineBytes = entry.field('line');
    let utline = cString(lineBytes.subarray(0, 32));
    if (utline.startsWith('ftp') && /[0-9]/.test(utline[3] ?? '')) utline = utline.slice(0, 3);
    if (utline.startsWith('uucp') && /[0-9]/.test(utline[4] ?? '')) utline = utline.slice(0, 4);
    const user = cString(entry.field('user'));
    if (this.ctl.show) {
      const wanted = this.ctl.show.some((name) => user === name.slice(0, 32)
        || utline === name || (utline.startsWith('tty') && utline.slice(3) === name));
      if (!wanted) return false;
    }
    const format = TIME_FORMATS[this.ctl.timeFormat];
    const utmpTime = entry.seconds;
    if (this.ctl.present) {
      if (this.ctl.present < utmpTime) return false;
      if (logoutTime > 0 && logoutTime < this.ctl.present) return false;
    }
    const loginText = this.timeText(format.inFmt, utmpTime);
    const secs = logoutTime - utmpTime;
    const mins = Math.trunc(secs / 60) % 60;
    const hours = Math.trunc(secs / 3600) % 24;
    const days = Math.trunc(secs / 86400);
    let logoutText = `- ${this.timeText(format.outFmt, logoutTime)}`;
    let length: string;
    const two = (value: number): string => String(value).padStart(2, '0');
    if (logoutTime === this.currentDate) {
      if (this.ctl.timeFormat > TimeFormat.Short) {
        logoutText = '  still running';
        length = '';
      } else {
        logoutText = '  still';
        length = 'running';
      }
    } else if (days !== 0) {
      length = `(${days}+${two(Math.abs(hours))}:${two(Math.abs(mins))})`;
    } else if (hours !== 0) {
      length = ` (${two(hours)}:${two(Math.abs(mins))})`;
    } else if (secs >= 0) {
      length = ` (${two(hours)}:${two(mins)})`;
    } else {
      length = ` (-00:${two(Math.abs(mins))})`;
    }
    switch (what) {
      case Listing.Crash: logoutText = '- crash'; break;
      case Listing.Down: logoutText = '- down '; break;
      case Listing.Now:
        if (this.ctl.timeFormat > TimeFormat.Short) {
          logoutText = '  still logged in';
          length = '';
        } else {
          logoutText = '  still';
          length = 'logged in';
        }
        break;
      case Listing.Phantom:
        if (this.ctl.timeFormat > TimeFormat.Short) {
          logoutText = '  gone - no logout';
          length = '';
        } else if (this.ctl.timeFormat === TimeFormat.Short) {
          logoutText = '   gone';
          length = '- no logout';
        } else {
          logoutText = '';
          length = 'no logout';
        }
        break;
      case Listing.TimeChange:
        logoutText = '';
        length = '';
        break;
      default:
        break;
    }
    let domain = '';
    let resolved: string | null = null;
    if (this.ctl.useDns || this.ctl.useIp) resolved = this.dnsLookup(entry.address);
    domain = resolved ?? precision(cString(entry.field('host')), 255);
    const userField = cString(entry.field('user'));
    const fixedName = padRight(precision(userField, this.ctl.nameLen), LAST_LOGIN_LEN);
    let final: string;
    const inCol = fieldSample(loginText, format.inLen, format.inLen);
    const outCol = fieldSample(logoutText, format.outLen, format.outLen);
    if (this.ctl.showHost) {
      if (!this.ctl.altList) {
        final = `${fixedName} ${fieldSample(utline, 12, 12)} ${fieldSample(domain, 16, this.ctl.domainLen)} ${inCol} ${outCol} ${length}\n`;
      } else {
        final = `${fixedName} ${fieldSample(utline, 12, 12)} ${inCol} ${outCol} ${fieldSample(length, 12, 12)} ${domain}\n`;
      }
    } else {
      final = `${fixedName} ${fieldSample(utline, 12, 12)} ${inCol} ${outCol} ${length}\n`;
    }
    const overflow = final.length >= FINAL_SIZE;
    if (overflow) final = final.slice(0, FINAL_SIZE - 1);
    let end = final.length;
    let p = end;
    while (p > 0 && isSpaceByte(final.charCodeAt(p - 1))) p--;
    end = p > 0 ? p : 0;
    final = `${final.slice(0, end)}\n`;
    this.careful(final);
    if (overflow) this.bytesOut.push(10);
    this.recordsDone++;
    return this.ctl.maxRecords !== 0 && this.ctl.maxRecords <= this.recordsDone;
  }

  private isPhantom(entry: Utmpx, bootTime: number): boolean {
    if (entry.seconds < bootTime) return true;
    const user = cString(entry.field('user'));
    const account = this.host.userExists(user);
    if (!account) return true;
    const loginUid = this.host.loginUid(entry.pid >>> 0);
    if (loginUid !== undefined) {
      if (loginUid === null) return true;
      return account.uid !== loginUid;
    }
    const owner = this.host.deviceOwner(cString(entry.field('line')));
    if (owner === null) return true;
    return account.uid !== owner;
  }

  processFile(filename: string): void {
    let lastDown = this.host.nowSec();
    this.lastDate = this.currentDate = lastDown;
    let lastRunLevelChange = lastDown;
    const opened = this.host.openFile(filename);
    if (opened.kind === 'error') this.fail(`cannot open ${filename}: ${opened.message}`);
    const bytes = opened.kind === 'file' ? opened.bytes : new Uint8Array(0);
    if (opened.kind === 'directory') this.warn(`cannot read ${filename}: Is a directory`);
    let beginTime: number;
    let quit = false;
    if (bytes.length >= UTMPX_SIZE) beginTime = new Utmpx(bytes.subarray(0, UTMPX_SIZE)).seconds;
    else {
      beginTime = opened.ctime;
      quit = true;
    }
    let position = bytes.length;
    const nextRecord = (): Utmpx | null => {
      if (position - UTMPX_SIZE < 0) return null;
      position -= UTMPX_SIZE;
      return new Utmpx(bytes.subarray(position, position + UTMPX_SIZE));
    };

    const ulist: Utmpx[] = [];
    let lastBoot = 0;
    let whyDown = 0;
    let down = false;
    const bootTime = this.host.bootTimeSec();
    while (!quit) {
      const entry = nextRecord();
      if (entry === null) break;
      if (this.ctl.since && entry.seconds < this.ctl.since) continue;
      if (this.ctl.until && this.ctl.until < entry.seconds) continue;
      this.lastDate = entry.seconds;
      if (this.ctl.lastb) {
        quit = this.list(entry, entry.seconds, Listing.Normal);
        continue;
      }
      const lineText = entry.field('line');
      const userText = entry.field('user');
      if (lineText[0] === 0x7e) {
        const user = cString(userText);
        if (user.startsWith('shutdown')) entry.type = UT.SHUTDOWN_TIME;
        else if (user.startsWith('reboot')) entry.type = UT.BOOT_TIME;
        else if (user.startsWith('runlevel')) entry.type = UT.RUN_LVL;
      } else {
        if (entry.type !== UT.DEAD_PROCESS && userText[0] !== 0 && lineText[0] !== 0 && !cString(userText).startsWith('LOGIN')) {
          entry.type = UT.USER_PROCESS;
        }
        if (userText[0] === 0) entry.type = UT.DEAD_PROCESS;
        if (cString(userText).startsWith('date')) {
          if (lineText[0] === 0x7c) entry.type = UT.OLD_TIME;
          if (lineText[0] === 0x7b) entry.type = UT.NEW_TIME;
        }
      }
      switch (entry.type) {
        case UT.SHUTDOWN_TIME:
          if (this.ctl.extended) {
            writeCString(lineText, 'system down');
            quit = this.list(entry, lastBoot, Listing.Normal);
          }
          lastDown = lastRunLevelChange = entry.seconds;
          down = true;
          break;
        case UT.OLD_TIME:
        case UT.NEW_TIME:
          if (this.ctl.extended) {
            writeCString(lineText, entry.type === UT.NEW_TIME ? 'new time' : 'old time');
            quit = this.list(entry, lastDown, Listing.TimeChange);
          }
          break;
        case UT.BOOT_TIME:
          writeCString(lineText, 'system boot');
          quit = this.list(entry, lastDown, Listing.Reboot);
          lastBoot = entry.seconds;
          down = true;
          break;
        case UT.RUN_LVL: {
          const level = entry.pid & 255;
          if (this.ctl.extended) {
            writeCString(lineText, `(to lvl ${String.fromCharCode(level)})`);
            quit = this.list(entry, lastRunLevelChange, Listing.Normal);
          }
          if (level === 0x30 || level === 0x36) {
            lastDown = entry.seconds;
            down = true;
            entry.type = UT.SHUTDOWN_TIME;
          }
          lastRunLevelChange = entry.seconds;
          break;
        }
        case UT.USER_PROCESS:
        case UT.DEAD_PROCESS: {
          if (entry.type === UT.USER_PROCESS) {
            let shown = false;
            for (let i = 0; i < ulist.length;) {
              if (sameLine(ulist[i].field('line'), lineText)) {
                if (!shown) {
                  quit = this.list(entry, ulist[i].seconds, Listing.Normal);
                  shown = true;
                }
                ulist.splice(i, 1);
              } else i++;
            }
            if (!shown) {
              const what = lastBoot === 0 ? (this.isPhantom(entry, bootTime) ? Listing.Phantom : Listing.Now) : whyDown;
              quit = this.list(entry, lastBoot, what);
            }
          }
          if (lineText[0] === 0) break;
          ulist.unshift(new Utmpx(entry.bytes));
          break;
        }
        case UT.EMPTY:
        case UT.INIT_PROCESS:
        case UT.LOGIN_PROCESS:
        case UT.ACCOUNTING:
          break;
        default:
          this.warn(`unrecognized ut_type: ${entry.type}`);
      }
      if (down) {
        lastBoot = entry.seconds;
        whyDown = entry.type === UT.SHUTDOWN_TIME ? Listing.Down : Listing.Crash;
        ulist.length = 0;
        down = false;
      }
    }
    if (this.ctl.timeFormat !== TimeFormat.None) {
      const format = TIME_FORMATS[this.ctl.timeFormat];
      const base = filename.replace(/\/+$/, '');
      const name = base.slice(base.lastIndexOf('/') + 1);
      this.print(`\n${name} begins ${this.timeText(format.inFmt, beginTime)}\n`);
    }
  }
}

const USAGE_BODY = (program: string, file: string): string => [
  '',
  'Usage:',
  ` ${program} [options] [<username>...] [<tty>...]`,
  '',
  'Show a listing of last logged in users.',
  '',
  'Options:',
  ' -<number>            how many lines to show',
  ' -a, --hostlast       display hostnames in the last column',
  ' -d, --dns            translate the IP number back into a hostname',
  ` -f, --file <file>    use a specific file instead of ${file}`,
  ' -F, --fulltimes      print full login and logout times and dates',
  ' -i, --ip             display IP numbers in numbers-and-dots notation',
  ' -n, --limit <number> how many lines to show',
  " -R, --nohostname     don't display the hostname field",
  ' -s, --since <time>   display the lines since the specified time',
  ' -t, --until <time>   display the lines until the specified time',
  ' -p, --present <time> display who were present at the specified time',
  ' -w, --fullnames      display full user and domain names',
  ' -x, --system         display system shutdown entries and run level changes',
  '     --time-format <format>  show timestamps in the specified <format>:',
  '                               notime|short|full|iso',
  '',
  ' -h, --help           display this help',
  ' -V, --version        display version',
  '',
  'For more details see last(1).',
  '',
].join('\n');

function strtoimax(text: string): { ok: boolean; value: number; range: boolean } {
  if (text === '') return { ok: false, value: 0, range: false };
  const match = /^[ \t\n\v\f\r]*([+-]?)(\d+)/.exec(text);
  if (!match) return { ok: false, value: 0, range: false };
  const rest = text.slice(match[0].length);
  const big = BigInt(match[2]) * (match[1] === '-' ? -1n : 1n);
  if (big > 9223372036854775807n || big < -9223372036854775808n) return { ok: false, value: 0, range: true };
  if (rest !== '') return { ok: false, value: 0, range: false };
  return { ok: true, value: Number(big), range: false };
}

export function runLast(host: LastHost, argv: string[], program = 'last'): ToolResult {
  const out = new ToolOutput();
  const args = [program, ...argv];
  const ctl: Control = {
    lastb: program === 'lastb', extended: false, showHost: true, altList: false, useDns: false, useIp: false,
    nameLen: LAST_LOGIN_LEN, domainLen: LAST_DOMAIN_LEN, maxRecords: 0, show: null, since: 0, until: 0, present: 0,
    timeFormat: TimeFormat.Short,
  };
  const run = new LastRun(host, ctl, out, program);
  let exitCode = 0;
  const die = (message: string): never => {
    out.eprintf(`${program}: ${message}\n`);
    throw new ExitSignal(1);
  };
  const tryHelp = (): never => {
    out.eprintf(`Try '${program} --help' for more information.\n`);
    throw new ExitSignal(1);
  };
  try {
    const files: string[] = [];
    const getopt = new GnuGetopt(args, OPTSTRING, LONG_OPTIONS, { program, write: (text) => out.eprintf(text) });
    let fullTimes = false;
    let timeFormatGiven = false;
    for (;;) {
      const { code, optarg } = getopt.next();
      if (code === END_OF_OPTIONS) break;
      if (code === 70 || code === OPT_TIME_FORMAT) {
        if (code === 70) fullTimes = true; else timeFormatGiven = true;
        if (fullTimes && timeFormatGiven) die('mutually exclusive arguments: --fulltimes --time-format');
      }
      const timeValue = (value: string): number => {
        const parsed = parseTimestamp(value, host.nowSec(), host.clock);
        if (parsed === null) die(`invalid time value "${value}"`);
        return Math.floor((parsed as number) / 1_000_000);
      };
      switch (code) {
        case 104:
          out.printf(USAGE_BODY(program, ctl.lastb ? '/var/log/btmp' : '/var/log/wtmp'));
          return { stdout: out.stdout, stderr: out.stderr, exitCode: 0, interleaved: out.interleaved };
        case 86:
          out.printf(`${program} from ${UTIL_LINUX_VERSION}\n`);
          return { stdout: out.stdout, stderr: out.stderr, exitCode: 0, interleaved: out.interleaved };
        case 82: ctl.showHost = false; break;
        case 120: ctl.extended = true; break;
        case 110: {
          const parsed = strtoimax(optarg ?? '');
          const message = 'failed to parse number';
          if (parsed.ok && (parsed.value < -2147483648 || parsed.value > 2147483647)) die(`${message}: '${optarg}': Numerical result out of range`);
          if (!parsed.ok) die(parsed.range ? `${message}: '${optarg}': Numerical result out of range` : `${message}: '${optarg}'`);
          ctl.maxRecords = parsed.value >>> 0;
          break;
        }
        case 102: files.push(optarg ?? ''); break;
        case 100: ctl.useDns = true; break;
        case 105: ctl.useIp = true; break;
        case 97: ctl.altList = true; break;
        case 70: ctl.timeFormat = TimeFormat.Ctime; break;
        case 112: ctl.present = timeValue(optarg ?? ''); break;
        case 115: ctl.since = timeValue(optarg ?? ''); break;
        case 116: ctl.until = timeValue(optarg ?? ''); break;
        case 119:
          if (ctl.nameLen < 32) ctl.nameLen = 32;
          if (ctl.domainLen < 256) ctl.domainLen = 256;
          break;
        case OPT_TIME_FORMAT: {
          const index = TIME_FORMATS.findIndex((format) => format.name === optarg);
          if (index < 0) die(`unknown time format: ${optarg}`);
          ctl.timeFormat = index;
          break;
        }
        default:
          if (code >= 48 && code <= 57) {
            ctl.maxRecords = (Math.imul(10, ctl.maxRecords) + code - 48) >>> 0;
            break;
          }
          tryHelp();
      }
    }
    if (getopt.optind < args.length) ctl.show = args.slice(getopt.optind);
    if (files.length === 0) files.push(ctl.lastb ? '/var/log/btmp' : '/var/log/wtmp');
    for (const file of files) run.processFile(file);
  } catch (error) {
    if (error instanceof ExitSignal) exitCode = error.code;
    else throw error;
  }
  run.finish();
  return { stdout: out.stdout, stderr: out.stderr, exitCode, interleaved: out.interleaved };
}
