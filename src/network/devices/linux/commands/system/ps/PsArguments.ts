import { printFormatSpecifiers, doHelp, PROCPS_NG_VERSION, selfInfo } from './PsHelp';
import { deferSfOption, processSfOptions } from './PsSortFormat';
import { selectBitsSetup } from './PsSelect';
import type { PsState } from './PsState';
import {
  FF_Bj, FF_Bl, FF_Bs, FF_Bu, FF_Bv, FF_Fc, FF_LX, FF_Lm, FF_Uf, FF_Uj, FF_Ul, FM_F, FM_M, FM_P, FM_c, FM_j, FM_y, OUTBUF_SIZE,
  PER_BSD_h, PER_BSD_m, PER_FORCE_BSD, PER_HPUX_x, PER_OLD_m, PER_SVR4_x,
  SS_B_a, SS_B_g, SS_B_x, SS_U_a, SS_U_d, TF_B_H, TF_B_m, TF_LOOSE_TASKS, TF_MUST_USE, TF_SHOW_BOTH, TF_SHOW_PROC, TF_SHOW_TASK,
  TF_U_L, TF_U_T, TF_U_m, PsExit, type SelectionType, type SelectionNode,
} from './PsTypes';

type ArgumentKind = 'GNU' | 'END' | 'PGRP' | 'SYSV' | 'PID' | 'BSD' | 'FAIL' | 'SESS';
type ListParser = (text: string) => number | string | { readonly error: string };

const NUL = '\0';

interface Strtoul {
  readonly value: bigint;
  readonly rest: string;
}

function strtoul(text: string): Strtoul {
  let index = 0;
  while (index < text.length && /\s/.test(text[index])) index++;
  let negative = false;
  if (text[index] === '+' || text[index] === '-') {
    negative = text[index] === '-';
    index++;
  }
  let radix = 10;
  if (text[index] === '0' && (text[index + 1] === 'x' || text[index + 1] === 'X') && /[0-9a-fA-F]/.test(text[index + 2] ?? '')) {
    radix = 16;
    index += 2;
  } else if (text[index] === '0') {
    radix = 8;
  }
  const digits = radix === 16 ? /[0-9a-fA-F]/ : radix === 8 ? /[0-7]/ : /[0-9]/;
  const start = index;
  let value = 0n;
  while (index < text.length && digits.test(text[index])) {
    value = value * BigInt(radix) + BigInt(parseInt(text[index], radix));
    index++;
  }
  if (index === start) return { value: 0n, rest: text };
  const limit = (1n << 64n) - 1n;
  if (value > limit) value = limit;
  if (negative) value = ((1n << 64n) - value) & limit;
  return { value, rest: text.slice(index) };
}

function strtol(text: string): { readonly value: number; readonly rest: string } {
  const parsed = strtoul(text);
  const signed = parsed.value >= (1n << 63n) ? parsed.value - (1n << 64n) : parsed.value;
  return { value: Number(signed), rest: parsed.rest };
}

function kindOf(argument: string): ArgumentKind {
  const first = argument[0] ?? NUL;
  if (/[a-zA-Z]/.test(first)) return 'BSD';
  if (/[0-9]/.test(first)) return 'PID';
  if (first === '+') return 'SESS';
  if (first !== '-') return 'FAIL';
  const second = argument[1] ?? NUL;
  if (/[a-zA-Z]/.test(second)) return 'SYSV';
  if (/[0-9]/.test(second)) return 'PGRP';
  if (second !== '-') return 'FAIL';
  const third = argument[2] ?? NUL;
  if (/[a-zA-Z]/.test(third)) return 'GNU';
  if (third === NUL) return 'END';
  return 'FAIL';
}

export class PsArgumentParser {
  private argv: string[] = [];
  private thisArg = 0;
  private flagPtr = 0;
  private flagWord = '';
  private forceBsd = false;

  constructor(private readonly state: PsState) {}

  private get host() { return this.state.host; }

  private current(): string {
    return this.argv[this.thisArg];
  }

  private flagChar(offset = 0): string {
    return this.flagWord[this.flagPtr + offset] ?? NUL;
  }

  private exclusive(option: string): string | null {
    return this.argv.length !== 2 || this.argv[1] !== option ? `the option is exclusive: ${option}` : null;
  }

  private getOptArg(): string | null {
    if (this.flagChar(1) !== NUL) return this.flagWord.slice(this.flagPtr + 1);
    if (this.thisArg + 2 > this.argv.length) return null;
    if (this.argv[this.thisArg + 1] === '') return null;
    this.thisArg++;
    return this.argv[this.thisArg];
  }

  private parsePid(text: string): number | { readonly error: string } {
    const parsed = strtoul(text);
    if (parsed.rest !== '') return { error: 'process ID list syntax error' };
    if (parsed.value < 1n) return { error: 'process ID out of range' };
    if (parsed.value > 0x7fffffffn) return { error: 'process ID out of range' };
    return Number(parsed.value);
  }

  private parseUid(text: string): number | { readonly error: string } {
    const parsed = strtoul(text);
    let value = parsed.value;
    if (parsed.rest !== '') {
      const found = this.host.userId(text);
      if (found === null) {
        if (!this.state.negateSelection) return { error: 'user name does not exist' };
        value = (1n << 64n) - 1n;
      } else {
        value = BigInt(found);
      }
    }
    if (!this.state.negateSelection && value > 0xfffffffen) return { error: 'user ID out of range' };
    return Number(value & 0xffffffffn);
  }

  private parseGid(text: string): number | { readonly error: string } {
    const parsed = strtoul(text);
    let value = parsed.value;
    if (parsed.rest !== '') {
      const found = this.host.groupId(text);
      if (found === null) {
        if (!this.state.negateSelection) return { error: 'group name does not exist' };
        value = (1n << 64n) - 1n;
      } else {
        value = BigInt(found);
      }
    }
    if (!this.state.negateSelection && value > 0xfffffffen) return { error: 'group ID out of range' };
    return Number(value & 0xffffffffn);
  }

  private parseCmd(text: string): string {
    return text.slice(0, 63);
  }

  private parseTty(text: string): number | { readonly error: string } {
    const host = this.host;
    const found = (path: string): { readonly error: string } | number | null => {
      const status = host.statTty(path);
      if (status === null) return null;
      return status.isCharacterDevice ? status.device : { error: 'list member was not a TTY' };
    };
    if (text.startsWith('/')) {
      const result = found(text);
      return result === null ? { error: 'TTY could not be found' } : result;
    }
    for (const path of [`/dev/pts/${text}`, `/dev/${text}`, `/dev/tty${text}`, `/dev/pty${text}`, `/dev/${text}nsole`]) {
      const result = found(path);
      if (result !== null) return result;
    }
    if (text === '-') return 0;
    if (text === '?') return 0;
    if (text.length === 1 && host.statTty(text) !== null) return 0;
    return { error: 'TTY could not be found' };
  }

  private parseList(argument: string, parse: ListParser, type: SelectionType): string | null {
    let needItem = true;
    let items = 0;
    for (let index = 0; index < Math.max(argument.length, 1); index++) {
      const ch = argument[index] ?? NUL;
      if (ch === ' ' || ch === ',' || ch === '\t' || ch === NUL) {
        if (needItem) return 'improper list';
        needItem = true;
      } else {
        if (needItem) items++;
        needItem = false;
      }
    }
    if (needItem) return 'improper list';
    const values: (number | string)[] = new Array<number | string>(items);
    let remaining = items;
    let cursor = 0;
    while (remaining-- > 0) {
      const separator = argument.slice(cursor).search(/[ ,\t]/);
      const token = separator < 0 ? argument.slice(cursor) : argument.slice(cursor, cursor + separator);
      const result = parse(token);
      if (typeof result === 'object') return result.error;
      values[remaining] = result;
      cursor = separator < 0 ? argument.length : cursor + separator + 1;
    }
    this.state.selectionList.unshift({ typecode: type, values });
    return null;
  }

  private listOf(argument: string, parse: ListParser, type: SelectionType): string | null {
    return this.parseList(argument, parse, type);
  }

  private pidParser: ListParser = (text) => this.parsePid(text);
  private uidParser: ListParser = (text) => this.parseUid(text);
  private gidParser: ListParser = (text) => this.parseGid(text);
  private cmdParser: ListParser = (text) => this.parseCmd(text);
  private ttyParser: ListParser = (text) => this.parseTty(text);

  private sysvOption(): string | null {
    const state = this.state;
    this.flagWord = this.current();
    this.flagPtr = 0;
    for (;;) {
      this.flagPtr++;
      const flag = this.flagChar();
      if (flag === NUL) return null;
      let argument: string | null;
      let error: string | null;
      switch (flag) {
        case 'A':
          state.allProcesses = true;
          break;
        case 'C':
          argument = this.getOptArg();
          if (argument === null) return 'list of command names must follow -C';
          error = this.listOf(argument, this.cmdParser, 'COMM');
          return error;
        case 'D':
          argument = this.getOptArg();
          if (argument === null) return 'date format must follow -D';
          state.lstartFormat = argument;
          break;
        case 'F':
          state.formatModifiers |= FM_F;
          state.formatFlags |= FF_Uf;
          state.unixFOption = true;
          break;
        case 'G':
          argument = this.getOptArg();
          if (argument === null) return 'list of real groups must follow -G';
          return this.listOf(argument, this.gidParser, 'RGID');
        case 'H':
          state.forestType = 'u';
          break;
        case 'L':
          state.threadFlags |= TF_U_L;
          break;
        case 'M':
          state.formatModifiers |= FM_M;
          break;
        case 'N':
          state.negateSelection = true;
          break;
        case 'O':
          argument = this.getOptArg();
          if (argument === null) return 'format or sort specification must follow -O';
          deferSfOption(state, argument, 'U_O');
          return null;
        case 'P':
          state.formatModifiers |= FM_P;
          break;
        case 'T':
          state.threadFlags |= TF_U_T;
          break;
        case 'U':
          argument = this.getOptArg();
          if (argument === null) return 'list of real users must follow -U';
          return this.listOf(argument, this.uidParser, 'RUID');
        case 'V': {
          const refusal = this.exclusive('-V');
          if (refusal !== null) return refusal;
          state.output.out(PROCPS_NG_VERSION);
          throw new PsExit(0);
        }
        case 'Z':
          state.formatModifiers |= FM_M;
          break;
        case 'a':
          state.simpleSelect |= SS_U_a;
          break;
        case 'c':
          state.formatModifiers |= FM_c;
          break;
        case 'd':
          state.simpleSelect |= SS_U_d;
          break;
        case 'e':
          state.allProcesses = true;
          break;
        case 'f':
          state.formatFlags |= FF_Uf;
          state.unixFOption = true;
          break;
        case 'g':
          argument = this.getOptArg();
          if (argument === null) return 'list of session leaders OR effective group names must follow -g';
          if (this.listOf(argument, this.pidParser, 'SESS') === null) return null;
          if (this.listOf(argument, this.gidParser, 'EGID') === null) return null;
          return 'list of session leaders OR effective group IDs was invalid';
        case 'j':
          if (state.sysvJFormat !== null) state.formatFlags |= FF_Uj;
          else state.formatModifiers |= FM_j;
          break;
        case 'l':
          state.formatFlags |= FF_Ul;
          break;
        case 'm':
          state.threadFlags |= TF_U_m;
          break;
        case 'o':
          argument = this.getOptArg();
          if (argument === null) return 'format specification must follow -o';
          deferSfOption(state, argument, 'U_o');
          return null;
        case 'p':
          argument = this.getOptArg();
          if (argument === null) return 'list of process IDs must follow -p';
          return this.listOf(argument, this.pidParser, 'PID');
        case 'q':
          argument = this.getOptArg();
          if (argument === null) return 'List of process IDs must follow -q.';
          return this.listOf(argument, this.pidParser, 'PID_QUICK');
        case 's':
          argument = this.getOptArg();
          if (argument === null) return 'list of session IDs must follow -s';
          return this.listOf(argument, this.pidParser, 'SESS');
        case 't':
          argument = this.getOptArg();
          if (argument === null) return 'list of terminals (pty, tty...) must follow -t';
          return this.listOf(argument, this.ttyParser, 'TTY');
        case 'u':
          argument = this.getOptArg();
          if (argument === null) return 'list of users must follow -u';
          return this.listOf(argument, this.uidParser, 'EUID');
        case 'w':
          state.wCount++;
          break;
        case 'x':
          if (state.personality & PER_SVR4_x) {
            state.formatModifiers |= FM_y;
            break;
          }
          if (state.personality & PER_HPUX_x) {
            state.wCount += 2;
            state.unixFOption = true;
            break;
          }
          return 'must set personality to get -x option';
        case 'y':
          state.formatModifiers |= FM_y;
          break;
        case '-':
          return "embedded '-' among SysV options makes no sense";
        default:
          return 'unsupported SysV option';
      }
    }
  }

  private bsdOption(): string | null {
    const state = this.state;
    this.flagWord = this.current();
    this.flagPtr = 0;
    if (this.current()[0] === '-') {
      if (!this.forceBsd) return 'cannot happen - problem #1';
    } else {
      this.flagPtr--;
      if (state.personality & PER_FORCE_BSD) {
        if (!this.forceBsd) return 'cannot happen - problem #2';
      } else if (this.forceBsd) {
        return 'second chance parse failed, not BSD or SysV';
      }
    }
    for (;;) {
      this.flagPtr++;
      const flag = this.flagChar();
      if (flag === NUL) return null;
      let argument: string | null;
      if (flag >= '0' && flag <= '9') {
        return this.listOf(this.flagWord.slice(this.flagPtr), this.pidParser, 'PID');
      }
      switch (flag) {
        case 'H':
          state.threadFlags |= TF_B_H;
          break;
        case 'L':
          {
            const refusal = this.exclusive('L');
            if (refusal !== null) return refusal;
            printFormatSpecifiers(state);
            throw new PsExit(0);
          }
        case 'M':
          state.threadFlags |= TF_B_m;
          break;
        case 'O':
          argument = this.getOptArg();
          if (argument === null) return 'format or sort specification must follow O';
          deferSfOption(state, argument, 'B_O');
          return null;
        case 'S':
          state.includeDeadChildren = true;
          break;
        case 'T':
          state.selectionList.unshift({ typecode: 'TTY', values: [state.cachedTty] });
          break;
        case 'U':
          argument = this.getOptArg();
          if (argument === null) return 'list of users must follow U';
          return this.listOf(argument, this.uidParser, 'EUID');
        case 'V': {
          const refusal = this.exclusive('V');
          if (refusal !== null) return refusal;
          state.output.out(PROCPS_NG_VERSION);
          throw new PsExit(0);
        }
        case 'W':
          return 'obsolete W option not supported (you have a /dev/drum?)';
        case 'X':
          state.formatFlags |= FF_LX;
          break;
        case 'Z':
          state.formatModifiers |= FM_M;
          break;
        case 'a':
          state.simpleSelect |= SS_B_a;
          break;
        case 'c':
          state.bsdCOption = true;
          break;
        case 'e':
          state.bsdEOption = true;
          break;
        case 'f':
          state.forestType = 'b';
          break;
        case 'g':
          state.simpleSelect |= SS_B_g;
          break;
        case 'h':
          if (state.headerType !== 'single') return 'only one heading option may be specified';
          state.headerType = state.personality & PER_BSD_h ? 'multi' : 'none';
          break;
        case 'j':
          state.formatFlags |= FF_Bj;
          break;
        case 'k':
          argument = this.getOptArg();
          if (argument === null) return "long sort specification must follow 'k'";
          deferSfOption(state, argument, 'G_sort');
          return null;
        case 'l':
          state.formatFlags |= FF_Bl;
          break;
        case 'm':
          if (state.personality & PER_OLD_m) {
            state.formatFlags |= FF_Lm;
            break;
          }
          if (state.personality & PER_BSD_m) {
            deferSfOption(state, 'pmem', 'B_m');
            break;
          }
          state.threadFlags |= TF_B_m;
          break;
        case 'n':
          state.wchanIsNumber = true;
          state.userIsNumber = true;
          break;
        case 'o':
          argument = this.getOptArg();
          if (argument === null) return 'format specification must follow o';
          deferSfOption(state, argument, 'B_o');
          return null;
        case 'p':
          argument = this.getOptArg();
          if (argument === null) return 'list of process IDs must follow p';
          return this.listOf(argument, this.pidParser, 'PID');
        case 'q':
          argument = this.getOptArg();
          if (argument === null) return 'List of process IDs must follow q.';
          return this.listOf(argument, this.pidParser, 'PID_QUICK');
        case 'r':
          state.runningOnly = true;
          break;
        case 's':
          state.formatFlags |= FF_Bs;
          break;
        case 't':
          argument = this.getOptArg();
          if (argument === null) {
            state.selectionList.unshift({ typecode: 'TTY', values: [state.cachedTty] });
            return null;
          }
          return this.listOf(argument, this.ttyParser, 'TTY');
        case 'u':
          state.formatFlags |= FF_Bu;
          break;
        case 'v':
          state.formatFlags |= FF_Bv;
          break;
        case 'w':
          state.wCount++;
          break;
        case 'x':
          state.simpleSelect |= SS_B_x;
          break;
        case '-':
          return "embedded '-' among BSD options makes no sense";
        default:
          return 'unsupported option (BSD syntax)';
      }
    }
  }

  private grabGnuArg(): string | null {
    const flag = this.flagChar();
    if (flag === '=' || flag === ':') {
      this.flagPtr++;
      return this.flagChar() !== NUL ? this.flagWord.slice(this.flagPtr) : null;
    }
    if (flag !== NUL) return null;
    if (this.thisArg + 2 > this.argv.length) return null;
    if (this.argv[this.thisArg + 1] === '') return null;
    this.thisArg++;
    return this.argv[this.thisArg];
  }

  private gnuOption(): string | null {
    const state = this.state;
    this.flagWord = this.current();
    const text = this.current().slice(2);
    const nameLength = text.search(/[:=]/) < 0 ? text.length : text.search(/[:=]/);
    if (nameLength > 15) return 'unknown gnu long option';
    const name = text.slice(0, nameLength);
    this.flagPtr = 2 + nameLength;
    const hasArgument = text.length > nameLength;
    let argument: string | null;
    switch (name) {
      case 'Group':
        argument = this.grabGnuArg();
        if (argument === null) return 'list of real groups must follow --Group';
        return this.listOf(argument, this.gidParser, 'RGID');
      case 'User':
        argument = this.grabGnuArg();
        if (argument === null) return 'list of real users must follow --User';
        return this.listOf(argument, this.uidParser, 'RUID');
      case 'cols':
      case 'width':
      case 'columns': {
        argument = this.grabGnuArg();
        if (argument !== null && argument !== '') {
          const parsed = strtol(argument);
          if (parsed.rest === '' && parsed.value > 0 && parsed.value < 2000000000) {
            state.screenCols = parsed.value;
            return null;
          }
        }
        return 'number of columns must follow --cols, --width, or --columns';
      }
      case 'cumulative':
        if (hasArgument) return 'option --cumulative does not take an argument';
        state.includeDeadChildren = true;
        return null;
      case 'date-format':
        argument = this.grabGnuArg();
        if (argument === null) return 'date format must follow --date-format';
        state.lstartFormat = argument;
        return null;
      case 'deselect':
        if (hasArgument) return 'option --deselect does not take an argument';
        state.negateSelection = true;
        return null;
      case 'no-header':
      case 'no-headers':
      case 'no-heading':
      case 'no-headings':
      case 'noheader':
      case 'noheaders':
      case 'noheading':
      case 'noheadings':
        if (hasArgument) return 'option --no-heading does not take an argument';
        if (state.headerType !== 'single') return 'only one heading option may be specified';
        state.headerType = 'none';
        return null;
      case 'header':
      case 'headers':
      case 'heading':
      case 'headings':
        if (hasArgument) return 'option --heading does not take an argument';
        if (state.headerType !== 'single') return 'only one heading option may be specified';
        state.headerType = 'multi';
        return null;
      case 'forest':
        if (hasArgument) return 'option --forest does not take an argument';
        state.forestType = 'g';
        return null;
      case 'format':
        argument = this.grabGnuArg();
        if (argument === null) return 'format specification must follow --format';
        deferSfOption(state, argument, 'G_format');
        return null;
      case 'group':
        argument = this.grabGnuArg();
        if (argument === null) return 'list of effective groups must follow --group';
        return this.listOf(argument, this.gidParser, 'EGID');
      case 'help':
        doHelp(state, this.grabGnuArg(), 0);
        return null;
      case 'info': {
        const refusal = this.exclusive('--info');
        if (refusal !== null) return refusal;
        selfInfo(state);
        throw new PsExit(0);
      }
      case 'pid':
        argument = this.grabGnuArg();
        if (argument === null) return 'list of process IDs must follow --pid';
        return this.listOf(argument, this.pidParser, 'PID');
      case 'quick-pid':
        argument = this.grabGnuArg();
        if (argument === null) return 'List of process IDs must follow --quick-pid.';
        return this.listOf(argument, this.pidParser, 'PID_QUICK');
      case 'ppid':
        argument = this.grabGnuArg();
        if (argument === null) return 'list of process IDs must follow --ppid';
        return this.listOf(argument, this.pidParser, 'PPID');
      case 'rows':
      case 'lines': {
        argument = this.grabGnuArg();
        if (argument !== null && argument !== '') {
          const parsed = strtol(argument);
          if (parsed.rest === '' && parsed.value > 0 && parsed.value < 2000000000) {
            state.screenRows = parsed.value;
            return null;
          }
        }
        return 'number of rows must follow --rows or --lines';
      }
      case 'sid':
        argument = this.grabGnuArg();
        if (argument === null) return 'some sid thing(s) must follow --sid';
        return this.listOf(argument, this.pidParser, 'SESS');
      case 'signames':
        state.signalNames = true;
        return null;
      case 'sort':
        argument = this.grabGnuArg();
        if (argument === null) return 'long sort specification must follow --sort';
        deferSfOption(state, argument, 'G_sort');
        return null;
      case 'tty':
        argument = this.grabGnuArg();
        if (argument === null) return 'list of ttys must follow --tty';
        return this.listOf(argument, this.ttyParser, 'TTY');
      case 'user':
        argument = this.grabGnuArg();
        if (argument === null) return 'list of effective users must follow --user';
        return this.listOf(argument, this.uidParser, 'EUID');
      case 'version': {
        const refusal = this.exclusive('--version');
        if (refusal !== null) return refusal;
        state.output.out(PROCPS_NG_VERSION);
        throw new PsExit(0);
      }
      case 'context':
        state.formatFlags |= FF_Fc;
        return null;
      default:
        return 'unknown gnu long option';
    }
  }

  private trailingPids(): string | null {
    const state = this.state;
    const rest = this.argv.slice(this.thisArg);
    this.thisArg = this.argv.length - 1;
    const pids: number[] = [];
    const groups: number[] = [];
    const sessions: number[] = [];
    for (const data of rest) {
      const first = data[0] ?? NUL;
      const body = first === '-' || first === '+' ? data.slice(1) : data;
      const parsed = this.parsePid(body);
      if (typeof parsed === 'object') return parsed.error;
      (first === '-' ? groups : first === '+' ? sessions : pids).push(parsed);
    }
    const node = (typecode: SelectionType, values: number[]): SelectionNode => ({ typecode, values });
    if (pids.length > 0) state.selectionList.unshift(node('PID', pids));
    if (groups.length > 0) state.selectionList.unshift(node('PGRP', groups));
    if (sessions.length > 0) state.selectionList.unshift(node('SESS', sessions));
    return null;
  }

  private bsdBranch(check: boolean): string | null {
    if (check && this.forceBsd && !(this.state.personality & PER_FORCE_BSD)) return 'way bad';
    this.state.preferBsdDefaults = true;
    return this.bsdOption();
  }

  private allOptions(): string | null {
    for (;;) {
      this.thisArg++;
      if (this.thisArg >= this.argv.length) return null;
      let error: string | null;
      switch (kindOf(this.current())) {
        case 'GNU':
          error = this.gnuOption();
          break;
        case 'SYSV':
          error = this.forceBsd ? this.bsdBranch(false) : this.sysvOption();
          break;
        case 'BSD':
          error = this.bsdBranch(true);
          break;
        case 'PGRP':
        case 'SESS':
        case 'PID':
          this.state.preferBsdDefaults = true;
          error = this.trailingPids();
          break;
        case 'END':
        case 'FAIL':
          return 'garbage option';
        default:
          return 'something broke';
      }
      if (error !== null) return error;
    }
  }

  private chooseDimensions(): void {
    const state = this.state;
    if (state.wCount > 0 && state.screenCols < 132) state.screenCols = 132;
    if (state.wCount > 1) state.screenCols = OUTBUF_SIZE;
  }

  private threadOptionCheck(): string | null {
    const state = this.state;
    if (state.threadFlags === 0) {
      state.threadFlags = TF_SHOW_PROC;
      return null;
    }
    if (state.forestType !== '') return 'thread display conflicts with forest display';
    if ((state.threadFlags & TF_B_H) && (state.threadFlags & (TF_B_m | TF_U_m))) return "thread flags conflict; can't use H with m or -m";
    if ((state.threadFlags & TF_B_m) && (state.threadFlags & TF_U_m)) return "thread flags conflict; can't use both m and -m";
    if ((state.threadFlags & TF_U_L) && (state.threadFlags & TF_U_T)) return "thread flags conflict; can't use both -L and -T";
    if (state.threadFlags & TF_B_H) state.threadFlags |= TF_SHOW_PROC | TF_LOOSE_TASKS;
    if (state.threadFlags & (TF_B_m | TF_U_m)) state.threadFlags |= TF_SHOW_PROC | TF_SHOW_TASK | TF_SHOW_BOTH;
    if (state.threadFlags & (TF_U_T | TF_U_L)) {
      if (state.threadFlags & (TF_B_m | TF_U_m | TF_B_H)) state.threadFlags |= TF_MUST_USE;
      else state.threadFlags |= TF_SHOW_TASK;
    }
    return null;
  }

  private pass(): string | null {
    let error = this.allOptions();
    if (error !== null) return error;
    error = this.threadOptionCheck();
    if (error !== null) return error;
    error = processSfOptions(this.state);
    if (error !== null) return error;
    return selectBitsSetup(this.state);
  }

  parse(args: readonly string[]): void {
    const state = this.state;
    this.argv = ['ps', ...args];
    this.thisArg = 0;
    this.forceBsd = false;
    let first: string | null = null;
    if (state.personality & PER_FORCE_BSD) {
      first = 'forced';
    } else {
      first = this.pass();
      if (first === null) {
        this.chooseDimensions();
        return;
      }
    }
    state.resetGlobal();
    state.wCount = 0;
    state.resetSortFormat();
    state.formatFlags = 0;
    this.thisArg = 0;
    this.forceBsd = true;
    state.preferBsdDefaults = true;
    if (!((PER_OLD_m | PER_BSD_m) & state.personality)) state.personality |= PER_OLD_m;
    const second = this.pass();
    if (second === null) {
      this.chooseDimensions();
      return;
    }
    state.wCount = 0;
    state.output.err(`error: ${state.personality & PER_FORCE_BSD ? second : first}\n`);
    doHelp(state, null, 1);
  }
}

