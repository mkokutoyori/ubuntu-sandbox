import {
  DISABLED, ENV, LM, MODE, NSLC, SLC, SLC_NAMES, TELCMD, TELOPT, TELQUAL, TELOPT_NAMES, commandName, optionName,
} from './TelnetNames';
import type {
  NetkitAddress, NetkitTelnetHost, NetkitTelnetTerminal, NetkitTelnetTransport,
} from './NetkitTelnetHost';

const { IAC, DONT, DO, WONT, WILL, SB, SE } = TELCMD;

const MY_STATE_WILL = 0x01;
const MY_WANT_STATE_WILL = 0x02;
const MY_STATE_DO = 0x04;
const MY_WANT_STATE_DO = 0x08;

const HELP_INDENT = 8;
const STDIO_BLOCK = 4096;
const AMBIGUOUS = Symbol('ambiguous');
const HELP = Symbol('help');
const LF = 10;
const CR = 13;

type Lookup<T> = T | typeof AMBIGUOUS | null;

function isPrefix(shorter: string, longer: string): number {
  if (shorter === '') return -1;
  const a = shorter.toLowerCase();
  const b = longer.toLowerCase();
  if (a === b) return -shorter.length;
  return b.startsWith(a) ? shorter.length : 0;
}

function generalGet<T extends { readonly name: string }>(name: string, table: readonly T[]): Lookup<T> {
  let found: T | null = null;
  for (const entry of table) {
    const n = isPrefix(name, entry.name);
    if (n === 0) continue;
    if (n < 0) return entry;
    if (found !== null) return AMBIGUOUS;
    found = entry;
  }
  return found;
}

function control(c: number): string {
  if (c === 0x7f) return '^?';
  if (c === DISABLED) return 'off';
  if (c >= 0x80) return `\\${((c >> 6) & 7)}${((c >> 3) & 7)}${c & 7}`;
  if (c >= 0x20) return String.fromCharCode(c);
  return `^${String.fromCharCode(64 + c)}`;
}

function special(text: string): number {
  if (text[0] === '^') {
    const b = text.charCodeAt(1);
    return Number.isNaN(b) ? 0x1e : b === 0x3f ? 0x7f : b & 0x1f;
  }
  return text.charCodeAt(0) & 0xff;
}

const CONTROL_ESCAPE = 0x1d;

interface ToggleEntry {
  readonly name: string;
  readonly help: string | null;
  readonly handler: ((value: number) => boolean) | null;
  readonly variable: keyof ToggleVariables | null;
  readonly action: string | null;
}

interface ToggleVariables {
  autoflush: number;
  autosynch: number;
  skiprc: number;
  crlf: number;
  crmod: number;
  localchars: number;
  debug: number;
  netdata: number;
  prettydump: number;
  showoptions: number;
  termdata: number;
}

interface SetEntry {
  readonly name: string;
  readonly help: string;
  readonly kind: 'char' | 'tracefile' | 'blank';
  readonly char: keyof TerminalCharacters | null;
}

interface TerminalCharacters {
  echo: number;
  escape: number;
  rlogin: number;
  flush: number;
  interrupt: number;
  quit: number;
  eof: number;
  erase: number;
  kill: number;
  lnext: number;
  susp: number;
  reprint: number;
  worderase: number;
  start: number;
  stop: number;
  forw1: number;
  forw2: number;
  ayt: number;
}

interface SendEntry {
  readonly name: string;
  readonly help: string | null;
  readonly needConnect: number;
  readonly narg: number;
  readonly action: 'escape' | 'help' | 'do' | 'dont' | 'will' | 'wont' | 'synch' | 'getstatus' | null;
  readonly nbyte: number;
  readonly what: number;
}

interface ModeEntry {
  readonly name: string;
  readonly help: string | null;
  readonly action: 'character' | 'line' | 'set' | 'clear' | 'help' | 'kludge' | null;
  readonly needConnect: boolean;
  readonly bit: number;
}

interface EnvCommand {
  readonly name: string;
  readonly help: string | null;
  readonly narg: number;
}

interface EnvironmentVariable {
  name: string | null;
  value: string;
  exported: boolean;
}

interface SpecialCharacter {
  value: number;
  flags: number;
  myLevel: number;
  pointer: keyof TerminalCharacters | null;
}

const NO_TERMINAL_CHARACTERS: Omit<TerminalCharacters, 'echo' | 'escape' | 'rlogin'> = {
  flush: 0, interrupt: 0, quit: 0, eof: 0, erase: 0, kill: 0, lnext: 0, susp: 0, reprint: 0, worderase: 0, start: 0, stop: 0, forw1: 0, forw2: 0, ayt: 0x14,
};

const TERMINAL_DEFAULTS: Omit<TerminalCharacters, 'echo' | 'escape' | 'rlogin'> = {
  flush: 0x0f, interrupt: 0x03, quit: 0x1c, eof: 0x04, erase: 0x7f, kill: 0x15, lnext: 0x16, susp: 0x1a, reprint: 0x12, worderase: 0x17,
  start: 0x11, stop: 0x13, forw1: DISABLED, forw2: DISABLED, ayt: 0x14,
};

interface CommandEntry {
  readonly name: string;
  readonly help: string | null;
  readonly nargs: number;
  readonly run: (argv: string[]) => Promise<boolean> | boolean;
  readonly sub?: CommandEntry[];
}

const SEND_LIST: readonly SendEntry[] = [
  { name: 'ao', help: 'Send Telnet Abort output', needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.AO },
  { name: 'ayt', help: "Send Telnet 'Are You There'", needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.AYT },
  { name: 'brk', help: 'Send Telnet Break', needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.BREAK },
  { name: 'break', help: null, needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.BREAK },
  { name: 'ec', help: 'Send Telnet Erase Character', needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.EC },
  { name: 'el', help: 'Send Telnet Erase Line', needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.EL },
  { name: 'escape', help: 'Send current escape character', needConnect: 1, narg: 0, action: 'escape', nbyte: 1, what: 0 },
  { name: 'ga', help: "Send Telnet 'Go Ahead' sequence", needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.GA },
  { name: 'ip', help: 'Send Telnet Interrupt Process', needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.IP },
  { name: 'intp', help: null, needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.IP },
  { name: 'interrupt', help: null, needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.IP },
  { name: 'intr', help: null, needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.IP },
  { name: 'nop', help: "Send Telnet 'No operation'", needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.NOP },
  { name: 'eor', help: "Send Telnet 'End of Record'", needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.EOR },
  { name: 'abort', help: "Send Telnet 'Abort Process'", needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.ABORT },
  { name: 'susp', help: "Send Telnet 'Suspend Process'", needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.SUSP },
  { name: 'eof', help: 'Send Telnet End of File Character', needConnect: 1, narg: 0, action: null, nbyte: 2, what: TELCMD.xEOF },
  { name: 'synch', help: "Perform Telnet 'Synch operation'", needConnect: 1, narg: 0, action: 'synch', nbyte: 2, what: 0 },
  { name: 'getstatus', help: 'Send request for STATUS', needConnect: 1, narg: 0, action: 'getstatus', nbyte: 6, what: 0 },
  { name: '?', help: 'Display send options', needConnect: 0, narg: 0, action: 'help', nbyte: 0, what: 0 },
  { name: 'help', help: null, needConnect: 0, narg: 0, action: 'help', nbyte: 0, what: 0 },
  { name: 'do', help: null, needConnect: 0, narg: 1, action: 'do', nbyte: 3, what: 0 },
  { name: 'dont', help: null, needConnect: 0, narg: 1, action: 'dont', nbyte: 3, what: 0 },
  { name: 'will', help: null, needConnect: 0, narg: 1, action: 'will', nbyte: 3, what: 0 },
  { name: 'wont', help: null, needConnect: 0, narg: 1, action: 'wont', nbyte: 3, what: 0 },
];

const SET_LIST: readonly SetEntry[] = [
  { name: 'echo', help: 'character to toggle local echoing on/off', kind: 'char', char: 'echo' },
  { name: 'escape', help: 'character to escape back to telnet command mode', kind: 'char', char: 'escape' },
  { name: 'rlogin', help: 'rlogin escape character', kind: 'char', char: 'rlogin' },
  { name: 'tracefile', help: 'file to write trace information to', kind: 'tracefile', char: null },
  { name: ' ', help: '', kind: 'blank', char: null },
  { name: ' ', help: "The following need 'localchars' to be toggled true", kind: 'blank', char: null },
  { name: 'flushoutput', help: 'character to cause an Abort Output', kind: 'char', char: 'flush' },
  { name: 'interrupt', help: 'character to cause an Interrupt Process', kind: 'char', char: 'interrupt' },
  { name: 'quit', help: 'character to cause an Abort process', kind: 'char', char: 'quit' },
  { name: 'eof', help: 'character to cause an EOF ', kind: 'char', char: 'eof' },
  { name: ' ', help: '', kind: 'blank', char: null },
  { name: ' ', help: 'The following are for local editing in linemode', kind: 'blank', char: null },
  { name: 'erase', help: 'character to use to erase a character', kind: 'char', char: 'erase' },
  { name: 'kill', help: 'character to use to erase a line', kind: 'char', char: 'kill' },
  { name: 'lnext', help: 'character to use for literal next', kind: 'char', char: 'lnext' },
  { name: 'susp', help: 'character to cause a Suspend Process', kind: 'char', char: 'susp' },
  { name: 'reprint', help: 'character to use for line reprint', kind: 'char', char: 'reprint' },
  { name: 'worderase', help: 'character to use to erase a word', kind: 'char', char: 'worderase' },
  { name: 'start', help: 'character to use for XON', kind: 'char', char: 'start' },
  { name: 'stop', help: 'character to use for XOFF', kind: 'char', char: 'stop' },
  { name: 'forw1', help: 'alternate end of line character', kind: 'char', char: 'forw1' },
  { name: 'forw2', help: 'alternate end of line character', kind: 'char', char: 'forw2' },
  { name: 'ayt', help: 'alternate AYT character', kind: 'char', char: 'ayt' },
];

const MODE_LIST: readonly ModeEntry[] = [
  { name: 'character', help: 'Disable LINEMODE option', action: 'character', needConnect: true, bit: 0 },
  { name: '', help: '(or disable obsolete line-by-line mode)', action: null, needConnect: false, bit: 0 },
  { name: 'line', help: 'Enable LINEMODE option', action: 'line', needConnect: true, bit: 0 },
  { name: '', help: '(or enable obsolete line-by-line mode)', action: null, needConnect: false, bit: 0 },
  { name: '', help: '', action: null, needConnect: false, bit: 0 },
  { name: '', help: 'These require the LINEMODE option to be enabled', action: null, needConnect: false, bit: 0 },
  { name: 'isig', help: 'Enable signal trapping', action: 'set', needConnect: true, bit: MODE.TRAPSIG },
  { name: '+isig', help: null, action: 'set', needConnect: true, bit: MODE.TRAPSIG },
  { name: '-isig', help: 'Disable signal trapping', action: 'clear', needConnect: true, bit: MODE.TRAPSIG },
  { name: 'edit', help: 'Enable character editing', action: 'set', needConnect: true, bit: MODE.EDIT },
  { name: '+edit', help: null, action: 'set', needConnect: true, bit: MODE.EDIT },
  { name: '-edit', help: 'Disable character editing', action: 'clear', needConnect: true, bit: MODE.EDIT },
  { name: 'softtabs', help: 'Enable tab expansion', action: 'set', needConnect: true, bit: MODE.SOFT_TAB },
  { name: '+softtabs', help: null, action: 'set', needConnect: true, bit: MODE.SOFT_TAB },
  { name: '-softtabs', help: 'Disable character editing', action: 'clear', needConnect: true, bit: MODE.SOFT_TAB },
  { name: 'litecho', help: 'Enable literal character echo', action: 'set', needConnect: true, bit: MODE.LIT_ECHO },
  { name: '+litecho', help: null, action: 'set', needConnect: true, bit: MODE.LIT_ECHO },
  { name: '-litecho', help: 'Disable literal character echo', action: 'clear', needConnect: true, bit: MODE.LIT_ECHO },
  { name: 'help', help: null, action: 'help', needConnect: false, bit: 0 },
  { name: 'kludgeline', help: null, action: 'kludge', needConnect: true, bit: 0 },
  { name: '', help: '', action: null, needConnect: false, bit: 0 },
  { name: '?', help: 'Print help information', action: 'help', needConnect: false, bit: 0 },
];

const ENVIRON_COMMANDS: readonly EnvCommand[] = [
  { name: 'define', help: 'Define an environment variable', narg: 2 },
  { name: 'undefine', help: 'Undefine an environment variable', narg: 1 },
  { name: 'export', help: 'Mark an environment variable for automatic export', narg: 1 },
  { name: 'unexport', help: "Don't mark an environment variable for automatic export", narg: 1 },
  { name: 'send', help: 'Send an environment variable', narg: 1 },
  { name: 'list', help: 'List the current environment variables', narg: 0 },
  { name: 'help', help: null, narg: 0 },
  { name: '?', help: 'Print help information', narg: 0 },
];

const USAGE_OPTIONS = '[-4] [-6] [-8] [-E] [-L] [-a] [-d] [-e char] [-l user]\n\t[-n tracefile] [ -b addr ] [-r] [host-name [port]]';
const OPTION_STRING = '4678EKLS:X:ab:de:k:l:n:rt:x';
const WELL_KNOWN_USERVAR_STEMS: ReadonlyArray<readonly [string, number]> = [
  ['ACCT', 0], ['DISPLAY', 0], ['JOB', 0], ['LANG', 0], ['LC_', 3], ['LOGNAME', 0], ['POSIXLY_CORRECT', 0], ['PRINTER', 0], ['SSH_', 4],
  ['SYSTEMTYPE', 0], ['TERM', 0], ['USER', 0], ['XAUTHORITY', 0],
];

function wellKnownVariable(name: string): boolean {
  return WELL_KNOWN_USERVAR_STEMS.some(([stem, length]) => (length > 0 ? name.startsWith(stem.slice(0, length)) && name.length >= length : name === stem));
}

export type NetkitState = 'command' | 'session' | 'exited';

interface Printer {
  out(text: string): void;
  err(text: string): void;
}

export class NetkitTelnetClient {
  private readonly options = new Uint8Array(256);
  private readonly doDontResp = new Int32Array(256);
  private readonly willWontResp = new Int32Array(256);
  private readonly toggles: ToggleVariables = {
    autoflush: 1, autosynch: 0, skiprc: 0, crlf: 0, crmod: 0, localchars: 1, debug: 0, netdata: 0, prettydump: 0, showoptions: 0, termdata: 0,
  };
  private readonly characters: TerminalCharacters = {
    echo: 0x05, escape: CONTROL_ESCAPE, rlogin: DISABLED, ...TERMINAL_DEFAULTS,
  };
  private terminalDefaults: Omit<TerminalCharacters, 'echo' | 'escape' | 'rlogin'> = TERMINAL_DEFAULTS;
  private readonly environment: EnvironmentVariable[] = [];
  private readonly specialCharacters: SpecialCharacter[] = [];
  private readonly toggleList: readonly ToggleEntry[];
  private commandTable: CommandEntry[] = [];
  private deprecatedTable: CommandEntry[] = [];
  private slcTable: CommandEntry[] = [];
  private readonly printer: Printer;

  private eight = 3;
  private readonly tty: boolean;
  private stdio = '';
  private binary = 0;
  private autologin = -1;
  private connected = false;
  private telnetPort = 0;
  private synching = false;
  private flushOut = false;
  private localFlow = false;
  private doneLocalChars = false;
  private doneBinaryToggle = false;
  private dontLocalEcho = false;
  private globalMode = 0;
  private flushLine = true;
  private lineMode = 0;
  private kludgeLineMode = true;
  private slcMode: 'import' | 'export' | 'rvalue' = 'export';
  private wantStatusResponse = 0;
  private clockSystem = 0;
  private clockEchoToggle = 0;
  private clockModeNegotiated = 0;
  private receiveState: 'data' | 'iac' | 'will' | 'wont' | 'do' | 'dont' | 'cr' | 'sb' | 'se' = 'data';
  private subBuffer: number[] = [];
  private bol = true;
  private rloginLocal = false;
  private tracefile = '(standard output)';
  private netBuffer: number[] = [];
  private ttyBuffer = '';
  private hostName = '';
  private transport: NetkitTelnetTransport | null = null;
  private unsubscribe: Array<() => void> = [];
  private state: NetkitState = 'command';
  private openPrompt = false;
  private escapePrompt = false;
  private startedWithHost = false;
  private programName: string;
  private promptText: string;
  private exitHandlers: Array<(code: number) => void> = [];
  private exitCode = 0;
  private sessionDepth = 0;
  private inCommandFromSession = false;
  private userName: string | null = null;
  private connecting = false;

  constructor(private readonly host: NetkitTelnetHost, private readonly terminal: NetkitTelnetTerminal, programName = 'telnet', private readonly invocationName: string = programName) {
    this.programName = programName;
    this.promptText = `${programName}> `;
    this.printer = { out: (text) => terminal.write(text), err: (text) => terminal.error(text) };
    this.tty = host.isTty();
    this.eight = this.tty ? 3 : 0;
    if (!this.tty) {
      this.terminalDefaults = NO_TERMINAL_CHARACTERS;
      Object.assign(this.characters, NO_TERMINAL_CHARACTERS);
    }
    this.toggleList = this.buildToggleList();
    this.initializeSpecialCharacters();
    this.initTelnet();
  }

  get currentState(): NetkitState {
    return this.state;
  }

  get prompt(): string {
    if (this.state !== 'command') return '';
    if (this.openPrompt) return '(to) ';
    if (this.escapePrompt) return 'new escape character: ';
    return this.promptText;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get exited(): boolean {
    return this.state === 'exited';
  }

  get trapsSignals(): boolean {
    return this.localCharsMode(this.globalMode) && (this.globalMode & MODE.TRAPSIG) !== 0;
  }

  get localEcho(): boolean {
    return (this.connectionMode() & MODE.ECHO) !== 0;
  }

  get lineEditing(): boolean {
    return (this.connectionMode() & MODE.EDIT) !== 0;
  }

  get escapeCharacter(): number {
    return this.characters.escape;
  }

  onExit(handler: (code: number) => void): void {
    this.exitHandlers.push(handler);
  }

  private myStateIsDo(option: number): boolean { return (this.options[option] & MY_STATE_DO) !== 0; }
  private myStateIsWill(option: number): boolean { return (this.options[option] & MY_STATE_WILL) !== 0; }
  private myWantStateIsDo(option: number): boolean { return (this.options[option] & MY_WANT_STATE_DO) !== 0; }
  private myWantStateIsWill(option: number): boolean { return (this.options[option] & MY_WANT_STATE_WILL) !== 0; }
  private setMyStateDo(option: number): void { this.options[option] |= MY_STATE_DO; }
  private setMyStateWill(option: number): void { this.options[option] |= MY_STATE_WILL; }
  private setMyWantStateDo(option: number): void { this.options[option] |= MY_WANT_STATE_DO; }
  private setMyWantStateWill(option: number): void { this.options[option] |= MY_WANT_STATE_WILL; }
  private setMyStateDont(option: number): void { this.options[option] &= ~MY_STATE_DO; }
  private setMyStateWont(option: number): void { this.options[option] &= ~MY_STATE_WILL; }
  private setMyWantStateDont(option: number): void { this.options[option] &= ~MY_WANT_STATE_DO; }
  private setMyWantStateWont(option: number): void { this.options[option] &= ~MY_WANT_STATE_WILL; }
  private hisWantStateIsWill(option: number): boolean { return this.myWantStateIsDo(option); }

  private netAdd(...bytes: number[]): void {
    for (const b of bytes) this.netBuffer.push(b & 0xff);
  }

  private netFlush(): void {
    if (this.netBuffer.length === 0 || this.transport === null) {
      this.netBuffer = [];
      return;
    }
    const data = String.fromCharCode(...this.netBuffer);
    this.netBuffer = [];
    this.transport.write(data);
  }

  private ttyAdd(c: number): void {
    this.ttyBuffer += String.fromCharCode(c);
  }

  private ttyFlush(drop: boolean = this.synching || this.flushOut): void {
    const text = this.ttyBuffer;
    this.ttyBuffer = '';
    if (text !== '' && !drop) this.printer.out(text);
  }

  private trace(text: string): void {
    if (this.toggles.showoptions) this.out(`${text}\r\n`);
  }

  private printOption(direction: string, command: number, option: number): void {
    if (!this.toggles.showoptions) return;
    if (command === IAC) {
      const name = commandName(option);
      this.trace(name !== null ? `${direction} IAC ${name}` : `${direction} IAC ${option}`);
      return;
    }
    const verb = command === WILL ? 'WILL' : command === WONT ? 'WONT' : command === DO ? 'DO' : command === DONT ? 'DONT' : null;
    if (verb === null) {
      this.trace(`${direction} ${command} ${option}`);
      return;
    }
    const name = optionName(option);
    this.trace(`${direction} ${verb} ${name ?? (option === TELOPT.EXOPL ? 'EXOPL' : String(option))}`);
  }

  private sendDo(option: number, init: boolean): void {
    if (init) {
      if ((this.doDontResp[option] === 0 && this.myStateIsDo(option)) || this.myWantStateIsDo(option)) return;
      this.setMyWantStateDo(option);
      this.doDontResp[option]++;
    }
    this.netAdd(IAC, DO, option);
    this.printOption('SENT', DO, option);
  }

  private sendDont(option: number, init: boolean): void {
    if (init) {
      if ((this.doDontResp[option] === 0 && !this.myStateIsDo(option)) || !this.myWantStateIsDo(option)) return;
      this.setMyWantStateDont(option);
      this.doDontResp[option]++;
    }
    this.netAdd(IAC, DONT, option);
    this.printOption('SENT', DONT, option);
  }

  private sendWill(option: number, init: boolean): void {
    if (init) {
      if ((this.willWontResp[option] === 0 && this.myStateIsWill(option)) || this.myWantStateIsWill(option)) return;
      this.setMyWantStateWill(option);
      this.willWontResp[option]++;
    }
    this.netAdd(IAC, WILL, option);
    this.printOption('SENT', WILL, option);
  }

  private sendWont(option: number, init: boolean): void {
    if (init) {
      if ((this.willWontResp[option] === 0 && !this.myStateIsWill(option)) || !this.myWantStateIsWill(option)) return;
      this.setMyWantStateWont(option);
      this.willWontResp[option]++;
    }
    this.netAdd(IAC, WONT, option);
    this.printOption('SENT', WONT, option);
  }

  private willOption(option: number): void {
    let newStateOk = false;
    if (this.doDontResp[option]) {
      --this.doDontResp[option];
      if (this.doDontResp[option] && this.myStateIsDo(option)) --this.doDontResp[option];
    }
    if (this.doDontResp[option] === 0 && !this.myWantStateIsDo(option)) {
      switch (option) {
        case TELOPT.ECHO:
        case TELOPT.BINARY:
        case TELOPT.SGA:
          this.clockModeNegotiated = this.clockSystem++;
          newStateOk = true;
          break;
        case TELOPT.STATUS:
          newStateOk = true;
          break;
        case TELOPT.TM:
          if (this.flushOut) this.flushOut = false;
          this.setMyWantStateDont(option);
          this.setMyStateDont(option);
          return;
        default:
          break;
      }
      if (newStateOk) {
        this.setMyWantStateDo(option);
        this.sendDo(option, false);
        this.setConnectionMode(false);
      } else {
        this.doDontResp[option]++;
        this.sendDont(option, false);
      }
    }
    this.setMyStateDo(option);
  }

  private wontOption(option: number): void {
    if (this.doDontResp[option]) {
      --this.doDontResp[option];
      if (this.doDontResp[option] && !this.myStateIsDo(option)) --this.doDontResp[option];
    }
    if (this.doDontResp[option] === 0 && this.myWantStateIsDo(option)) {
      switch (option) {
        case TELOPT.SGA:
          if (this.kludgeLineMode) this.clockModeNegotiated = this.clockSystem++;
          break;
        case TELOPT.ECHO:
          this.clockModeNegotiated = this.clockSystem++;
          break;
        case TELOPT.TM:
          if (this.flushOut) this.flushOut = false;
          this.setMyWantStateDont(option);
          this.setMyStateDont(option);
          return;
        default:
          break;
      }
      this.setMyWantStateDont(option);
      if (this.myStateIsDo(option)) this.sendDont(option, false);
      this.setConnectionMode(false);
    } else if (option === TELOPT.TM) {
      if (this.flushOut) this.flushOut = false;
      this.setMyWantStateDont(option);
    }
    this.setMyStateDont(option);
  }

  private doOption(option: number): void {
    let newStateOk = false;
    if (this.willWontResp[option]) {
      --this.willWontResp[option];
      if (this.willWontResp[option] && this.myStateIsWill(option)) --this.willWontResp[option];
    }
    if (this.willWontResp[option] === 0) {
      if (!this.myWantStateIsWill(option)) {
        switch (option) {
          case TELOPT.TM:
            this.sendWill(option, false);
            this.setMyWantStateWont(TELOPT.TM);
            this.setMyStateWont(TELOPT.TM);
            return;
          case TELOPT.BINARY:
          case TELOPT.NAWS:
          case TELOPT.TSPEED:
          case TELOPT.LFLOW:
          case TELOPT.TTYPE:
          case TELOPT.SGA:
          case TELOPT.ENVIRON:
            newStateOk = true;
            break;
          case TELOPT.XDISPLOC:
            if (this.environmentValue('DISPLAY', false) !== null) newStateOk = true;
            break;
          case TELOPT.LINEMODE:
            this.kludgeLineMode = false;
            this.sendDo(TELOPT.SGA, true);
            this.setMyWantStateWill(TELOPT.LINEMODE);
            this.sendWill(option, false);
            this.setMyStateWill(TELOPT.LINEMODE);
            this.slcInit();
            return;
          default:
            break;
        }
        if (newStateOk) {
          this.setMyWantStateWill(option);
          this.sendWill(option, false);
          this.setConnectionMode(false);
        } else {
          this.willWontResp[option]++;
          this.sendWont(option, false);
        }
      } else if (option === TELOPT.LINEMODE) {
        this.kludgeLineMode = false;
        this.sendDo(TELOPT.SGA, true);
        this.setMyStateWill(option);
        this.slcInit();
        this.sendDo(TELOPT.SGA, false);
        return;
      }
    }
    this.setMyStateWill(option);
  }

  private dontOption(option: number): void {
    if (this.willWontResp[option]) {
      --this.willWontResp[option];
      if (this.willWontResp[option] && !this.myStateIsWill(option)) --this.willWontResp[option];
    }
    if (this.willWontResp[option] === 0 && this.myWantStateIsWill(option)) {
      if (option === TELOPT.LINEMODE) this.lineMode = 0;
      this.setMyWantStateWont(option);
      if (this.myStateIsWill(option)) this.sendWont(option, false);
      this.setConnectionMode(false);
    }
    this.setMyStateWont(option);
  }

  private termName(): string {
    const value = this.environmentValue('TERM', false);
    const name = value === null ? 'UNKNOWN' : value;
    return name.length < 40 ? name : 'UNKNOWN';
  }

  private subOption(buffer: readonly number[], terminator: readonly number[] = [IAC, SE]): void {
    const length = buffer.length;
    if (length === 0) return;
    const option = buffer[0];
    this.printSub('<', [...buffer, ...terminator]);
    switch (option) {
      case TELOPT.TTYPE: {
        if (!this.myWantStateIsWill(TELOPT.TTYPE)) return;
        if (length < 2 || buffer[1] !== TELQUAL.SEND) return;
        const reply = [IAC, SB, TELOPT.TTYPE, TELQUAL.IS, ...this.bytes(this.termName()), IAC, SE];
        this.netAdd(...reply);
        if (reply.length > 6 && reply.length < 27) this.printSub('>', reply.slice(2));
        break;
      }
      case TELOPT.TSPEED: {
        if (!this.myWantStateIsWill(TELOPT.TSPEED)) return;
        if (length < 2) return;
        if (buffer[1] === TELQUAL.SEND) {
          const speeds = this.host.terminalSpeed();
          const reply = [IAC, SB, TELOPT.TSPEED, TELQUAL.IS, ...this.bytes(`${speeds.output},${speeds.input}`), IAC, SE];
          this.netAdd(...reply);
          if (reply.length > 7 && reply.length < 28) this.printSub('>', reply.slice(2));
        }
        break;
      }
      case TELOPT.LFLOW:
        if (!this.myWantStateIsWill(TELOPT.LFLOW)) return;
        if (length < 2) return;
        if (buffer[1] === 1) this.localFlow = true;
        else if (buffer[1] === 0) this.localFlow = false;
        else return;
        this.setConnectionMode(false);
        break;
      case TELOPT.LINEMODE: {
        if (!this.myWantStateIsWill(TELOPT.LINEMODE)) return;
        if (length < 2) return;
        const rest = buffer.slice(2);
        switch (buffer[1]) {
          case WILL: this.lmWill(rest); break;
          case WONT: break;
          case DO: this.lmDo(rest); break;
          case DONT: break;
          case LM.SLC: this.slc(rest); break;
          case LM.MODE: this.lmMode(rest, false); break;
          default: break;
        }
        break;
      }
      case TELOPT.ENVIRON: {
        if (length < 2) return;
        const qualifier = buffer[1];
        if (qualifier === TELQUAL.IS || qualifier === TELQUAL.INFO) {
          if (!this.myWantStateIsDo(TELOPT.ENVIRON)) return;
        } else if (qualifier === TELQUAL.SEND) {
          if (!this.myWantStateIsWill(TELOPT.ENVIRON)) return;
        } else {
          return;
        }
        this.environmentOption(buffer.slice(1));
        break;
      }
      case TELOPT.XDISPLOC: {
        if (!this.myWantStateIsWill(TELOPT.XDISPLOC)) return;
        if (length < 2) return;
        if (buffer[1] === TELQUAL.SEND) {
          const display = this.environmentValue('DISPLAY', false);
          if (display === null) {
            this.sendWont(TELOPT.XDISPLOC, true);
            break;
          }
          const reply = [IAC, SB, TELOPT.XDISPLOC, TELQUAL.IS, ...this.bytes(display), IAC, SE];
          this.netAdd(...reply);
          if (reply.length > 6 && reply.length < 37) this.printSub('>', reply.slice(2));
        }
        break;
      }
      case TELOPT.STATUS:
        break;
      default:
        break;
    }
  }

  private bytes(text: string): number[] {
    return Array.from(text, (c) => c.charCodeAt(0) & 0xff);
  }

  private lmWill(command: readonly number[]): void {
    if (command.length < 1) return;
    const reply = [IAC, SB, TELOPT.LINEMODE, DONT, command[0], IAC, SE];
    this.netAdd(...reply);
    this.printSub('>', reply.slice(2));
  }

  private lmDo(command: readonly number[]): void {
    if (command.length < 1) return;
    const reply = [IAC, SB, TELOPT.LINEMODE, WONT, command[0], IAC, SE];
    this.netAdd(...reply);
    this.printSub('>', reply.slice(2));
  }

  private lmMode(command: readonly number[], init: boolean): void {
    if (command.length !== 1) return;
    if ((this.lineMode & MODE.MASK & ~MODE.ACK) === command[0]) return;
    if (command[0] & MODE.ACK) return;
    this.lineMode = command[0] & (MODE.MASK & ~MODE.ACK);
    let k = this.lineMode;
    if (!init) k |= MODE.ACK;
    const reply = [IAC, SB, TELOPT.LINEMODE, LM.MODE, k, IAC, SE];
    this.netAdd(...reply);
    this.printSub('>', reply.slice(2));
    this.setConnectionMode(false);
  }

  private specialCharacterPointer(func: number): keyof TerminalCharacters | null {
    switch (func) {
      case SLC.IP: return 'interrupt';
      case SLC.ABORT: return 'quit';
      case SLC.EOF: return 'eof';
      case SLC.EC: return 'erase';
      case SLC.EL: return 'kill';
      case SLC.XON: return 'start';
      case SLC.XOFF: return 'stop';
      case SLC.FORW1: return 'forw1';
      case SLC.FORW2: return 'forw2';
      case SLC.AO: return 'flush';
      case SLC.SUSP: return 'susp';
      case SLC.EW: return 'worderase';
      case SLC.RP: return 'reprint';
      case SLC.LNEXT: return 'lnext';
      default: return null;
    }
  }

  private initializeSpecialCharacters(): void {
    for (let i = 0; i <= NSLC; i++) this.specialCharacters.push({ value: 0, flags: SLC.NOSUPPORT, myLevel: SLC.NOSUPPORT, pointer: null });
  }

  private slcInit(): void {
    this.toggles.localchars = 1;
    for (const entry of this.specialCharacters) {
      entry.value = 0;
      entry.pointer = null;
      entry.flags = SLC.NOSUPPORT;
      entry.myLevel = SLC.NOSUPPORT;
    }
    const initialize = (func: number, flags: number): void => {
      const entry = this.specialCharacters[func];
      entry.pointer = this.specialCharacterPointer(func);
      if (entry.pointer !== null) {
        entry.value = this.characters[entry.pointer];
        entry.myLevel = SLC.VARIABLE | flags;
      } else {
        entry.value = 0;
        entry.myLevel = SLC.DEFAULT;
      }
    };
    initialize(SLC.SYNCH, 0);
    initialize(SLC.AO, 0);
    initialize(SLC.AYT, 0);
    initialize(SLC.ABORT, SLC.FLUSHIN | SLC.FLUSHOUT);
    initialize(SLC.EOF, 0);
    initialize(SLC.SUSP, SLC.FLUSHIN);
    initialize(SLC.EC, 0);
    initialize(SLC.EL, 0);
    initialize(SLC.XON, 0);
    initialize(SLC.XOFF, 0);
    initialize(SLC.FORW1, 0);
    initialize(SLC.FORW2, 0);
    initialize(SLC.IP, SLC.FLUSHIN | SLC.FLUSHOUT);
    if (this.slcMode === 'export') this.slcExportAll();
    else this.slcImport(true);
  }

  private slcState(): void {
    this.out(`Special characters are ${this.slcMode === 'import' ? 'remote default' : this.slcMode === 'export' ? 'local' : 'remote'} values\n`);
  }

  private slcExportCommandMode(): void {
    this.slcMode = 'export';
    if (this.myStateIsWill(TELOPT.LINEMODE)) this.slcExportAll();
  }

  private slcImportMode(def: boolean): void {
    this.slcMode = def ? 'import' : 'rvalue';
    if (this.myStateIsWill(TELOPT.LINEMODE)) this.slcImport(def);
  }

  private slcImport(def: boolean): void {
    const level = def ? SLC.DEFAULT : SLC.VARIABLE;
    const reply = [IAC, SB, TELOPT.LINEMODE, LM.SLC, 0, level, 0, IAC, SE];
    this.netAdd(...reply);
    this.printSub('>', reply.slice(2));
  }

  private slcExportAll(): void {
    Object.assign(this.characters, this.terminalDefaults);
    const reply: number[] = [IAC, SB, TELOPT.LINEMODE, LM.SLC];
    for (let func = 1; func <= NSLC; func++) {
      const entry = this.specialCharacters[func];
      if (entry.myLevel === SLC.NOSUPPORT) continue;
      entry.flags = entry.value === DISABLED ? SLC.NOSUPPORT : entry.myLevel;
      if (entry.pointer !== null) entry.value = this.characters[entry.pointer];
      this.slcAddReply(reply, func, entry.flags, entry.value);
    }
    this.slcEndReply(reply);
    this.slcUpdate();
    this.setConnectionMode(true);
  }

  private slcAddReply(reply: number[], func: number, flags: number, value: number): void {
    if (reply.length + 8 > 128) return;
    reply.push(func);
    if (func === IAC) reply.push(IAC);
    reply.push(flags);
    if (flags === IAC) reply.push(IAC);
    reply.push(value);
    if (value === IAC) reply.push(IAC);
  }

  private slcEndReply(reply: number[]): void {
    reply.push(IAC, SE);
    if (reply.length <= 6) return;
    this.printSub('>', reply.slice(2));
    this.netAdd(...reply);
  }

  private slcUpdate(): boolean {
    let needUpdate = false;
    for (let func = 1; func <= NSLC; func++) {
      const entry = this.specialCharacters[func];
      if (!(entry.flags & SLC.ACK)) continue;
      entry.flags &= ~SLC.ACK;
      if (entry.pointer !== null && this.characters[entry.pointer] !== entry.value) {
        this.characters[entry.pointer] = entry.value;
        needUpdate = true;
      }
    }
    return needUpdate;
  }

  private slc(data: readonly number[]): void {
    const reply: number[] = [IAC, SB, TELOPT.LINEMODE, LM.SLC];
    const cp = [...data];
    for (let offset = 0; cp.length - offset >= 3; offset += 3) {
      const func = cp[offset];
      const flagsByte = cp[offset + 1];
      const value = cp[offset + 2];
      if (func === 0) continue;
      if (func > NSLC) {
        if ((flagsByte & SLC.LEVELBITS) !== SLC.NOSUPPORT) this.slcAddReply(reply, func, SLC.NOSUPPORT, 0);
        continue;
      }
      const entry = this.specialCharacters[func];
      let level = flagsByte & (SLC.LEVELBITS | SLC.ACK);
      if (value === entry.value && (level & SLC.LEVELBITS) === (entry.flags & SLC.LEVELBITS)) continue;
      let effectiveFlags = flagsByte;
      if (level === (SLC.DEFAULT | SLC.ACK)) {
        effectiveFlags &= ~SLC.ACK;
      }
      if (level === ((entry.flags & SLC.LEVELBITS) | SLC.ACK)) {
        entry.value = value;
        entry.flags = effectiveFlags;
        continue;
      }
      level &= ~SLC.ACK;
      if (level <= (entry.myLevel & SLC.LEVELBITS)) {
        entry.flags = effectiveFlags | SLC.ACK;
        entry.value = value;
      }
      if (level === SLC.DEFAULT) {
        if ((entry.myLevel & SLC.LEVELBITS) !== SLC.DEFAULT) entry.flags = entry.myLevel;
        else entry.flags = SLC.NOSUPPORT;
      }
      this.slcAddReply(reply, func, entry.flags, entry.value);
    }
    this.slcEndReply(reply);
    if (this.slcUpdate()) this.setConnectionMode(true);
  }

  private slcCheck(): void {
    const reply: number[] = [IAC, SB, TELOPT.LINEMODE, LM.SLC];
    for (let func = 1; func <= NSLC; func++) {
      const entry = this.specialCharacters[func];
      if (entry.pointer !== null && entry.value !== this.characters[entry.pointer]) {
        entry.value = this.characters[entry.pointer];
        entry.flags = entry.value === DISABLED ? SLC.NOSUPPORT : entry.myLevel;
        this.slcAddReply(reply, func, entry.flags, entry.value);
      }
    }
    this.slcEndReply(reply);
    this.setConnectionMode(true);
  }

  private environmentOption(data: readonly number[]): void {
    if (data[0] !== TELQUAL.SEND) return;
    const reply: number[] = [IAC, SB, TELOPT.ENVIRON, TELQUAL.IS];
    if (data.length === 1) {
      this.environmentAddAll(reply);
    } else {
      let value: number[] | null = null;
      for (let i = 1; i < data.length; i++) {
        switch (data[i]) {
          case ENV.VALUE:
            if (value !== null) this.environmentAdd(reply, String.fromCharCode(...value));
            value = [];
            break;
          case ENV.ESC:
            i++;
            if (value !== null && i < data.length) value.push(data[i]);
            break;
          default:
            if (value !== null) value.push(data[i]);
            break;
        }
        if (value !== null) this.environmentAdd(reply, String.fromCharCode(...value));
      }
    }
    this.environmentEnd(reply, true);
  }

  private environmentAddAll(reply: number[]): void {
    for (const variable of this.environment) {
      if (variable.name !== null && variable.exported) this.environmentAdd(reply, variable.name);
    }
  }

  private environmentAdd(reply: number[], name: string): void {
    if (name === '') {
      this.environmentAddAll(reply);
      return;
    }
    const value = this.environmentValue(name, true);
    reply.push(wellKnownVariable(name) ? ENV.VAR : ENV.USERVAR);
    const push = (text: string): void => {
      for (const c of this.bytes(text)) {
        if (c === IAC) reply.push(IAC);
        else if (c === ENV.VALUE || c === ENV.VAR || c === ENV.ESC) reply.push(ENV.ESC);
        reply.push(c);
      }
    };
    push(name);
    if (value !== null) {
      reply.push(ENV.VALUE);
      push(value);
    }
  }

  private environmentEnd(reply: number[], emptyOk: boolean): void {
    const length = reply.length + 2;
    if (emptyOk || length > 6) {
      reply.push(IAC, SE);
      this.printSub('>', reply.slice(2));
      this.netAdd(...reply);
    }
  }

  private printSub(direction: '<' | '>' | '', pointer: readonly number[]): void {
    const forced = this.wantStatusResponse > 0 && pointer[0] === TELOPT.STATUS;
    if (!this.toggles.showoptions && direction !== '' && !forced) return;
    this.out(this.describeSub(direction, pointer));
  }

  private describeSub(direction: '<' | '>' | '', source: readonly number[]): string {
    const pointer = [...source];
    let length = pointer.length;
    let text = '';
    if (direction !== '') {
      text += `${direction === '<' ? 'RCVD' : 'SENT'} IAC SB `;
      if (length >= 3) {
        const i = pointer[length - 2];
        const j = pointer[length - 1];
        if (i !== IAC || j !== SE) {
          const name = (x: number): string => `${optionName(x) ?? commandName(x) ?? x}`;
          text += `(terminated by ${name(i)} ${name(j)}, not IAC SE!) `;
        }
      }
      length -= 2;
    }
    if (length < 1) return `${text}(Empty suboption???)`;
    switch (pointer[0]) {
      case TELOPT.TTYPE:
        text += 'TERMINAL-TYPE ';
        if (pointer[1] === TELQUAL.IS) text += `IS "${String.fromCharCode(...pointer.slice(2, length))}"`;
        else if (pointer[1] === TELQUAL.SEND) text += 'SEND';
        else text += `- unknown qualifier ${pointer[1]} (0x${pointer[1]?.toString(16)}).`;
        break;
      case TELOPT.TSPEED:
        text += 'TERMINAL-SPEED';
        if (length < 2) { text += ' (empty suboption???)'; break; }
        if (pointer[1] === TELQUAL.IS) text += ` IS ${String.fromCharCode(...pointer.slice(2, length))}`;
        else {
          text += pointer[1] === 1 ? ' SEND' : ` ${pointer[1]} (unknown)`;
          for (let i = 2; i < length; i++) text += ` ?${pointer[i]}?`;
        }
        break;
      case TELOPT.LFLOW:
        text += 'TOGGLE-FLOW-CONTROL';
        if (length < 2) { text += ' (empty suboption???)'; break; }
        text += pointer[1] === 0 ? ' OFF' : pointer[1] === 1 ? ' ON' : pointer[1] === 2 ? ' RESTART-ANY' : pointer[1] === 3 ? ' RESTART-XON' : ` ${pointer[1]} (unknown)`;
        for (let i = 2; i < length; i++) text += ` ?${pointer[i]}?`;
        break;
      case TELOPT.NAWS:
        text += 'NAWS';
        if (length < 2) { text += ' (empty suboption???)'; break; }
        if (length === 2) { text += ` ?${pointer[1]}?`; break; }
        text += ` ${pointer[1]} ${pointer[2]} (${(pointer[1] << 8) | pointer[2]})`;
        if (length === 4) { text += ` ?${pointer[3]}?`; break; }
        text += ` ${pointer[3]} ${pointer[4]} (${(pointer[3] << 8) | pointer[4]})`;
        for (let i = 5; i < length; i++) text += ` ?${pointer[i]}?`;
        break;
      case TELOPT.LINEMODE:
        text += 'LINEMODE ';
        if (length < 2) { text += ' (empty suboption???)'; break; }
        text += this.describeLinemode(pointer, length);
        break;
      case TELOPT.STATUS:
        text += this.describeStatus(pointer, length);
        break;
      case TELOPT.XDISPLOC:
        text += 'X-DISPLAY-LOCATION ';
        if (pointer[1] === TELQUAL.IS) text += `IS "${String.fromCharCode(...pointer.slice(2, length))}"`;
        else if (pointer[1] === TELQUAL.SEND) text += 'SEND';
        else text += `- unknown qualifier ${pointer[1]} (0x${pointer[1]?.toString(16)}).`;
        break;
      case TELOPT.ENVIRON:
        text += `ENVIRON ${this.describeEnvironment(pointer, length)}`;
        break;
      default: {
        const name = optionName(pointer[0]);
        text += name !== null ? `${name} (unknown)` : `${pointer[0]} (unknown)`;
        for (let i = 1; i < length; i++) text += ` ${pointer[i]}`;
        break;
      }
    }
    return direction !== '' ? `${text}\r\n` : text;
  }

  private describeLinemode(pointer: readonly number[], length: number): string {
    let text = '';
    switch (pointer[1]) {
      case WILL:
      case WONT:
      case DO:
      case DONT:
        text += pointer[1] === WILL ? 'WILL ' : pointer[1] === WONT ? 'WONT ' : pointer[1] === DO ? 'DO ' : 'DONT ';
        if (length < 3) return `${text}(no option???)`;
        if (pointer[2] === LM.FORWARDMASK) {
          text += 'Forward Mask';
          for (let i = 3; i < length; i++) text += ` ${pointer[i].toString(16)}`;
        } else {
          text += `${pointer[2]} (unknown)`;
          for (let i = 3; i < length; i++) text += ` ${pointer[i]}`;
        }
        return text;
      case LM.SLC: {
        text += 'SLC';
        let i = 2;
        for (; i < length - 2; i += 3) {
          text += pointer[i] <= NSLC ? ` ${SLC_NAMES[pointer[i]]}` : ` ${pointer[i]}`;
          switch (pointer[i + 1] & SLC.LEVELBITS) {
            case SLC.NOSUPPORT: text += ' NOSUPPORT'; break;
            case SLC.CANTCHANGE: text += ' CANTCHANGE'; break;
            case SLC.VARIABLE: text += ' VARIABLE'; break;
            case SLC.DEFAULT: text += ' DEFAULT'; break;
            default: break;
          }
          text += `${pointer[i + 1] & SLC.ACK ? '|ACK' : ''}${pointer[i + 1] & SLC.FLUSHIN ? '|FLUSHIN' : ''}${pointer[i + 1] & SLC.FLUSHOUT ? '|FLUSHOUT' : ''}`;
          if (pointer[i + 1] & ~(SLC.ACK | SLC.FLUSHIN | SLC.FLUSHOUT | SLC.LEVELBITS)) text += `(0x${pointer[i + 1].toString(16)})`;
          text += ` ${pointer[i + 2]};`;
          if (pointer[i + 2] === IAC && pointer[i + 3] === IAC) i++;
        }
        for (; i < length; i++) text += ` ?${pointer[i]}?`;
        return text;
      }
      case LM.MODE: {
        text += 'MODE ';
        if (length < 3) return `${text}(no mode???)`;
        const flags = [
          pointer[2] & MODE.EDIT ? '|EDIT' : '', pointer[2] & MODE.TRAPSIG ? '|TRAPSIG' : '', pointer[2] & MODE.SOFT_TAB ? '|SOFT_TAB' : '',
          pointer[2] & MODE.LIT_ECHO ? '|LIT_ECHO' : '', pointer[2] & MODE.ACK ? '|ACK' : '',
        ].join('');
        text += flags === '' ? '0' : flags.slice(1);
        if (pointer[2] & ~MODE.MASK) text += ` (0x${pointer[2].toString(16)})`;
        for (let i = 3; i < length; i++) text += ` ?0x${pointer[i].toString(16)}?`;
        return text;
      }
      default:
        text += `${pointer[1]} (unknown)`;
        for (let i = 2; i < length; i++) text += ` ${pointer[i]}`;
        return text;
    }
  }

  private describeStatus(pointer: number[], length: number): string {
    let text = 'STATUS';
    if (pointer[1] !== TELQUAL.IS) {
      text += pointer[1] === TELQUAL.SEND ? ' SEND' : ` ${pointer[1]} (unknown)`;
      for (let i = 2; i < length; i++) text += ` ?${pointer[i]}?`;
      return text;
    }
    if (--this.wantStatusResponse < 0) this.wantStatusResponse = 0;
    text += ' IS\r\n';
    for (let i = 2; i < length; i++) {
      const c = pointer[i];
      if (c === DO || c === DONT || c === WILL || c === WONT) {
        const verb = c === DO ? 'DO' : c === DONT ? 'DONT' : c === WILL ? 'WILL' : 'WONT';
        i++;
        text += ` ${verb} ${optionName(pointer[i]) ?? pointer[i]}\r\n`;
      } else if (c === SB) {
        text += ' SB ';
        i++;
        let j = i;
        let k = i;
        while (j < length) {
          if (pointer[j] === SE) {
            if (j + 1 === length) break;
            if (pointer[j + 1] === SE) j++;
            else break;
          }
          pointer[k++] = pointer[j++];
        }
        text += this.describeSub('', pointer.slice(i, k));
        if (i < length) {
          text += ' SE';
          i = j;
        } else {
          i = j - 1;
        }
        text += '\r\n';
      } else {
        text += ` ${c}`;
      }
    }
    return text;
  }

  private describeEnvironment(pointer: readonly number[], length: number): string {
    let text = '';
    const qualifier = pointer[1];
    text += qualifier === TELQUAL.IS ? 'IS ' : qualifier === TELQUAL.SEND ? 'SEND ' : qualifier === TELQUAL.INFO ? 'INFO ' : '';
    if (text === '') return text;
    let noQuote = 2;
    const quoteHead = (word: string): string => word.slice(noQuote);
    for (let i = 2; i < length; i++) {
      const c = pointer[i];
      const isVar = c === ENV.USERVAR || c === ENV.VAR;
      if (isVar && qualifier !== TELQUAL.SEND) {
        text += quoteHead(c === ENV.VAR ? '" VAR ' : '" USERVAR ');
        noQuote = 2;
      } else if (c === ENV.VALUE && !isVar) {
        text += quoteHead('" VALUE ');
        noQuote = 2;
      } else if (c === ENV.ESC) {
        text += quoteHead('" ESC ');
        noQuote = 2;
      } else if (c >= 0x20 && c < 0x7f && c !== 0x22) {
        if (noQuote) {
          text += '"';
          noQuote = 0;
        }
        text += String.fromCharCode(c);
      } else {
        text += quoteHead(`" ${c.toString(8).padStart(3, '0')} `);
        noQuote = 2;
      }
    }
    if (!noQuote) text += '"';
    return text;
  }

  private out(text: string): void {
    if (this.tty) {
      this.printer.out(text);
      return;
    }
    this.stdio += text;
    while (this.stdio.length >= STDIO_BLOCK) {
      this.printer.out(this.stdio.slice(0, STDIO_BLOCK));
      this.stdio = this.stdio.slice(STDIO_BLOCK);
    }
  }

  private fflush(): void {
    if (this.stdio === '') return;
    const text = this.stdio;
    this.stdio = '';
    this.printer.out(text);
  }

  private err(text: string): void { this.printer.err(text); }

  private initTelnet(): void {
    this.initializeEnvironment();
    this.commandTable.push(...this.buildCommandTable());
    this.options.fill(0);
    this.connected = false;
    this.localFlow = false;
    this.doneBinaryToggle = false;
    this.synching = false;
    this.characters.escape = CONTROL_ESCAPE;
    this.characters.rlogin = DISABLED;
    this.characters.echo = 0x05;
    this.flushLine = true;
    this.receiveState = 'data';
    this.subBuffer = [];
    this.toggles.autoflush = 1;
    this.resetTerminalState();
  }

  private resetTerminalState(): void {
    this.ttyBuffer = '';
    this.netBuffer = [];
  }

  private initializeEnvironment(): void {
    for (const [name, value] of this.host.environment()) this.environmentPut(name, value, false);
    const display = this.environmentFind('DISPLAY');
    if (display !== null) {
      display.exported = true;
      if (display.value.startsWith(':') || display.value.startsWith('unix:')) {
        const tail = display.value.slice(display.value.lastIndexOf(':'));
        let name = this.host.hostname();
        if (!name.includes('.')) name = this.host.canonicalHostname(name);
        display.value = `${name}${tail}`;
      }
    }
    if (this.environmentFind('USER') === null) {
      const logname = this.environmentFind('LOGNAME');
      if (logname !== null) this.environmentPut('USER', logname.value, false);
    }
    const printer = this.environmentFind('PRINTER');
    if (printer !== null) printer.exported = true;
  }

  private environmentFind(name: string): EnvironmentVariable | null {
    return this.environment.find((v) => v.name === name) ?? null;
  }

  private environmentPut(name: string, value: string, exported: boolean): void {
    let entry = this.environmentFind(name);
    if (entry === null) {
      entry = { name, value, exported };
      this.environment.push(entry);
      return;
    }
    entry.value = value;
    entry.exported = exported;
  }

  private environmentValue(name: string, exportedOnly: boolean): string | null {
    const entry = this.environmentFind(name);
    if (entry !== null && (!exportedOnly || entry.exported)) return entry.value;
    return null;
  }

  private environmentDefine(name: string, value: string): void { this.environmentPut(name, value, true); }

  private environmentUndefine(name: string): void {
    const entry = this.environmentFind(name);
    if (entry !== null) {
      entry.name = null;
      entry.value = '';
      entry.exported = false;
    }
  }

  private environmentExport(name: string, exported: boolean): void {
    const entry = this.environmentFind(name);
    if (entry !== null) entry.exported = exported;
  }

  private environmentSend(name: string): void {
    if (!this.myStateIsWill(TELOPT.ENVIRON)) {
      this.err(`Cannot send '${name}': Telnet ENVIRON option disabled\n`);
      return;
    }
    if (this.environmentFind(name) === null) {
      this.err(`Cannot send '${name}': variable not defined\n`);
      return;
    }
    const reply: number[] = [IAC, SB, TELOPT.ENVIRON, TELQUAL.INFO];
    this.environmentAdd(reply, name);
    this.environmentEnd(reply, false);
  }

  private environmentList(): void {
    for (const variable of this.environment) {
      if (variable.name === null) continue;
      this.out(`${variable.exported ? '*' : ' '} ${variable.name.padEnd(20)} ${variable.value}\n`);
    }
  }

  private pad15(name: string): string { return name.padEnd(15); }

  private connectionMode(): number {
    let mode = 0;
    if (!this.myWantStateIsDo(TELOPT.ECHO)) mode |= MODE.ECHO;
    if (this.localFlow) mode |= MODE.FLOW;
    if ((this.eight & 1) || this.myWantStateIsWill(TELOPT.BINARY)) mode |= MODE.INBIN;
    if (this.eight & 2) mode |= MODE.OUT8;
    if (this.myWantStateIsDo(TELOPT.BINARY)) mode |= MODE.OUTBIN;
    if (this.kludgeLineMode) {
      if (!this.myWantStateIsDo(TELOPT.SGA)) {
        mode |= MODE.TRAPSIG | MODE.EDIT;
        if (this.dontLocalEcho && this.clockEchoToggle > this.clockModeNegotiated) mode &= ~MODE.ECHO;
      }
      return mode;
    }
    if (this.myWantStateIsWill(TELOPT.LINEMODE)) mode |= this.lineMode;
    return mode;
  }

  private previousMode = 0;

  private setConnectionMode(force: boolean): void {
    this.applyTerminalMode(this.connectionMode() | (force ? MODE.FORCE : 0));
  }

  private setCommandMode(): void {
    this.applyTerminalMode(-1);
  }

  private applyTerminalMode(f: number): void {
    this.globalMode = f & ~MODE.FORCE;
    if (this.previousMode === f) return;
    this.ttyFlush();
    this.previousMode = f & ~MODE.FORCE;
    const all = f === -1;
    this.toggles.localchars = all || (f & MODE.TRAPSIG) !== 0 ? 1 : 0;
    this.terminal.setMode({
      commandLine: all,
      echo: all || (f & MODE.ECHO) !== 0,
      flow: all || (f & MODE.FLOW) !== 0,
      trapSignals: all || (f & MODE.TRAPSIG) !== 0,
      edit: all || (f & MODE.EDIT) !== 0,
      softTabs: all || (f & MODE.SOFT_TAB) !== 0,
      literalEcho: all || (f & MODE.LIT_ECHO) !== 0,
      inputBinary: !all && (f & MODE.INBIN) !== 0,
      outputBinary: !all && (f & MODE.OUTBIN) !== 0,
      output8: !all && (f & (MODE.OUTBIN | MODE.OUT8)) !== 0,
      escape: this.characters.rlogin !== DISABLED ? this.characters.rlogin : this.characters.escape,
      crlf: this.toggles.crlf !== 0,
    });
  }

  private localCharsMode(mode: number): boolean {
    return (mode & (MODE.EDIT | MODE.TRAPSIG)) !== 0;
  }

  private buildToggleList(): readonly ToggleEntry[] {
    const toggle = (
      name: string, help: string | null, variable: keyof ToggleVariables | null, action: string | null,
      handler: ((value: number) => boolean) | null = null,
    ): ToggleEntry => ({ name, help, variable, action, handler });
    return [
      toggle('autoflush', 'flushing of output when sending interrupt characters', 'autoflush', 'flush output when sending interrupt characters'),
      toggle('autosynch', 'automatic sending of interrupt characters in urgent mode', 'autosynch', 'send interrupt characters in urgent mode'),
      toggle('skiprc', "don't read the telnetrc files", 'skiprc', 'read the telnetrc files'),
      toggle('binary', 'sending and receiving of binary data', null, null, (v) => this.toggleBinary(v)),
      toggle('inbinary', 'receiving of binary data', null, null, (v) => this.toggleInputBinary(v)),
      toggle('outbinary', 'sending of binary data', null, null, (v) => this.toggleOutputBinary(v)),
      toggle('crlf', 'sending carriage returns as telnet <CR><LF>', 'crlf', null, () => this.toggleCrlf()),
      toggle('crmod', 'mapping of received carriage returns', 'crmod', 'map carriage return on output'),
      toggle('localchars', 'local recognition of certain control characters', 'localchars', 'recognize certain control characters', () => true),
      toggle(' ', '', null, null),
      toggle('debug', 'debugging', 'debug', 'turn on socket level debugging', () => true),
      toggle('netdata', 'printing of hexadecimal network data (debugging)', 'netdata', 'print hexadecimal representation of network traffic'),
      toggle('prettydump', 'output of "netdata" to user readable format (debugging)', 'prettydump', 'print user readable output for "netdata"'),
      toggle('options', 'viewing of options processing (debugging)', 'showoptions', 'show option processing'),
      toggle('termdata', '(debugging) toggle printing of hexadecimal terminal data', 'termdata', 'print hexadecimal representation of terminal traffic'),
      toggle('?', null, null, null, () => this.toggleHelp()),
      toggle('help', null, null, null, () => this.toggleHelp()),
    ];
  }

  private binaryMode = 0;

  private toggleCrlf(): boolean {
    this.out(this.toggles.crlf ? 'Will send carriage returns as telnet <CR><LF>.\n' : 'Will send carriage returns as telnet <CR><NUL>.\n');
    return true;
  }

  private enterBinary(rw: number): void {
    if (rw & 1) this.sendDo(TELOPT.BINARY, true);
    if (rw & 2) this.sendWill(TELOPT.BINARY, true);
  }

  private leaveBinary(rw: number): void {
    if (rw & 1) this.sendDont(TELOPT.BINARY, true);
    if (rw & 2) this.sendWont(TELOPT.BINARY, true);
  }

  private toggleBinary(requested: number): boolean {
    this.doneBinaryToggle = true;
    let value = requested;
    if (value >= 0) {
      this.binaryMode = value;
    } else {
      if (this.myWantStateIsWill(TELOPT.BINARY) && this.myWantStateIsDo(TELOPT.BINARY)) this.binaryMode = 1;
      else if (!this.myWantStateIsWill(TELOPT.BINARY) && !this.myWantStateIsDo(TELOPT.BINARY)) this.binaryMode = 0;
      value = this.binaryMode ? 0 : 1;
    }
    if (value === 1) {
      if (this.myWantStateIsWill(TELOPT.BINARY) && this.myWantStateIsDo(TELOPT.BINARY)) {
        this.out('Already operating in binary mode with remote host.\n');
      } else {
        this.out('Negotiating binary mode with remote host.\n');
        this.enterBinary(3);
      }
    } else if (!this.myWantStateIsWill(TELOPT.BINARY) && !this.myWantStateIsDo(TELOPT.BINARY)) {
      this.out('Already in network ascii mode with remote host.\n');
    } else {
      this.out('Negotiating network ascii mode with remote host.\n');
      this.leaveBinary(3);
    }
    return true;
  }

  private toggleInputBinary(requested: number): boolean {
    this.doneBinaryToggle = true;
    const value = requested === -1 ? (this.myWantStateIsDo(TELOPT.BINARY) ? 0 : 1) : requested;
    if (value === 1) {
      if (this.myWantStateIsDo(TELOPT.BINARY)) {
        this.out('Already receiving in binary mode.\n');
      } else {
        this.out('Negotiating binary mode on input.\n');
        this.enterBinary(1);
      }
    } else if (!this.myWantStateIsDo(TELOPT.BINARY)) {
      this.out('Already receiving in network ascii mode.\n');
    } else {
      this.out('Negotiating network ascii mode on input.\n');
      this.leaveBinary(1);
    }
    return true;
  }

  private toggleOutputBinary(requested: number): boolean {
    this.doneBinaryToggle = true;
    const value = requested === -1 ? (this.myWantStateIsWill(TELOPT.BINARY) ? 0 : 1) : requested;
    if (value === 1) {
      if (this.myWantStateIsWill(TELOPT.BINARY)) {
        this.out('Already transmitting in binary mode.\n');
      } else {
        this.out('Negotiating binary mode on output.\n');
        this.enterBinary(2);
      }
    } else if (!this.myWantStateIsWill(TELOPT.BINARY)) {
      this.out('Already transmitting in network ascii mode.\n');
    } else {
      this.out('Negotiating network ascii mode on output.\n');
      this.leaveBinary(2);
    }
    return true;
  }

  private toggleHelp(): boolean {
    for (const entry of this.toggleList) {
      if (entry.help === null) continue;
      this.out(entry.help !== '' ? `${this.pad15(entry.name)} toggle ${entry.help}\n` : '\n');
    }
    this.out('\n');
    this.out(`${this.pad15('?')} display help information\n`);
    return false;
  }

  private setToggleHelp(enable: boolean): void {
    for (const entry of this.toggleList) {
      if (entry.help === null) continue;
      this.out(entry.help !== '' ? `${this.pad15(entry.name)} ${enable ? 'enable' : 'disable'} ${entry.help}\n` : '\n');
    }
  }

  private getToggle(name: string): Lookup<ToggleEntry> { return generalGet(name, this.toggleList); }
  private getSet(name: string): Lookup<SetEntry> { return generalGet(name, SET_LIST); }

  private charValue(key: keyof TerminalCharacters): number { return this.characters[key]; }

  private toggleCommand(argv: string[]): boolean {
    let result = true;
    if (argv.length < 2) {
      this.err("Need an argument to 'toggle' command.  'toggle ?' for help.\n");
      return false;
    }
    for (const name of argv.slice(1)) {
      const entry = this.getToggle(name);
      if (entry === AMBIGUOUS) {
        this.err(`'${name}': ambiguous argument ('toggle ?' for help).\n`);
        return false;
      }
      if (entry === null) {
        this.err(`'${name}': unknown argument ('toggle ?' for help).\n`);
        return false;
      }
      if (entry.variable !== null) {
        this.toggles[entry.variable] = this.toggles[entry.variable] ? 0 : 1;
        if (entry.action !== null) this.out(`${this.toggles[entry.variable] ? 'Will' : "Won't"} ${entry.action}.\n`);
      }
      if (entry.handler !== null) result = entry.handler(-1) && result;
    }
    return result;
  }

  private setEscapeCharacter(text: string | null): void {
    if (this.characters.rlogin !== DISABLED) {
      this.characters.rlogin = text !== null && text !== '' ? special(text) : DISABLED;
      this.out(`Telnet rlogin escape character is '${control(this.characters.rlogin)}'.\n`);
    } else {
      this.characters.escape = text !== null && text !== '' ? special(text) : DISABLED;
      this.out(`Telnet escape character is '${control(this.characters.escape)}'.\n`);
    }
  }

  private setCommand(argv: string[]): boolean {
    if (argv.length < 2 || argv.length > 3) {
      this.out("Format is 'set Name Value'\n'set ?' for help.\n");
      return false;
    }
    if (argv.length === 2 && (isPrefix(argv[1], '?') !== 0 || isPrefix(argv[1], 'help') !== 0)) {
      for (const entry of SET_LIST) this.out(`${this.pad15(entry.name)} ${entry.help}\n`);
      this.out('\n');
      this.setToggleHelp(true);
      this.out(`${this.pad15('?')} display help information\n`);
      return false;
    }
    const entry = this.getSet(argv[1]);
    if (entry === null) {
      const toggle = this.getToggle(argv[1]);
      if (toggle === null) {
        this.err(`'${argv[1]}': unknown argument ('set ?' for help).\n`);
        return false;
      }
      if (toggle === AMBIGUOUS) {
        this.err(`'${argv[1]}': ambiguous argument ('set ?' for help).\n`);
        return false;
      }
      if (toggle.variable !== null) {
        if (argv.length === 2 || argv[2] === 'on') this.toggles[toggle.variable] = 1;
        else if (argv[2] === 'off') this.toggles[toggle.variable] = 0;
        else {
          this.out("Format is 'set togglename [on|off]'\n'set ?' for help.\n");
          return false;
        }
        if (toggle.action !== null) this.out(`${this.toggles[toggle.variable] ? 'Will' : "Won't"} ${toggle.action}.\n`);
      }
      if (toggle.handler !== null) toggle.handler(1);
    } else if (argv.length !== 3) {
      this.out("Format is 'set Name Value'\n'set ?' for help.\n");
      return false;
    } else if (entry === AMBIGUOUS) {
      this.err(`'${argv[1]}': ambiguous argument ('set ?' for help).\n`);
      return false;
    } else if (entry.kind === 'tracefile') {
      this.tracefile = argv[2];
      this.out(`${entry.name} set to "${this.tracefile}".\n`);
    } else if (entry.char !== null) {
      this.characters[entry.char] = argv[2] === 'off' ? DISABLED : special(argv[2]);
      this.out(`${entry.name} character is '${control(this.characters[entry.char])}'.\n`);
    }
    this.slcCheck();
    return true;
  }

  private unsetCommand(argv: string[]): boolean {
    if (argv.length < 2) {
      this.err("Need an argument to 'unset' command.  'unset ?' for help.\n");
      return false;
    }
    if (isPrefix(argv[1], '?') !== 0 || isPrefix(argv[1], 'help') !== 0) {
      for (const entry of SET_LIST) this.out(`${this.pad15(entry.name)} ${entry.help}\n`);
      this.out('\n');
      this.setToggleHelp(false);
      this.out(`${this.pad15('?')} display help information\n`);
      return false;
    }
    for (const name of argv.slice(1)) {
      const entry = this.getSet(name);
      if (entry === null) {
        const toggle = this.getToggle(name);
        if (toggle === null) {
          this.err(`'${name}': unknown argument ('unset ?' for help).\n`);
          return false;
        }
        if (toggle === AMBIGUOUS) {
          this.err(`'${name}': ambiguous argument ('unset ?' for help).\n`);
          return false;
        }
        if (toggle.variable !== null) {
          this.toggles[toggle.variable] = 0;
          if (toggle.action !== null) this.out(`Won't ${toggle.action}.\n`);
        }
        if (toggle.handler !== null) toggle.handler(0);
      } else if (entry === AMBIGUOUS) {
        this.err(`'${name}': ambiguous argument ('unset ?' for help).\n`);
        return false;
      } else if (entry.kind === 'tracefile') {
        this.tracefile = '(standard output)';
        this.out(`${entry.name} reset to "${this.tracefile}".\n`);
      } else if (entry.char !== null) {
        this.characters[entry.char] = DISABLED;
        this.out(`${entry.name} character is '${control(this.characters[entry.char])}'.\n`);
      }
    }
    return true;
  }

  private doKludgeMode(): boolean {
    this.kludgeLineMode = true;
    this.sendWont(TELOPT.LINEMODE, true);
    this.sendDont(TELOPT.SGA, true);
    this.sendDont(TELOPT.ECHO, true);
    return false;
  }

  private doLineMode(): boolean {
    if (this.kludgeLineMode) this.sendDont(TELOPT.SGA, true);
    this.sendWill(TELOPT.LINEMODE, true);
    this.sendDont(TELOPT.ECHO, true);
    return true;
  }

  private doCharMode(): boolean {
    if (this.kludgeLineMode) this.sendDo(TELOPT.SGA, true);
    else this.sendWont(TELOPT.LINEMODE, true);
    this.sendDo(TELOPT.ECHO, true);
    return true;
  }

  private doLineModeBit(bit: number, on: boolean): boolean {
    if (!this.myWantStateIsWill(TELOPT.LINEMODE)) {
      this.out('?Need to have LINEMODE option enabled first.\n');
      this.out("'mode ?' for help.\n");
      return false;
    }
    this.lmMode([on ? (this.lineMode | bit) : (this.lineMode & ~bit)], true);
    return true;
  }

  private modeHelp(): boolean {
    this.out("format is:  'mode Mode', where 'Mode' is one of:\n\n");
    for (const entry of MODE_LIST) {
      if (entry.help === null) continue;
      this.out(entry.help !== '' ? `${this.pad15(entry.name)} ${entry.help}\n` : '\n');
    }
    return false;
  }

  private modeCommand(argument: string): boolean {
    const entry = generalGet(argument, MODE_LIST);
    if (entry === null) {
      this.err(`Unknown mode '${argument}' ('mode ?' for help).\n`);
    } else if (entry === AMBIGUOUS) {
      this.err(`Ambiguous mode '${argument}' ('mode ?' for help).\n`);
    } else if (entry.needConnect && !this.connected) {
      this.out('?Need to be connected first.\n');
      this.out("'mode ?' for help.\n");
    } else {
      switch (entry.action) {
        case 'character': return this.doCharMode();
        case 'line': return this.doLineMode();
        case 'set': return this.doLineModeBit(entry.bit, true);
        case 'clear': return this.doLineModeBit(entry.bit, false);
        case 'help': return this.modeHelp();
        case 'kludge': return this.doKludgeMode();
        default: break;
      }
    }
    return false;
  }

  private toggleDescription(entry: ToggleEntry): void {
    if (entry.variable !== null && entry.action !== null) {
      this.out(`${this.toggles[entry.variable] ? 'will' : "won't"} ${entry.action}.\n`);
    }
  }

  private setDescription(entry: SetEntry): void {
    if (entry.name === ' ') return;
    if (entry.kind === 'tracefile') this.out(`${this.pad15(entry.name)} "${this.tracefile}"\n`);
    else if (entry.char !== null) this.out(`${this.pad15(entry.name)} [${control(this.characters[entry.char])}]\n`);
  }

  private displayCommand(argv: string[]): boolean {
    if (argv.length === 1) {
      for (const entry of this.toggleList) this.toggleDescription(entry);
      this.out('\n');
      for (const entry of SET_LIST) this.setDescription(entry);
    } else {
      for (const name of argv.slice(1)) {
        const set = this.getSet(name);
        const toggle = this.getToggle(name);
        if (set === AMBIGUOUS || toggle === AMBIGUOUS) {
          this.out(`?Ambiguous argument '${name}'.\n`);
          return false;
        }
        if (set === null && toggle === null) {
          this.out(`?Unknown argument '${name}'.\n`);
          return false;
        }
        if (toggle !== null) this.toggleDescription(toggle);
        if (set !== null) this.setDescription(set);
      }
    }
    this.optionStatus();
    return true;
  }

  private optionStatus(): void {
    const name = (i: number): string => optionName(i) ?? commandName(i) ?? String(i);
    for (let i = 0; i < 256; i++) {
      if (this.doDontResp[i]) {
        this.out(`resp DO_DONT ${name(i)}: ${this.doDontResp[i]}\n`);
        this.out(this.myWantStateIsDo(i) ? `want DO   ${name(i)}\n` : `want DONT ${name(i)}\n`);
      } else if (this.myStateIsDo(i)) {
        this.out(`     DO   ${name(i)}\n`);
      }
      if (this.willWontResp[i]) {
        this.out(`resp WILL_WONT ${name(i)}: ${this.willWontResp[i]}\n`);
        this.out(this.myWantStateIsWill(i) ? `want WILL ${name(i)}\n` : `want WONT ${name(i)}\n`);
      } else if (this.myStateIsWill(i)) {
        this.out(`     WILL ${name(i)}\n`);
      }
    }
  }

  private setEscape(argv: string[]): Promise<boolean> | boolean {
    this.out(`Deprecated usage - please use 'set escape${argv.length > 2 ? ' ' : ''}${argv.length > 2 ? argv[1] : ''}' in the future.\n`);
    if (argv.length > 2) {
      if (argv[1] !== '') this.characters.escape = argv[1].charCodeAt(0) & 0xff;
      this.out(`Escape character is '${control(this.characters.escape)}'.\n`);
      this.fflush();
      return true;
    }
    this.out('new escape character: ');
    this.escapePrompt = true;
    return this.readLine().then((line) => {
      this.escapePrompt = false;
      if (line !== '') this.characters.escape = line.charCodeAt(0) & 0xff;
      this.out(`Escape character is '${control(this.characters.escape)}'.\n`);
      this.fflush();
      return true;
    });
  }

  private toggleCrmod(): boolean {
    this.toggles.crmod = this.toggles.crmod ? 0 : 1;
    this.out("Deprecated usage - please use 'toggle crmod' in the future.\n");
    this.out(`${this.toggles.crmod ? 'Will' : "Won't"} map carriage return on output.\n`);
    this.fflush();
    return true;
  }

  private buildCommandTable(): CommandEntry[] {
    const sub: CommandEntry[] = [
      { name: 'export', help: 'Use local special character definitions', nargs: 0, run: () => this.slcExportCommand() },
      { name: 'import', help: 'Use remote special character definitions', nargs: 0, run: () => this.slcImportCommand(true) },
      { name: 'check', help: 'Verify remote special character definitions', nargs: 0, run: () => this.slcImportCommand(false) },
    ];
    this.slcTable.push(...sub);
    this.deprecatedTable.push(
      { name: 'escape', help: "deprecated command -- use 'set escape' instead", nargs: -1, run: (argv) => this.setEscape(argv) },
      { name: 'crmod', help: "deprecated command -- use 'toggle crmod' instead", nargs: 0, run: () => this.toggleCrmod() },
    );
    return [
      { name: 'close', help: 'close current connection', nargs: 0, run: () => this.bye() },
      { name: 'logout', help: 'forcibly logout remote user and close the connection', nargs: 0, run: () => this.logout() },
      { name: 'display', help: 'display operating parameters', nargs: -1, run: (a) => this.displayCommand(a) },
      { name: 'mode', help: "try to enter line or character mode ('mode ?' for more)", nargs: 1, run: (a) => this.modeCommand(a[1]) },
      { name: 'open', help: 'connect to a site', nargs: -1, run: (a) => this.tn(a) },
      { name: 'quit', help: 'exit telnet', nargs: 0, run: () => this.doQuit() },
      { name: 'send', help: "transmit special characters ('send ?' for more)", nargs: -1, run: (a) => this.sendCommand(a) },
      { name: 'set', help: "set operating parameters ('set ?' for more)", nargs: -1, run: (a) => this.setCommand(a) },
      { name: 'unset', help: "unset operating parameters ('unset ?' for more)", nargs: -1, run: (a) => this.unsetCommand(a) },
      { name: 'status', help: 'print status information', nargs: 0, run: () => this.doStatus(false) },
      { name: 'toggle', help: "toggle operating parameters ('toggle ?' for more)", nargs: -1, run: (a) => this.toggleCommand(a) },
      { name: 'slc', help: 'set treatment of special characters\n', nargs: -2, run: () => false, sub: this.slcTable },
      { name: 'z', help: 'suspend telnet', nargs: 0, run: () => this.suspend() },
      { name: 'environ', help: "change environment variables ('environ ?' for more)", nargs: -1, run: (a) => this.environCommand(a) },
    ];
  }

  private slcExportCommand(): boolean {
    this.slcExportCommandMode();
    return true;
  }

  private slcImportCommand(def: boolean): boolean {
    this.slcImportMode(def);
    return true;
  }

  private suspend(): boolean {
    this.setCommandMode();
    const before = this.host.terminalSize();
    this.host.suspend?.();
    const after = this.host.terminalSize();
    if (this.connected && before !== null && after !== null && (before.rows !== after.rows || before.cols !== after.cols)) this.sendNaws();
    this.setConnectionMode(false);
    return true;
  }

  private environCommand(argv: string[]): boolean {
    if (argv.length < 2) {
      this.err("Need an argument to 'environ' command.  'environ ?' for help.\n");
      return false;
    }
    const entry = generalGet(argv[1], ENVIRON_COMMANDS);
    if (entry === null) {
      this.err(`'${argv[1]}': unknown argument ('environ ?' for help).\n`);
      return false;
    }
    if (entry === AMBIGUOUS) {
      this.err(`'${argv[1]}': ambiguous argument ('environ ?' for help).\n`);
      return false;
    }
    if (entry.narg + 2 !== argv.length) {
      this.err(`Need ${entry.narg < argv.length + 2 ? 'only ' : ''}${entry.narg} argument${entry.narg === 1 ? '' : 's'} to 'environ ${entry.name}' command.  'environ ?' for help.\n`);
      return false;
    }
    switch (entry.name) {
      case 'define': this.environmentDefine(argv[2], argv[3]); break;
      case 'undefine': this.environmentUndefine(argv[2]); break;
      case 'export': this.environmentExport(argv[2], true); break;
      case 'unexport': this.environmentExport(argv[2], false); break;
      case 'send': this.environmentSend(argv[2]); break;
      case 'list': this.environmentList(); break;
      default:
        for (const item of ENVIRON_COMMANDS) {
          if (item.help === null) continue;
          this.out(item.help !== '' ? `${this.pad15(item.name)} ${item.help}\n` : '\n');
        }
        break;
    }
    return true;
  }

  private strtol(text: string): { value: bigint; rest: string; overflow: boolean } {
    const match = /^[ \t\n\v\f\r]*([+-]?)(\d+)/.exec(text);
    if (match === null) return { value: 0n, rest: text, overflow: false };
    const value = BigInt(match[2]) * (match[1] === '-' ? -1n : 1n);
    const overflow = value > 9223372036854775807n || value < -9223372036854775808n;
    return { value, rest: text.slice(match[0].length), overflow };
  }

  private sendCommand(argv: string[]): boolean {
    if (argv.length < 2) {
      this.out("need at least one argument for 'send' command\n");
      this.out("'send ?' for help\n");
      return false;
    }
    let needConnect = 0;
    for (let i = 1; i < argv.length; i++) {
      const entry = generalGet(argv[i], SEND_LIST);
      if (entry === null) {
        this.out(`Unknown send argument '${argv[i]}'\n'send ?' for help.\n`);
        return false;
      }
      if (entry === AMBIGUOUS) {
        this.out(`Ambiguous send argument '${argv[i]}'\n'send ?' for help.\n`);
        return false;
      }
      if (i + entry.narg >= argv.length) {
        this.err(`Need ${entry.narg} argument${entry.narg === 1 ? '' : 's'} to 'send ${entry.name}' command.  'send ${entry.name} ?' for help.\n`);
        return false;
      }
      if (entry.action === 'help') {
        this.sendHelp();
        return false;
      }
      i += entry.narg;
      needConnect += entry.needConnect;
    }
    if (!this.connected && needConnect) {
      this.out('?Need to be connected first.\n');
      this.out("'send ?' for help\n");
      return false;
    }
    let count = 0;
    let success = 0;
    for (let i = 1; i < argv.length; i++) {
      const entry = generalGet(argv[i], SEND_LIST) as SendEntry;
      if (entry.action !== null) {
        count++;
        success += this.sendAction(entry, entry.narg > 0 ? argv[i + 1] : '') ? 1 : 0;
        i += entry.narg;
      } else {
        this.netAdd(IAC, entry.what);
        this.printOption('SENT', IAC, entry.what);
      }
    }
    return count === success;
  }

  private sendAction(entry: SendEntry, name: string): boolean {
    switch (entry.action) {
      case 'escape': this.netAdd(this.characters.escape); return true;
      case 'synch': return this.doSynch();
      case 'getstatus': return this.getStatus();
      case 'do': return this.sendTelnetCommand('do', name);
      case 'dont': return this.sendTelnetCommand('dont', name);
      case 'will': return this.sendTelnetCommand('will', name);
      case 'wont': return this.sendTelnetCommand('wont', name);
      default: return false;
    }
  }

  private sendTelnetCommand(command: 'do' | 'dont' | 'will' | 'wont', name: string): boolean {
    if (isPrefix(name, 'help') !== 0 || isPrefix(name, '?') !== 0) {
      this.out(`Usage: send ${command} <option>\n`);
      this.out('Valid options are:\n\t');
      let column = 8;
      for (const option of TELOPT_NAMES) {
        const length = option.length + 1;
        if (column + length > 65) {
          this.out('\n\t');
          column = 8;
        }
        this.out(` ${option}`);
        column += length;
      }
      this.out('\n');
      return false;
    }
    const found = generalGet(name, TELOPT_NAMES.map((n) => ({ name: n })));
    if (found === AMBIGUOUS) {
      this.err(`'${name}': ambiguous argument ('send ${command} ?' for help).\n`);
      return false;
    }
    let option = -1;
    if (found !== null) {
      option = TELOPT_NAMES.indexOf(found.name);
    } else {
      const parsed = this.strtol(name);
      if (parsed.rest !== '' || parsed.value < 0n || parsed.value > 255n) {
        this.err(`'${name}': unknown argument ('send ${command} ?' for help).\n`);
        return false;
      }
      option = Number(parsed.value);
    }
    if (!this.connected) {
      this.out('?Need to be connected first.\n');
      return false;
    }
    if (command === 'do') this.sendDo(option, true);
    else if (command === 'dont') this.sendDont(option, true);
    else if (command === 'will') this.sendWill(option, true);
    else this.sendWont(option, true);
    return true;
  }

  private sendHelp(): void {
    for (const entry of SEND_LIST) {
      if (entry.help !== null) this.out(`${this.pad15(entry.name)} ${entry.help}\n`);
    }
  }

  private doStatus(notMuch: boolean): boolean {
    if (this.connected) {
      this.out(`Connected to ${this.hostName}.\n`);
      if (!notMuch) {
        const mode = this.connectionMode();
        if (this.myWantStateIsWill(TELOPT.LINEMODE)) {
          this.out('Operating with LINEMODE option\n');
          this.out(`${mode & MODE.EDIT ? 'Local' : 'No'} line editing\n`);
          this.out(`${mode & MODE.TRAPSIG ? 'Local' : 'No'} catching of signals\n`);
          this.slcState();
        } else if (this.kludgeLineMode && !this.myWantStateIsDo(TELOPT.SGA)) {
          this.out('Operating in obsolete linemode\n');
        } else {
          this.out('Operating in single character mode\n');
          if (this.toggles.localchars) this.out('Catching signals locally\n');
        }
        this.out(`${mode & MODE.ECHO ? 'Local' : 'Remote'} character echo\n`);
        if (this.myWantStateIsWill(TELOPT.LFLOW)) this.out(`${mode & MODE.FLOW ? 'Local' : 'No'} flow control\n`);
      }
    } else {
      this.out('No connection.\n');
    }
    this.out(`Escape character is '${control(this.characters.escape)}'.\n`);
    this.fflush();
    return true;
  }

  private bye(): boolean {
    if (!this.connected) {
      this.out("Need to be connected first for `bye'.\n");
      return false;
    }
    this.closeConnection(false);
    return false;
  }

  private doQuit(): boolean {
    this.closeConnection(true);
    this.exit(0);
    return false;
  }

  private logout(): boolean {
    if (!this.connected) {
      this.out("Need to be connected first for `logout'.\n");
      return false;
    }
    this.sendDo(TELOPT.LOGOUT, true);
    this.netFlush();
    return true;
  }

  private toplevelRequested = false;

  private closeConnection(fromQuit: boolean): void {
    if (this.connected) {
      this.detachTransport(true);
      this.out('Connection closed.\n');
      this.connected = false;
      this.initTelnet();
    }
    if (!fromQuit) this.toplevelRequested = true;
  }

  private detachTransport(close: boolean): void {
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];
    const transport = this.transport;
    this.transport = null;
    if (close && transport !== null) transport.close();
  }

  private exit(code: number): void {
    if (this.state === 'exited') return;
    this.detachTransport(true);
    this.setCommandMode();
    this.ttyFlush(false);
    this.fflush();
    this.state = 'exited';
    this.exitCode = code;
    for (const handler of this.exitHandlers) handler(code);
    this.releaseIdle();
  }

  private lineWaiter: ((line: string) => void) | null = null;

  private readLine(): Promise<string> {
    return new Promise((resolve) => { this.lineWaiter = resolve; });
  }

  private cooked = '';

  private commandTop = true;

  private commandAwaiting = false;

  private queue: string[] = [];

  private busy = false;

  private ttyRing: number[] = [];

  private makeArgv(line: string): string[] {
    const argv: string[] = [];
    let i = 0;
    if (line[0] === '!') {
      argv.push('!');
      i = 1;
    }
    const space = /\s/;
    while (i < line.length) {
      while (i < line.length && space.test(line[i])) i++;
      if (i >= line.length) break;
      let word = '';
      let quote = '';
      for (; i < line.length; i++) {
        const c = line[i];
        if (quote !== '') {
          if (c === quote) {
            quote = '';
            continue;
          }
        } else if (c === '\\') {
          i++;
          if (i >= line.length) break;
        } else if (c === '"' || c === "'") {
          quote = c;
          continue;
        } else if (space.test(c)) {
          break;
        }
        word += line[i];
      }
      argv.push(word);
      i++;
    }
    return argv;
  }

  private getCommand(table: CommandEntry[], name: string, main: boolean): CommandEntry | typeof HELP | typeof AMBIGUOUS | null {
    const lower = name.toLowerCase();
    if (lower === '?' || lower === 'h' || lower === 'help') return HELP;
    let found: CommandEntry | null = null;
    for (const entry of table) {
      if (entry.name.toLowerCase() === lower) return entry;
      if (entry.name.toLowerCase().startsWith(lower)) {
        if (found !== null) return AMBIGUOUS;
        found = entry;
      }
    }
    if (main && found === null) return this.getCommand(this.deprecatedTable, name, false);
    return found;
  }

  private describe(entry: CommandEntry): void {
    if (entry.help !== null) this.out(`${entry.name.padEnd(HELP_INDENT)}\t${entry.help}\n`);
  }

  private commandHelp(table: CommandEntry[], argv: string[], main: boolean): void {
    if (argv.length === 1) {
      this.out('Commands may be abbreviated.  Commands are:\n\n');
      for (const entry of table) this.describe(entry);
      return;
    }
    for (const name of argv.slice(1)) {
      const entry = this.getCommand(table, name, main);
      if (entry === HELP) this.out('Print help information\n');
      else if (entry === AMBIGUOUS) this.out(`?Ambiguous help command ${name}\n`);
      else if (entry === null) this.out(`?Invalid help command ${name}\n`);
      else this.out(entry.help !== null ? `${entry.help}\n` : 'No help available\n');
    }
  }

  private async processCommand(table: CommandEntry[], argv: string[], main: boolean): Promise<boolean> {
    const entry = this.getCommand(table, argv[0], main);
    if (entry === HELP) {
      this.commandHelp(table, argv, main);
    } else if (entry === AMBIGUOUS) {
      this.out('?Ambiguous command\n');
    } else if (entry === null) {
      this.out('?Invalid command\n');
    } else if (entry.nargs >= 0 && argv.length !== entry.nargs + 1) {
      this.err('Wrong number of arguments for command.\n');
      this.err(`Try ? ${argv[0]} for help\n`);
    } else if (entry.nargs === -2) {
      if (argv.length < 2) {
        this.err(`\`${argv[0]}' requires a subcommand.\n`);
        this.err(`Try ${argv[0]} ? for help\n`);
        return false;
      }
      return this.processCommand(entry.sub ?? [], argv.slice(1), false);
    } else if (await entry.run(argv)) {
      return true;
    }
    return false;
  }

  private beginCommand(top: boolean, tbuf: string | null): void {
    this.setCommandMode();
    this.commandTop = top;
    if (!top) this.out('\n');
    this.state = 'command';
    this.consumeBuffered(tbuf);
  }

  private consumeBuffered(tbuf: string | null): void {
    if (this.characters.rlogin === DISABLED) this.out(`${this.promptText}`);
    if (tbuf !== null) {
      const end = tbuf.indexOf('\n');
      if (end > 0) {
        const line = tbuf.slice(0, end);
        if (this.characters.rlogin === DISABLED) this.out(`${line}\n`);
        this.enqueueLine(line);
        return;
      }
    }
    if (this.characters.rlogin !== DISABLED) this.out(`${this.promptText}`);
    this.commandAwaiting = true;
  }

  private enqueueLine(line: string): void {
    if (this.lineWaiter !== null) {
      const waiter = this.lineWaiter;
      this.lineWaiter = null;
      waiter(line);
      return;
    }
    this.queue.push(line);
    void this.pump();
  }

  idle(): Promise<void> {
    if (!this.busy && this.queue.length === 0 && !this.connecting) return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.push(resolve); });
  }

  private idleWaiters: Array<() => void> = [];

  dispose(): void {
    if (this.state === 'exited') return;
    this.detachTransport(true);
    this.state = 'exited';
    this.releaseIdle();
  }

  private releaseIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0 && this.state !== 'exited') {
        const line = this.queue.shift() as string;
        if (this.lineWaiter !== null) {
          const waiter = this.lineWaiter;
          this.lineWaiter = null;
          waiter(line);
          continue;
        }
        if (this.state === 'command') await this.commandLine(line);
        else if (this.state === 'session') this.ttyRing.push(...this.bytes(`${line}\n`));
      }
    } finally {
      this.busy = false;
      if (this.queue.length === 0 && !this.connecting) this.releaseIdle();
    }
  }

  private async commandLine(line: string): Promise<void> {
    this.commandAwaiting = false;
    const argv = this.makeArgv(line);
    if (argv.length === 0) {
      this.leaveCommand();
      return;
    }
    const ok = await this.processCommand(this.commandTable, argv, true);
    if (this.state === 'exited') return;
    if (this.toplevelRequested) {
      this.toplevelRequested = false;
      this.toplevel();
      return;
    }
    if (this.state !== 'command') return;
    if (ok) this.leaveCommand();
    else this.consumeBuffered(null);
  }

  private toplevel(): void {
    if (this.startedWithHost) {
      this.exit(0);
      return;
    }
    this.beginCommand(true, null);
  }

  private leaveCommand(): void {
    if (this.commandTop) {
      this.beginCommand(true, null);
      return;
    }
    if (!this.connected) {
      this.toplevel();
      return;
    }
    this.setConnectionMode(false);
    this.state = 'session';
    this.sendQueuedTty();
  }

  private sendQueuedTty(): void {
    this.drainTty();
  }

  private async tn(args: string[]): Promise<boolean> {
    if (this.connected) {
      this.out(`?Already connected to ${this.hostName}\n`);
      return false;
    }
    let argv = args;
    if (argv.length < 2) {
      this.out('(to) ');
      this.openPrompt = true;
      const typed = await this.readLine();
      this.openPrompt = false;
      argv = ['open', ...this.makeArgv(typed)];
    }
    const command = argv[0];
    let user: string | null = null;
    let sourceHost: string | null = null;
    let family: 0 | 4 | 6 = 0;
    let hostText: string | null = null;
    let portText: string | null = null;
    const usage = (): boolean => {
      this.out(`usage: ${command} [-l user] [-a] host-name [port]\n`);
      return false;
    };
    for (let i = 1; i < argv.length;) {
      const arg = argv[i];
      if (isPrefix(arg, '?') !== 0) return usage();
      if (arg === '-l') {
        i++;
        if (i >= argv.length) return usage();
        user = argv[i++];
        continue;
      }
      if (arg === '-b') {
        i++;
        if (i >= argv.length) return usage();
        sourceHost = argv[i++];
        continue;
      }
      if (arg === '-a') {
        i++;
        this.autologin = 1;
        continue;
      }
      if (arg === '-6') {
        i++;
        family = 6;
        continue;
      }
      if (arg === '-4') {
        i++;
        family = 4;
        continue;
      }
      if (hostText === null) {
        hostText = argv[i++];
        continue;
      }
      if (portText === null) {
        portText = argv[i++];
        continue;
      }
      return usage();
    }
    if (hostText === null) return usage();

    if (portText !== null) {
      if (portText[0] === '-') {
        portText = portText.slice(1);
        this.telnetPort = 1;
      } else {
        this.telnetPort = 0;
        if (portText[0] >= '0' && portText[0] <= '9') {
          const parsed = this.strtol(portText);
          if (parsed.overflow) {
            this.err(`telnet: port ${portText} overflows\n`);
            return false;
          }
          if (parsed.value <= 0n || parsed.value >= 65536n) {
            this.err(`telnet: port ${portText} out of range\n`);
            return false;
          }
        }
      }
    } else {
      portText = 'telnet';
      this.telnetPort = 1;
    }

    let source: NetkitAddress | null = null;
    if (sourceHost !== null) {
      const resolved = this.host.resolve(sourceHost, '0', family, true);
      if (!resolved.ok) {
        this.err(`telnet: could not resolve ${sourceHost}: ${resolved.message}\n`);
        return false;
      }
      source = resolved.addresses[0];
    }

    let resolution = this.host.resolve(hostText, portText, family, true);
    if (!resolution.ok && resolution.noName) resolution = this.host.resolve(hostText, portText, family, false);
    if (!resolution.ok || resolution.addresses.length === 0) {
      const reason = resolution.ok ? 'Name or service not known' : resolution.message;
      this.err(`telnet: could not resolve ${hostText}/${portText}: ${reason}\n`);
      return false;
    }

    let transport: NetkitTelnetTransport | null = null;
    let lastReason = '';
    this.connecting = true;
    for (const address of resolution.addresses) {
      this.out(`Trying ${address.text}...\n`);
      const attempt = await this.host.connect(address, resolution.port, source);
      if (attempt.connected) {
        transport = attempt.transport;
        break;
      }
      lastReason = attempt.reason;
    }
    this.connecting = false;
    if (transport === null) {
      this.err(`telnet: Unable to connect to remote host: ${lastReason}\n`);
      return false;
    }

    this.connected = true;
    this.hostName = resolution.canonicalName === null ? hostText : resolution.canonicalName;
    this.transport = transport;
    this.readRunControl(hostText, this.hostName, portText);
    if (this.autologin === 1 && user === null) user = this.defaultUser();
    if (user !== null) {
      this.environmentDefine('USER', user);
      this.environmentExport('USER', true);
    }
    this.doStatus(true);
    this.startSession();
    return true;
  }

  private defaultUser(): string | null {
    const current = this.host.currentUser();
    const named = this.environmentValueFromHost('USER');
    if (named !== null) {
      const known = this.host.lookupUser(named);
      if (known === null || current === null || known.uid === current.uid) return named;
    }
    return current === null ? null : current.name;
  }

  private environmentValueFromHost(name: string): string | null {
    const entry = this.host.environment().find(([n]) => n === name);
    return entry === undefined ? null : entry[1];
  }

  private readRunControl(machine: string, canonical: string, port: string): void {
    if (this.toggles.skiprc) return;
    this.readRc(machine, canonical, port, '/etc/telnetrc');
    const home = this.environmentValueFromHost('HOME');
    if (home !== null) this.readRc(machine, canonical, port, `${home}/.telnetrc`);
  }

  private readRc(m1: string, m2: string, port: string, path: string): void {
    const content = this.host.readFile(path);
    if (content === null) return;
    let gotMachine = false;
    for (const raw of content.split('\n')) {
      let line = raw;
      if (line === '' || line[0] === '#') continue;
      if (gotMachine && !/\s/.test(line[0])) gotMachine = false;
      if (!gotMachine) {
        if (/\s/.test(line[0])) continue;
        if (line.slice(0, m1.length).toLowerCase() === m1.toLowerCase()) line = line.slice(m1.length);
        else if (line.slice(0, m2.length).toLowerCase() === m2.toLowerCase()) line = line.slice(m2.length);
        else if (line.slice(0, 7).toLowerCase() === 'default') line = line.slice(7);
        else continue;
        if (line[0] === ':') {
          if (line.slice(1, 1 + port.length).toLowerCase() === port.toLowerCase()) continue;
          line = line.slice(port.length + 1);
        }
        if (line[0] !== ' ' && line[0] !== '\t' && line !== '') continue;
        gotMachine = true;
      }
      const argv = this.makeArgv(line);
      if (argv.length === 0) continue;
      this.runRcCommand(argv);
    }
  }

  private runRcCommand(argv: string[]): void {
    const entry = this.getCommand(this.commandTable, argv[0], true);
    if (entry === HELP) this.commandHelp(this.commandTable, argv, true);
    else if (entry === AMBIGUOUS) this.out('?Ambiguous command\n');
    else if (entry === null) this.out('?Invalid command\n');
    else if (entry.nargs >= 0 && argv.length !== entry.nargs + 1) {
      this.err('Wrong number of arguments for command.\n');
      this.err(`Try ? ${argv[0]} for help\n`);
    } else if (entry.nargs === -2) {
      this.runRcSub(entry, argv);
    } else {
      void entry.run(argv);
    }
  }

  private runRcSub(entry: CommandEntry, argv: string[]): void {
    if (argv.length < 2) {
      this.err(`\`${argv[0]}' requires a subcommand.\n`);
      this.err(`Try ${argv[0]} ? for help\n`);
      return;
    }
    const sub = this.getCommand(entry.sub ?? [], argv[1], false);
    if (sub !== null && sub !== HELP && sub !== AMBIGUOUS) void sub.run(argv.slice(1));
  }

  private attachTransport(transport: NetkitTelnetTransport): void {
    this.unsubscribe.push(transport.onData((data) => this.receive(data)));
    if (transport.onClose !== undefined) this.unsubscribe.push(transport.onClose(() => this.remoteClosed()));
  }

  private startSession(): void {
    this.state = 'session';
    this.commandAwaiting = false;
    this.setConnectionMode(false);
    if (this.telnetPort) {
      this.sendDo(TELOPT.SGA, true);
      this.sendWill(TELOPT.TTYPE, true);
      this.sendWill(TELOPT.NAWS, true);
      this.sendWill(TELOPT.TSPEED, true);
      this.sendWill(TELOPT.LFLOW, true);
      this.sendWill(TELOPT.LINEMODE, true);
      this.sendWill(TELOPT.ENVIRON, true);
      this.sendDo(TELOPT.STATUS, true);
      if (this.environmentValue('DISPLAY', false) !== null) this.sendWill(TELOPT.XDISPLOC, true);
      if (this.binary) this.enterBinary(this.binary);
    }
    this.netFlush();
    this.ttyFlush();
    if (this.transport !== null) this.attachTransport(this.transport);
  }

  private remoteClosed(): void {
    if (!this.connected || this.state === 'exited') return;
    this.ttyFlush();
    this.detachTransport(false);
    this.setCommandMode();
    this.err('Connection closed by foreign host.\n');
    this.exit(1);
  }

  input(text: string): void {
    if (this.state === 'exited') return;
    if (this.state === 'command' || this.lineWaiter !== null) {
      this.cooked += text;
      for (let end = this.cooked.indexOf('\n'); end >= 0; end = this.cooked.indexOf('\n')) {
        const line = this.cooked.slice(0, end);
        this.cooked = this.cooked.slice(end + 1);
        this.enqueueLine(line);
      }
      return;
    }
    if (this.state !== 'session') return;
    this.ttyRing.push(...this.bytes(text));
    this.drainTty();
  }

  private drainTty(): void {
    while (this.state === 'session' && this.ttyRing.length > 0) this.telsnd();
    this.netFlush();
    this.ttyFlush();
  }

  inputEof(): void {
    if (this.state === 'exited') return;
    if (this.lineWaiter !== null) {
      this.enqueueLine('');
      return;
    }
    if (this.state === 'command') {
      this.closeConnection(true);
      this.exit(0);
      return;
    }
    if (this.state === 'session' && this.localCharsMode(this.globalMode)) this.input(String.fromCharCode(this.characters.eof));
  }

  endOfInput(): void {
    if (this.state === 'exited') return;
    if (this.lineWaiter !== null) {
      this.enqueueLine('');
      return;
    }
    if (this.state === 'command') {
      this.closeConnection(true);
      this.exit(0);
      return;
    }
    if (this.state === 'session') this.remoteClosed();
  }

  signal(name: 'INT' | 'QUIT' | 'TSTP' | 'WINCH'): void {
    if (this.state === 'exited') return;
    switch (name) {
      case 'INT':
        if (this.state === 'command' && this.commandTop) {
          this.exit(130);
          return;
        }
        if (this.toggles.localchars) {
          this.intp();
          this.netFlush();
          this.ttyFlush();
        } else {
          this.exit(130);
        }
        break;
      case 'QUIT':
        if (this.state === 'command' && this.commandTop) {
          this.exit(131);
          return;
        }
        if (this.toggles.localchars) {
          if (this.kludgeLineMode) this.sendBreak();
          else this.sendAbort();
          this.netFlush();
          this.ttyFlush();
        } else {
          this.exit(131);
        }
        break;
      case 'TSTP':
        if (this.characters.rlogin !== DISABLED && this.rloginSuspend()) return;
        if (this.toggles.localchars) {
          this.sendSuspend();
          this.netFlush();
        }
        break;
      case 'WINCH':
        if (this.connected) {
          this.sendNaws();
          this.netFlush();
        }
        break;
      default:
        break;
    }
  }

  async start(argv: readonly string[]): Promise<void> {
    const parsed = this.parseOptions(argv);
    if (parsed === null) return;
    if (this.autologin === -1) this.autologin = this.characters.rlogin === DISABLED ? 0 : 1;
    if (parsed.positional.length > 2) {
      this.usage();
      return;
    }
    if (parsed.positional.length > 0) {
      const args: string[] = [this.programName];
      if (parsed.user !== null) args.push('-l', parsed.user);
      if (parsed.source !== null) args.push('-b', parsed.source);
      if (parsed.family !== 0) args.push(parsed.family === 4 ? '-4' : '-6');
      args.push(...parsed.positional);
      this.startedWithHost = true;
      const ok = await this.tn(args);
      if (this.toplevelRequested) {
        this.toplevelRequested = false;
        this.exit(0);
        return;
      }
      if (this.state === 'session' || this.state === 'exited') return;
      this.exit(ok ? 0 : 1);
      return;
    }
    this.beginCommand(true, null);
  }

  private usage(): void {
    this.err(`Usage: ${this.programName} ${USAGE_OPTIONS}\n`);
    this.exit(1);
  }

  private parseOptions(argv: readonly string[]): { positional: string[]; user: string | null; source: string | null; family: 0 | 4 | 6 } | null {
    const positional: string[] = [];
    let user: string | null = null;
    let source: string | null = null;
    let family: 0 | 4 | 6 = 0;
    const takesArgument = (c: string): boolean => {
      const index = OPTION_STRING.indexOf(c);
      return index >= 0 && OPTION_STRING[index + 1] === ':';
    };
    const posix = this.environmentValueFromHost('POSIXLY_CORRECT') !== null;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--') {
        positional.push(...argv.slice(i + 1));
        break;
      }
      if (arg.length < 2 || arg[0] !== '-') {
        positional.push(arg);
        if (posix) {
          positional.push(...argv.slice(i + 1));
          break;
        }
        continue;
      }
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j];
        const known = c !== ':' && OPTION_STRING.includes(c);
        if (!known) {
          this.err(`${this.invocationName}: invalid option -- '${c}'\n`);
          this.usage();
          return null;
        }
        let value: string | null = null;
        if (takesArgument(c)) {
          if (j + 1 < arg.length) value = arg.slice(j + 1);
          else if (i + 1 < argv.length) value = argv[++i];
          else {
            this.err(`${this.invocationName}: option requires an argument -- '${c}'\n`);
            this.usage();
            return null;
          }
          j = arg.length;
        }
        switch (c) {
          case '4': family = 4; break;
          case '6': family = 6; break;
          case '7': this.eight = 0; break;
          case '8': this.binary = 3; break;
          case 'E':
            this.characters.rlogin = DISABLED;
            this.characters.escape = DISABLED;
            break;
          case 'L': this.binary |= 2; break;
          case 'a': this.autologin = 1; break;
          case 'd': this.toggles.debug = 1; break;
          case 'e': this.setEscapeCharacter(value); break;
          case 'k': this.err(`${this.programName}: -k ignored, no Kerberos V4 support.\n`); break;
          case 'l':
            this.autologin = 1;
            user = value;
            break;
          case 'n': this.tracefile = value ?? this.tracefile; break;
          case 'r': this.characters.rlogin = 0x7e; break;
          case 't': this.err(`${this.programName}: Warning: -t ignored, no TN3270 support.\n`); break;
          case 'x': this.err(`${this.programName}: -x ignored, no encryption support.\n`); break;
          case 'b': source = value; break;
          default: break;
        }
      }
    }
    return { positional, user, source, family };
  }

  private doFlush(): void {
    this.netAdd(IAC, DO, TELOPT.TM);
    this.flushLine = true;
    this.flushOut = true;
    this.ttyFlush(true);
    this.printOption('SENT', DO, TELOPT.TM);
  }

  private xmitAO(): void {
    this.netAdd(IAC, TELCMD.AO);
    this.printOption('SENT', IAC, TELCMD.AO);
    if (this.toggles.autoflush) this.doFlush();
  }

  private xmitEL(): void {
    this.netAdd(IAC, TELCMD.EL);
    this.printOption('SENT', IAC, TELCMD.EL);
  }

  private xmitEC(): void {
    this.netAdd(IAC, TELCMD.EC);
    this.printOption('SENT', IAC, TELCMD.EC);
  }

  private doSynch(): boolean {
    this.netAdd(IAC);
    this.netAdd(TELCMD.DM);
    this.printOption('SENT', IAC, TELCMD.DM);
    return true;
  }

  private getStatus(): boolean {
    if (!this.myWantStateIsDo(TELOPT.STATUS)) {
      this.out('Remote side does not support STATUS option\n');
      return false;
    }
    const frame = [IAC, SB, TELOPT.STATUS, TELQUAL.SEND, IAC, SE];
    this.printSub('>', frame.slice(2));
    this.netAdd(...frame);
    ++this.wantStatusResponse;
    return true;
  }

  private interruptLike(command: number): void {
    this.netAdd(IAC, command);
    this.printOption('SENT', IAC, command);
    this.flushLine = true;
    if (this.toggles.autoflush) this.doFlush();
    if (this.toggles.autosynch) this.doSynch();
  }

  private intp(): void { this.interruptLike(TELCMD.IP); }
  private sendBreak(): void { this.interruptLike(TELCMD.BREAK); }
  private sendAbort(): void { this.interruptLike(TELCMD.ABORT); }
  private sendSuspend(): void { this.interruptLike(TELCMD.SUSP); }

  private sendEof(): void {
    this.netAdd(IAC, TELCMD.xEOF);
    this.printOption('SENT', IAC, TELCMD.xEOF);
  }

  private sendNaws(): void {
    if (!this.myStateIsWill(TELOPT.NAWS)) return;
    const size = this.host.terminalSize();
    if (size === null) return;
    const frame: number[] = [IAC, SB, TELOPT.NAWS];
    const put = (value: number): void => {
      const high = (value >> 8) & 0xff;
      const low = value & 0xff;
      frame.push(high);
      if (high === IAC) frame.push(IAC);
      frame.push(low);
      if (low === IAC) frame.push(IAC);
    };
    put(size.cols);
    put(size.rows);
    frame.push(IAC, SE);
    this.printSub('>', frame.slice(2));
    this.netAdd(...frame);
  }

  private rloginLocal2 = false;

  private rloginSuspend(): boolean {
    if (this.rloginLocal) {
      this.rloginLocal = false;
      this.bol = true;
      this.suspend();
      return true;
    }
    return false;
  }

  private specialChars(c: number): boolean {
    const ch = this.characters;
    if (c === ch.interrupt) {
      this.intp();
      return false;
    }
    if (c === ch.quit) {
      if (this.kludgeLineMode) this.sendBreak();
      else this.sendAbort();
      return false;
    }
    if (c === ch.eof) {
      if (this.myWantStateIsWill(TELOPT.LINEMODE)) {
        this.sendEof();
        return false;
      }
      return true;
    }
    if (c === ch.susp) {
      this.sendSuspend();
      return false;
    }
    if (c === ch.flush) {
      this.xmitAO();
      return false;
    }
    if (!this.localCharsMode(this.globalMode)) {
      if (c === ch.kill) {
        this.xmitEL();
        return false;
      }
      if (c === ch.erase) {
        this.xmitEC();
        return false;
      }
    }
    return true;
  }

  private ringGet(): number | null {
    return this.ttyRing.length > 0 ? (this.ttyRing.shift() as number) : null;
  }

  private ringGets(limit: number): string {
    let text = '';
    while (this.ttyRing.length > 0 && text.length < limit - 1) {
      const c = this.ttyRing.shift() as number;
      text += String.fromCharCode(c);
    }
    return text;
  }

  private strip(c: number): number {
    return c & 0x7f;
  }

  private telsnd(): boolean {
    let didSomething = false;
    for (;;) {
      let c = this.ringGet();
      if (c === null) break;
      didSomething = true;
      let sc = this.strip(c);
      const rlogin = this.characters.rlogin;
      if (rlogin !== DISABLED) {
        if (this.bol) {
          this.bol = false;
          if (sc === rlogin) {
            this.rloginLocal = true;
            continue;
          }
        } else if (this.rloginLocal) {
          this.rloginLocal = false;
          if (sc === 0x2e || c === this.characters.eof) {
            this.bol = true;
            this.beginCommand(false, 'close\n');
            break;
          }
          if (sc === this.characters.susp) {
            this.bol = true;
            this.beginCommand(false, 'z\n');
            break;
          }
          if (sc === this.characters.escape && this.characters.escape !== DISABLED) {
            const rest = this.ringGets(128);
            this.beginCommand(false, rest);
            this.bol = true;
            this.flushLine = true;
            break;
          }
          if (sc !== rlogin) {
            this.ttyRing.unshift(c);
            c = sc = rlogin;
          }
        }
        if (sc === LF || sc === CR) this.bol = true;
      } else if (sc === this.characters.escape && this.characters.escape !== DISABLED) {
        let ignore = false;
        const next = this.ringGet();
        if (next !== null) {
          if (this.strip(next) !== this.characters.escape) this.ttyRing.unshift(next);
          else {
            this.bol = false;
            ignore = true;
          }
        }
        if (!ignore) {
          const rest = this.ringGets(128);
          this.netFlush();
          this.ttyFlush();
          this.beginCommand(false, rest);
          this.bol = true;
          this.flushLine = true;
          break;
        }
      } else {
        this.bol = false;
      }
      if (this.kludgeLineMode && (this.globalMode & MODE.EDIT) && sc === this.characters.echo) {
        let ignore = false;
        const next = this.ringGet();
        if (next !== null) {
          if (this.strip(next) !== this.characters.echo) this.ttyRing.unshift(next);
          else ignore = true;
        }
        if (!ignore) {
          this.dontLocalEcho = !this.dontLocalEcho;
          this.clockEchoToggle = this.clockSystem++;
          this.setConnectionMode(false);
          this.flushLine = true;
          break;
        }
      }
      if (this.localCharsMode(this.globalMode)) {
        if (!this.specialChars(sc)) {
          this.bol = true;
          break;
        }
      }
      if (!this.myWantStateIsWill(TELOPT.BINARY)) {
        switch (c) {
          case LF:
            if (this.localCharsMode(this.globalMode)) this.netAdd(CR);
            this.netAdd(LF);
            this.bol = this.flushLine = true;
            break;
          case CR:
            if (!this.toggles.crlf) this.netAdd(CR, 0);
            else this.netAdd(CR, LF);
            this.bol = this.flushLine = true;
            break;
          case IAC:
            this.netAdd(IAC, IAC);
            break;
          default:
            this.netAdd(c);
            break;
        }
      } else if (c === IAC) {
        this.netAdd(IAC, IAC);
      } else {
        this.netAdd(c);
      }
    }
    return didSomething;
  }

  private receive(data: string): void {
    if (!this.connected || this.state === 'exited') return;
    const bytes = this.bytes(data);
    if (this.toggles.netdata) this.dumpNetwork(bytes);
    this.netRing.push(...bytes);
    this.telrcv();
    this.netFlush();
    this.ttyFlush();
  }

  private netRing: number[] = [];

  private dumpNetwork(bytes: readonly number[]): void {
    if (this.toggles.prettydump) this.out(`<${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}\n`);
    else this.out(`${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}\n`);
  }

  private telrcv(): void {
    while (this.netRing.length > 0 && this.connected) {
      const c = this.netRing.shift() as number;
      switch (this.receiveState) {
        case 'cr':
          this.receiveState = 'data';
          if (c === 0) break;
          if (c === LF && !this.myWantStateIsDo(TELOPT.ECHO) && !this.toggles.crmod) {
            this.ttyAdd(c);
            break;
          }
          this.receiveData(c);
          break;
        case 'data':
          this.receiveData(c);
          break;
        case 'iac':
          this.receiveIac(c);
          break;
        case 'will':
          this.printOption('RCVD', WILL, c);
          this.willOption(c);
          this.receiveState = 'data';
          break;
        case 'wont':
          this.printOption('RCVD', WONT, c);
          this.wontOption(c);
          this.receiveState = 'data';
          break;
        case 'do':
          this.printOption('RCVD', DO, c);
          this.doOption(c);
          if (c === TELOPT.NAWS) {
            this.sendNaws();
          } else if (c === TELOPT.LFLOW) {
            this.localFlow = true;
            this.setCommandMode();
            this.setConnectionMode(false);
          }
          this.receiveState = 'data';
          break;
        case 'dont':
          this.printOption('RCVD', DONT, c);
          this.dontOption(c);
          this.flushLine = true;
          this.setConnectionMode(false);
          this.receiveState = 'data';
          break;
        case 'sb':
          if (c === IAC) this.receiveState = 'se';
          else if (this.subBuffer.length < 64) this.subBuffer.push(c);
          break;
        case 'se':
          this.receiveSubEnd(c);
          break;
        default:
          break;
      }
    }
  }

  private receiveData(c: number): void {
    if (c === IAC) {
      this.receiveState = 'iac';
      return;
    }
    if (c === CR && !this.myWantStateIsDo(TELOPT.BINARY)) {
      if (this.netRing.length > 0) {
        const next = this.netRing.shift() as number;
        if (next === 0) {
          this.ttyAdd(CR);
        } else if (!this.myWantStateIsDo(TELOPT.ECHO) && next === LF) {
          this.ttyAdd(LF);
        } else {
          this.netRing.unshift(next);
          this.ttyAdd(CR);
          if (this.toggles.crmod) this.ttyAdd(LF);
        }
      } else {
        this.receiveState = 'cr';
        this.ttyAdd(CR);
        if (this.toggles.crmod) this.ttyAdd(LF);
      }
      return;
    }
    this.ttyAdd(c);
  }

  private receiveIac(c: number): void {
    switch (c) {
      case WILL: this.receiveState = 'will'; return;
      case WONT: this.receiveState = 'wont'; return;
      case DO: this.receiveState = 'do'; return;
      case DONT: this.receiveState = 'dont'; return;
      case TELCMD.DM:
        this.printOption('RCVD', IAC, TELCMD.DM);
        this.synching = true;
        this.ttyFlush(true);
        this.synching = false;
        break;
      case SB:
        this.subBuffer = [];
        this.receiveState = 'sb';
        return;
      case IAC:
        this.ttyAdd(IAC);
        break;
      default:
        this.printOption('RCVD', IAC, c);
        break;
    }
    this.receiveState = 'data';
  }

  private receiveSubEnd(c: number): void {
    if (c === SE) {
      const data = this.subBuffer;
      this.subBuffer = [];
      this.subOption(data, [IAC, SE]);
      this.receiveState = 'data';
      return;
    }
    if (c !== IAC) {
      const data = this.subBuffer;
      this.subBuffer = [];
      this.printOption('In SUBOPTION processing, RCVD', IAC, c);
      this.subOption(data, [IAC, c]);
      this.receiveState = 'iac';
      this.receiveIac(c);
      return;
    }
    if (this.subBuffer.length < 64) this.subBuffer.push(c);
    this.receiveState = 'sb';
  }
}
