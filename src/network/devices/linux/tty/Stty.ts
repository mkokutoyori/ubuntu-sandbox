import { integerArgument } from './GnuIntegers';
import { quote, quoteFilename } from './GnuQuoting';
import { parseCommandLine } from './SttyCommandLine';
import { STTY_HELP_LINES, STTY_VERSION_LINES } from './SttyHelp';
import { CONTROL_INFO, MODE_INFO, OMIT, REV, SANE_SET, SANE_UNSET, type ControlInfo, type ModeInfo } from './SttyModes';
import { baudCode, baudValue, CC, CFLAG, IFLAG, LFLAG, NCCS, OFLAG, POSIX_VDISABLE, Termios } from './Termios';
import type { TtyDevice } from './TtyDevice';

export interface TtyCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type SttyErrno = 'ENOENT' | 'EACCES' | 'ENXIO' | 'ENOTTY';

export interface SttyHost {
  readonly standardInput: TtyDevice | null;
  readonly columns: number;
  openDevice(path: string): TtyDevice | { readonly errno: SttyErrno };
}

const ERRNO_TEXT: Readonly<Record<SttyErrno | 'EINVAL', string>> = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  ENXIO: 'No such device or address',
  ENOTTY: 'Inappropriate ioctl for device',
  EINVAL: 'Invalid argument',
};

const INT_MAX = 2147483647n;
const UNSIGNED_CHAR_MAX = 255n;
const UNSIGNED_LONG_MAX = (1n << 64n) - 1n;
const TRY_HELP = "Try 'stty --help' for more information.";

class SttyExit extends Error {
  constructor(readonly status: number) {
    super('stty exit');
  }
}

function word(value: number): number {
  return value >>> 0;
}

function bytesOf(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function visible(ch: number): string {
  if (ch === POSIX_VDISABLE) return '<undef>';
  if (ch >= 32) {
    if (ch < 127) return String.fromCharCode(ch);
    if (ch === 127) return '^?';
    if (ch >= 128 + 32) return `M-${ch < 128 + 127 ? String.fromCharCode(ch - 128) : '^?'}`;
    return `M-^${String.fromCharCode(ch - 128 + 64)}`;
  }
  return `^${String.fromCharCode(ch + 64)}`;
}

function strtoulHex(text: string, from: number): { value: bigint; end: number; overflow: boolean } {
  let index = from;
  while (index < text.length && (text[index] === ' ' || (text[index] >= '\t' && text[index] <= '\r'))) index++;
  let negative = false;
  if (text[index] === '+' || text[index] === '-') {
    negative = text[index] === '-';
    index++;
  }
  if (text[index] === '0' && 'xX'.includes(text[index + 1] ?? ' ') && /[0-9a-fA-F]/.test(text[index + 2] ?? ' ')) index += 2;
  const start = index;
  while (index < text.length && /[0-9a-fA-F]/.test(text[index])) index++;
  if (index === start) return { value: 0n, end: from, overflow: false };
  const value = BigInt(`0x${text.slice(start, index)}`);
  if (value > UNSIGNED_LONG_MAX) return { value: UNSIGNED_LONG_MAX, end: index, overflow: true };
  return { value: negative ? (UNSIGNED_LONG_MAX + 1n - value) & UNSIGNED_LONG_MAX : value, end: index, overflow: false };
}

class SttyRun {
  stdout = '';
  stderr = '';
  private maxCol = 80;
  private currentCol = 0;
  private drain = true;
  private lastInputBaud: number | null = null;
  private lastOutputBaud: number | null = null;
  private requireSetAttr = false;
  private device: TtyDevice | null;
  private deviceName = 'standard input';

  constructor(private readonly host: SttyHost) {
    this.device = host.standardInput;
  }

  private error(status: number, errno: SttyErrno | 'EINVAL' | 'EOVERFLOW' | null, message: string): void {
    const suffix = errno === null ? '' : `: ${errno === 'EOVERFLOW' ? 'Value too large for defined data type' : ERRNO_TEXT[errno]}`;
    this.stderr += `stty: ${message}${suffix}\n`;
    if (status !== 0) throw new SttyExit(status);
  }

  private usageFailure(): never {
    this.stderr += `${TRY_HELP}\n`;
    throw new SttyExit(1);
  }

  private wrapf(message: string): void {
    if (this.currentCol > 0) {
      if (this.maxCol - this.currentCol <= message.length) {
        this.stdout += '\n';
        this.currentCol = 0;
      } else {
        this.stdout += ' ';
        this.currentCol++;
      }
    }
    this.stdout += message;
    this.currentCol += message.length;
  }

  run(args: readonly string[]): number {
    try {
      return this.main(args);
    } catch (thrown) {
      if (thrown instanceof SttyExit) return thrown.status;
      throw thrown;
    }
  }

  private main(args: readonly string[]): number {
    const parsed = parseCommandLine(args);
    if (parsed.kind === 'help') {
      this.stdout += `${STTY_HELP_LINES.join('\n')}\n`;
      return 0;
    }
    if (parsed.kind === 'version') {
      this.stdout += `${STTY_VERSION_LINES.join('\n')}\n`;
      return 0;
    }
    if (parsed.kind === 'fatal') this.error(1, null, parsed.message);
    if (parsed.kind !== 'parsed') return 1;
    const { verbose, recoverable, fileName, noArguments, settings } = parsed;
    if (verbose && recoverable) {
      this.error(1, null, 'the options for verbose and stty-readable output styles are\nmutually exclusive');
    }
    if (!noArguments && (verbose || recoverable)) this.error(1, null, 'when specifying an output style, modes may not be set');
    this.deviceName = fileName ?? 'standard input';
    if (!noArguments && !verbose && !recoverable) this.applySettings(true, settings, new Termios());
    let failure: SttyErrno | null = null;
    if (fileName !== null) {
      const opened = this.host.openDevice(fileName);
      if ('errno' in opened) failure = opened.errno;
      else this.device = opened;
    }
    if (failure !== null) this.error(1, failure, quoteFilename(this.deviceName));
    if (this.device === null) this.error(1, 'ENOTTY', quoteFilename(this.deviceName));
    const device = this.device as TtyDevice;
    const mode = device.tcgetattr();
    if (verbose || recoverable || noArguments) {
      this.maxCol = this.host.columns;
      this.currentCol = 0;
      if (verbose) this.displayAll(mode);
      else if (recoverable) this.displayRecoverable(mode);
      else this.displayChanged(mode);
      return 0;
    }
    this.requireSetAttr = false;
    this.applySettings(false, settings, mode);
    if (this.requireSetAttr) {
      const outcome = device.tcsetattr(mode);
      if (outcome === 'EINVAL') this.error(1, 'EINVAL', quoteFilename(this.deviceName));
      if (!mode.equals(device.tcgetattr())) {
        this.error(1, null, `${quoteFilename(this.deviceName)}: unable to perform all requested operations`);
      }
    }
    return 0;
  }

  private checkArgument(settings: readonly (string | null)[], k: number, name: string): void {
    if (k === settings.length - 1 || settings[k + 1] === null) {
      this.stderr += `stty: missing argument to ${quote(name)}\n`;
      this.usageFailure();
    }
  }

  private integerArg(text: string, maximum: bigint): bigint {
    const parsed = integerArgument(text, maximum);
    if (parsed.kind === 'ok') return parsed.value;
    const suffix = parsed.reason === '' ? '' : `: ${parsed.reason}`;
    this.stderr += `stty: invalid integer argument: ${quote(text)}${suffix}\n`;
    throw new SttyExit(1);
  }

  private applySettings(checking: boolean, settings: readonly (string | null)[], mode: Termios): void {
    for (let k = 1; k < settings.length; k++) {
      let arg = settings[k];
      if (arg === null) continue;
      let reversed = false;
      let matchFound = false;
      if (arg.startsWith('-')) {
        arg = arg.slice(1);
        reversed = true;
      }
      if (arg === 'drain') {
        this.drain = !reversed;
        continue;
      }
      const info = MODE_INFO.find((candidate) => candidate.name === arg);
      if (info !== undefined) {
        matchFound = this.setMode(info, reversed, mode);
        this.requireSetAttr = true;
      }
      if (!matchFound && reversed) {
        this.stderr += `stty: invalid argument ${quote(`-${arg}`)}\n`;
        this.usageFailure();
      }
      if (!matchFound) {
        const control = CONTROL_INFO.find((candidate) => candidate.name === arg);
        if (control !== undefined) {
          this.checkArgument(settings, k, arg);
          matchFound = true;
          k++;
          this.setControlChar(control, settings[k] as string, mode);
          this.requireSetAttr = true;
        }
      }
      if (matchFound) continue;
      k = this.applySpecial(checking, settings, k, arg, mode);
    }
    if (checking) this.checkSpeed(mode);
  }

  private applySpecial(checking: boolean, settings: readonly (string | null)[], k: number, arg: string, mode: Termios): number {
    if (arg === 'ispeed' || arg === 'ospeed') {
      this.checkArgument(settings, k, arg);
      k++;
      const value = settings[k] as string;
      if (baudCode(value) === null) {
        this.stderr += `stty: invalid ${arg} ${quote(value)}\n`;
        this.usageFailure();
      }
      this.setSpeed(arg === 'ispeed' ? 'input' : 'output', value, mode);
      if (!checking) this.requireSetAttr = true;
    } else if (arg === 'rows' || arg === 'cols' || arg === 'columns') {
      this.checkArgument(settings, k, arg);
      k++;
      if (!checking) {
        const value = Number(this.integerArg(settings[k] as string, INT_MAX));
        this.setWindowSize(arg === 'rows' ? value : -1, arg === 'rows' ? -1 : value);
      }
    } else if (arg === 'size') {
      if (!checking) {
        this.maxCol = this.host.columns;
        this.currentCol = 0;
        this.displayWindowSize(false);
      }
    } else if (arg === 'line') {
      this.checkArgument(settings, k, arg);
      k++;
      const value = this.integerArg(settings[k] as string, UNSIGNED_LONG_MAX);
      mode.line = Number(value & 0xffn);
      if (BigInt(mode.line) !== value) this.error(0, null, `invalid line discipline ${quote(settings[k] as string)}`);
      this.requireSetAttr = true;
    } else if (arg === 'speed') {
      if (!checking) {
        this.maxCol = this.host.columns;
        this.displaySpeed(mode, false);
      }
    } else if (baudCode(arg) !== null) {
      this.setSpeed('both', arg, mode);
      if (!checking) this.requireSetAttr = true;
    } else {
      if (!this.recoverMode(arg, mode)) {
        this.stderr += `stty: invalid argument ${quote(arg)}\n`;
        this.usageFailure();
      }
      this.requireSetAttr = true;
    }
    return k;
  }

  private setSpeed(which: 'input' | 'output' | 'both', text: string, mode: Termios): void {
    const code = baudCode(text) as number;
    if (which === 'input' || which === 'both') {
      this.lastInputBaud = code;
      mode.setInputSpeed(code);
    }
    if (which === 'output' || which === 'both') {
      this.lastOutputBaud = code;
      mode.setOutputSpeed(code);
    }
  }

  private checkSpeed(mode: Termios): void {
    if (this.lastInputBaud === null || this.lastOutputBaud === null) return;
    if (mode.inputSpeed() !== this.lastInputBaud || mode.outputSpeed() !== this.lastOutputBaud) {
      this.error(1, null, `asymmetric input (${baudValue(this.lastInputBaud)}), output (${baudValue(this.lastOutputBaud)}) speeds not supported`);
    }
  }

  private setControlChar(info: ControlInfo, arg: string, mode: Termios): void {
    const bytes = bytesOf(arg);
    let value: number;
    if (info.name === 'min' || info.name === 'time') value = Number(this.integerArg(arg, UNSIGNED_CHAR_MAX));
    else if (bytes.length <= 1) value = bytes.length === 0 ? 0 : bytes[0];
    else if (arg === '^-' || arg === 'undef') value = POSIX_VDISABLE;
    else if (bytes[0] === 0x5e) value = bytes[1] === 0x3f ? 127 : bytes[1] & ~0o140;
    else value = Number(this.integerArg(arg, UNSIGNED_CHAR_MAX));
    mode.cc[info.offset] = value;
  }

  private setWindowSize(rows: number, cols: number): void {
    const device = this.device as TtyDevice;
    const size = device.windowSize;
    device.windowSize = { rows: rows >= 0 ? rows & 0xffff : size.rows, cols: cols >= 0 ? cols & 0xffff : size.cols };
  }

  private displayWindowSize(fancy: boolean): void {
    const size = (this.device as TtyDevice).windowSize;
    this.wrapf(fancy ? `rows ${size.rows}; columns ${size.cols};` : `${size.rows} ${size.cols}\n`);
    if (!fancy) this.currentCol = 0;
  }

  private displaySpeed(mode: Termios, fancy: boolean): void {
    const input = mode.inputSpeed();
    const output = mode.outputSpeed();
    if (input === 0 || input === output) this.wrapf(fancy ? `speed ${baudValue(output)} baud;` : `${baudValue(output)}\n`);
    else {
      this.wrapf(fancy ? `ispeed ${baudValue(input)} baud; ospeed ${baudValue(output)} baud;` : `${baudValue(input)} ${baudValue(output)}\n`);
    }
    if (!fancy) this.currentCol = 0;
  }

  private flagWord(type: ModeInfo['type'], mode: Termios): number {
    if (type === 'control') return mode.cflag;
    if (type === 'input') return mode.iflag;
    if (type === 'output') return mode.oflag;
    return mode.lflag;
  }

  private displayChanged(mode: Termios): void {
    this.displaySpeed(mode, true);
    this.wrapf(`line = ${mode.line};`);
    this.stdout += '\n';
    this.currentCol = 0;
    let emptyLine = true;
    for (const control of CONTROL_INFO) {
      if (control.name === 'min') break;
      if (mode.cc[control.offset] === control.saneValue) continue;
      if (control.name === 'flush') continue;
      emptyLine = false;
      this.wrapf(`${control.name} = ${visible(mode.cc[control.offset])};`);
    }
    if ((mode.lflag & LFLAG.ICANON) === 0) {
      this.wrapf(`min = ${mode.cc[CC.VMIN]}; time = ${mode.cc[CC.VTIME]};\n`);
    } else if (!emptyLine) this.stdout += '\n';
    this.currentCol = 0;
    emptyLine = true;
    let previous: ModeInfo['type'] = 'control';
    for (const info of MODE_INFO) {
      if ((info.flags & OMIT) !== 0) continue;
      if (info.type !== previous) {
        if (!emptyLine) {
          this.stdout += '\n';
          this.currentCol = 0;
          emptyLine = true;
        }
        previous = info.type;
      }
      const mask = info.mask !== 0 ? info.mask : info.bits;
      if (word(this.flagWord(info.type, mode) & mask) === word(info.bits)) {
        if ((info.flags & SANE_UNSET) !== 0) {
          this.wrapf(info.name);
          emptyLine = false;
        }
      } else if ((info.flags & (SANE_SET | REV)) === (SANE_SET | REV)) {
        this.wrapf(`-${info.name}`);
        emptyLine = false;
      }
    }
    if (!emptyLine) this.stdout += '\n';
    this.currentCol = 0;
  }

  private displayAll(mode: Termios): void {
    this.displaySpeed(mode, true);
    this.displayWindowSize(true);
    this.wrapf(`line = ${mode.line};`);
    this.stdout += '\n';
    this.currentCol = 0;
    for (const control of CONTROL_INFO) {
      if (control.name === 'min') break;
      if (control.name === 'flush') continue;
      this.wrapf(`${control.name} = ${visible(mode.cc[control.offset])};`);
    }
    this.wrapf(`min = ${mode.cc[CC.VMIN]}; time = ${mode.cc[CC.VTIME]};`);
    if (this.currentCol !== 0) this.stdout += '\n';
    this.currentCol = 0;
    let previous: ModeInfo['type'] = 'control';
    for (const info of MODE_INFO) {
      if ((info.flags & OMIT) !== 0) continue;
      if (info.type !== previous) {
        this.stdout += '\n';
        this.currentCol = 0;
        previous = info.type;
      }
      const mask = info.mask !== 0 ? info.mask : info.bits;
      if (word(this.flagWord(info.type, mode) & mask) === word(info.bits)) this.wrapf(info.name);
      else if ((info.flags & REV) !== 0) this.wrapf(`-${info.name}`);
    }
    this.stdout += '\n';
    this.currentCol = 0;
  }

  private displayRecoverable(mode: Termios): void {
    const flags = [mode.iflag, mode.oflag, mode.cflag, mode.lflag].map((value) => word(value).toString(16)).join(':');
    this.stdout += `${flags}:${Array.from(mode.cc.slice(0, NCCS), (value) => value.toString(16)).join(':')}\n`;
  }

  private recoverMode(arg: string, mode: Termios): boolean {
    const flags: number[] = [];
    let position = 0;
    for (let i = 0; i < 4; i++) {
      const scanned = strtoulHex(arg, position);
      if (scanned.overflow || arg[scanned.end] !== ':' || scanned.end === position || scanned.value > 0xffffffffn) return false;
      flags.push(Number(scanned.value));
      position = scanned.end + 1;
    }
    mode.iflag = flags[0];
    mode.oflag = flags[1];
    mode.cflag = flags[2];
    mode.lflag = flags[3];
    for (let i = 0; i < NCCS; i++) {
      const scanned = strtoulHex(arg, position);
      const delimiter = i < NCCS - 1 ? ':' : undefined;
      if (scanned.overflow || arg[scanned.end] !== delimiter || scanned.end === position || scanned.value > 0xffn) return false;
      mode.cc[i] = Number(scanned.value);
      position = scanned.end + 1;
    }
    return true;
  }

  private setMode(info: ModeInfo, reversed: boolean, mode: Termios): boolean {
    if (reversed && (info.flags & REV) === 0) return false;
    if (info.type === 'combination') {
      this.setCombination(info.name, reversed, mode);
      return true;
    }
    const current = this.flagWord(info.type, mode);
    const updated = reversed ? current & ~info.mask & ~info.bits : (current & ~info.mask) | info.bits;
    if (info.type === 'control') mode.cflag = word(updated);
    else if (info.type === 'input') mode.iflag = word(updated);
    else if (info.type === 'output') mode.oflag = word(updated);
    else mode.lflag = word(updated);
    return true;
  }

  private setCombination(name: string, reversed: boolean, mode: Termios): void {
    const cflag = (change: (value: number) => number): void => {
      mode.cflag = word(change(mode.cflag));
    };
    const iflag = (change: (value: number) => number): void => {
      mode.iflag = word(change(mode.iflag));
    };
    const oflag = (change: (value: number) => number): void => {
      mode.oflag = word(change(mode.oflag));
    };
    const lflag = (change: (value: number) => number): void => {
      mode.lflag = word(change(mode.lflag));
    };
    if (name === 'evenp' || name === 'parity') {
      if (reversed) cflag((v) => (v & ~CFLAG.PARENB & ~CFLAG.CSIZE) | CFLAG.CS8);
      else cflag((v) => (v & ~CFLAG.PARODD & ~CFLAG.CSIZE) | CFLAG.PARENB | CFLAG.CS7);
    } else if (name === 'oddp') {
      if (reversed) cflag((v) => (v & ~CFLAG.PARENB & ~CFLAG.CSIZE) | CFLAG.CS8);
      else cflag((v) => (v & ~CFLAG.CSIZE) | CFLAG.CS7 | CFLAG.PARODD | CFLAG.PARENB);
    } else if (name === 'nl') {
      if (reversed) {
        iflag((v) => (v | IFLAG.ICRNL) & ~IFLAG.INLCR & ~IFLAG.IGNCR);
        oflag((v) => (v | OFLAG.ONLCR) & ~OFLAG.OCRNL & ~OFLAG.ONLRET);
      } else {
        iflag((v) => v & ~IFLAG.ICRNL);
        oflag((v) => v & ~OFLAG.ONLCR);
      }
    } else if (name === 'ek') {
      mode.cc[CC.VERASE] = 127;
      mode.cc[CC.VKILL] = 21;
    } else if (name === 'sane') {
      this.saneMode(mode);
    } else if (name === 'cbreak') {
      lflag((v) => (reversed ? v | LFLAG.ICANON : v & ~LFLAG.ICANON));
    } else if (name === 'pass8') {
      if (reversed) {
        cflag((v) => (v & ~CFLAG.CSIZE) | CFLAG.CS7 | CFLAG.PARENB);
        iflag((v) => v | IFLAG.ISTRIP);
      } else {
        cflag((v) => (v & ~CFLAG.PARENB & ~CFLAG.CSIZE) | CFLAG.CS8);
        iflag((v) => v & ~IFLAG.ISTRIP);
      }
    } else if (name === 'litout') {
      if (reversed) {
        cflag((v) => (v & ~CFLAG.CSIZE) | CFLAG.CS7 | CFLAG.PARENB);
        iflag((v) => v | IFLAG.ISTRIP);
        oflag((v) => v | OFLAG.OPOST);
      } else {
        cflag((v) => (v & ~CFLAG.PARENB & ~CFLAG.CSIZE) | CFLAG.CS8);
        iflag((v) => v & ~IFLAG.ISTRIP);
        oflag((v) => v & ~OFLAG.OPOST);
      }
    } else if (name === 'raw' || name === 'cooked') {
      if ((name === 'raw' && reversed) || (name === 'cooked' && !reversed)) {
        iflag((v) => v | IFLAG.BRKINT | IFLAG.IGNPAR | IFLAG.ISTRIP | IFLAG.ICRNL | IFLAG.IXON);
        oflag((v) => v | OFLAG.OPOST);
        lflag((v) => v | LFLAG.ISIG | LFLAG.ICANON);
      } else {
        mode.iflag = 0;
        oflag((v) => v & ~OFLAG.OPOST);
        lflag((v) => v & ~(LFLAG.ISIG | LFLAG.ICANON | LFLAG.XCASE));
        mode.cc[CC.VMIN] = 1;
        mode.cc[CC.VTIME] = 0;
      }
    } else if (name === 'decctlq') {
      iflag((v) => (reversed ? v | IFLAG.IXANY : v & ~IFLAG.IXANY));
    } else if (name === 'tabs') {
      oflag((v) => (v & ~OFLAG.TABDLY) | (reversed ? OFLAG.TAB3 : OFLAG.TAB0));
    } else if (name === 'lcase' || name === 'LCASE') {
      if (reversed) {
        lflag((v) => v & ~LFLAG.XCASE);
        iflag((v) => v & ~IFLAG.IUCLC);
        oflag((v) => v & ~OFLAG.OLCUC);
      } else {
        lflag((v) => v | LFLAG.XCASE);
        iflag((v) => v | IFLAG.IUCLC);
        oflag((v) => v | OFLAG.OLCUC);
      }
    } else if (name === 'crt') {
      lflag((v) => v | LFLAG.ECHOE | LFLAG.ECHOCTL | LFLAG.ECHOKE);
    } else if (name === 'dec') {
      mode.cc[CC.VINTR] = 3;
      mode.cc[CC.VERASE] = 127;
      mode.cc[CC.VKILL] = 21;
      lflag((v) => v | LFLAG.ECHOE | LFLAG.ECHOCTL | LFLAG.ECHOKE);
      iflag((v) => v & ~IFLAG.IXANY);
    }
  }

  private saneMode(mode: Termios): void {
    for (const control of CONTROL_INFO) mode.cc[control.offset] = control.saneValue;
    for (const info of MODE_INFO) {
      if (info.type === 'combination') continue;
      const current = this.flagWord(info.type, mode);
      let updated = current;
      if ((info.flags & SANE_SET) !== 0) updated = (current & ~info.mask) | info.bits;
      else if ((info.flags & SANE_UNSET) !== 0) updated = current & ~info.mask & ~info.bits;
      else continue;
      if (info.type === 'control') mode.cflag = word(updated);
      else if (info.type === 'input') mode.iflag = word(updated);
      else if (info.type === 'output') mode.oflag = word(updated);
      else mode.lflag = word(updated);
    }
  }
}

export function runStty(args: readonly string[], host: SttyHost): TtyCommandResult {
  const run = new SttyRun(host);
  const exitCode = run.run(args);
  return { stdout: run.stdout, stderr: run.stderr, exitCode };
}
