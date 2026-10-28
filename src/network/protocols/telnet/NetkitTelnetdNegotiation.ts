import {
  AYT, DO, DONT, IAC, SB, SE, WILL, WONT,
  OPT_ECHO, OPT_NAWS, OPT_NEW_ENVIRON, OPT_REMOTE_FLOW_CONTROL, OPT_STATUS, OPT_SUPPRESS_GO_AHEAD, OPT_TERMINAL_SPEED, OPT_TERMINAL_TYPE,
  OPT_TIMING_MARK, OPT_X_DISPLAY_LOCATION,
  encodeNegotiation, encodeSubnegotiation,
  type TelnetNegotiation, type TelnetSubnegotiation, type TelnetVerb,
} from './TelnetCodec';

const TELQUAL_IS = 0;
const TELQUAL_SEND = 1;
const TELQUAL_INFO = 2;
const ENV_VAR = 0;
const ENV_VALUE = 1;
const ENV_ESC = 2;
const ENV_USERVAR = 3;
const OPT_LOGOUT = 18;
const NTELOPTS = 40;

type Phase = 'terminal' | 'answers' | 'echo' | 'ready';

export interface NetkitTelnetdPeer {
  write(bytes: string): void;
  ready(): void;
  noteTerminalType(name: string): void;
  noteEnvironment(name: string, value: string | null): void;
  logout(): void;
  hostname(): string;
}

const ENVIRONMENT_ALLOWED = ['TERM', 'DISPLAY', 'USER', 'LOGNAME', 'POSIXLY_CORRECT', 'LANG'];

function environmentAllowed(name: string): boolean {
  return ENVIRONMENT_ALLOWED.includes(name) || name.startsWith('LC_');
}

export class NetkitTelnetdNegotiation {
  private readonly hisState = new Array<boolean>(256).fill(false);
  private readonly hisWant = new Array<boolean>(256).fill(false);
  private readonly myState = new Array<boolean>(256).fill(false);
  private readonly myWant = new Array<boolean>(256).fill(false);
  private readonly doDontResp = new Array<number>(256).fill(0);
  private readonly willWontResp = new Array<number>(256).fill(0);
  private readonly answered = new Set<number>();
  private phase: Phase = 'terminal';
  private turnOnSga = false;
  private terminalType: string | null = null;
  private subnegotiationsAsked = false;

  constructor(private readonly peer: NetkitTelnetdPeer) {}

  get isReady(): boolean { return this.phase === 'ready'; }
  get echoes(): boolean { return this.myState[OPT_ECHO]; }
  get terminal(): string | null { return this.terminalType; }

  start(): void {
    this.sendDo(OPT_TERMINAL_TYPE, true);
    this.sendDo(OPT_TERMINAL_SPEED, true);
    this.sendDo(OPT_X_DISPLAY_LOCATION, true);
    this.sendDo(OPT_NEW_ENVIRON, true);
    this.advance();
  }

  receive(negotiations: readonly TelnetNegotiation[], subnegotiations: readonly TelnetSubnegotiation[]): void {
    for (const n of negotiations) this.negotiation(n.verb, n.option);
    for (const s of subnegotiations) this.subnegotiation(s.option, s.params);
    this.advance();
  }

  control(command: number): boolean {
    if (command !== AYT) return false;
    this.peer.write(`\r\n[${this.peer.hostname()} : yes]\r\n`);
    return true;
  }

  private changingHis(option: number): boolean { return this.hisState[option] !== this.hisWant[option]; }

  private send(verb: TelnetVerb, option: number): void { this.peer.write(encodeNegotiation(verb, option)); }

  private sendDo(option: number, init: boolean): void {
    if (init) {
      if ((this.doDontResp[option] === 0 && this.hisState[option]) || this.hisWant[option]) return;
      if (option === OPT_TIMING_MARK) this.hisWant[option] = false;
      else this.hisWant[option] = true;
      this.doDontResp[option]++;
    }
    this.send(DO, option);
  }

  private sendDont(option: number, init: boolean): void {
    if (init) {
      if ((this.doDontResp[option] === 0 && !this.hisState[option]) || !this.hisWant[option]) return;
      this.hisWant[option] = false;
      this.doDontResp[option]++;
    }
    this.send(DONT, option);
  }

  private sendWill(option: number, init: boolean): void {
    if (init) {
      if ((this.willWontResp[option] === 0 && this.myState[option]) || this.myWant[option]) return;
      this.myWant[option] = true;
      this.willWontResp[option]++;
    }
    this.send(WILL, option);
  }

  private sendWont(option: number, init: boolean): void {
    if (init) {
      if ((this.willWontResp[option] === 0 && !this.myState[option]) || !this.myWant[option]) return;
      this.myWant[option] = false;
      this.willWontResp[option]++;
    }
    this.send(WONT, option);
  }

  private negotiation(verb: TelnetVerb, option: number): void {
    switch (verb) {
      case WILL: this.willOption(option); break;
      case WONT: this.wontOption(option); break;
      case DO: this.doOption(option); break;
      case DONT: this.dontOption(option); break;
      default: break;
    }
  }

  private willOption(option: number): void {
    if (this.doDontResp[option]) {
      this.doDontResp[option]--;
      if (this.doDontResp[option] && this.hisState[option]) this.doDontResp[option]--;
    }
    if (this.doDontResp[option] === 0) {
      if (!this.hisWant[option]) {
        let changeOk = false;
        switch (option) {
          case OPT_TIMING_MARK:
            return;
          case OPT_REMOTE_FLOW_CONTROL:
          case OPT_TERMINAL_TYPE:
          case OPT_SUPPRESS_GO_AHEAD:
          case OPT_NAWS:
          case OPT_TERMINAL_SPEED:
          case OPT_X_DISPLAY_LOCATION:
          case OPT_NEW_ENVIRON:
          case 0:
            changeOk = true;
            break;
          default:
            break;
        }
        if (changeOk) {
          this.hisWant[option] = true;
          this.sendDo(option, false);
        } else {
          this.doDontResp[option]++;
          this.sendDont(option, false);
        }
      } else if (option === OPT_ECHO) {
        this.sendDont(option, true);
      }
    }
    this.hisState[option] = true;
  }

  private wontOption(option: number): void {
    if (this.doDontResp[option]) {
      this.doDontResp[option]--;
      if (this.doDontResp[option] && !this.hisState[option]) this.doDontResp[option]--;
    }
    if (this.doDontResp[option] === 0) {
      if (this.hisWant[option]) {
        if (option === OPT_TIMING_MARK) {
          this.hisWant[option] = false;
          return;
        }
        if (option === OPT_TERMINAL_TYPE || option === OPT_TERMINAL_SPEED || option === OPT_X_DISPLAY_LOCATION || option === OPT_NEW_ENVIRON) {
          this.answered.add(option);
        }
        this.hisWant[option] = false;
        if (this.hisState[option]) this.sendDont(option, false);
      }
    }
    this.hisState[option] = false;
  }

  private doOption(option: number): void {
    if (this.willWontResp[option]) {
      this.willWontResp[option]--;
      if (this.willWontResp[option] && this.myState[option]) this.willWontResp[option]--;
    }
    if (this.willWontResp[option] === 0 && !this.myWant[option]) {
      let changeOk = false;
      switch (option) {
        case OPT_ECHO:
        case 0:
          changeOk = true;
          break;
        case OPT_SUPPRESS_GO_AHEAD:
          this.turnOnSga = false;
          changeOk = true;
          break;
        case OPT_STATUS:
          changeOk = true;
          break;
        case OPT_TIMING_MARK:
          this.sendWill(option, false);
          this.myWant[option] = false;
          this.myState[option] = false;
          return;
        case OPT_LOGOUT:
          this.myWant[OPT_LOGOUT] = true;
          this.sendWill(OPT_LOGOUT, false);
          this.myState[OPT_LOGOUT] = true;
          this.peer.logout();
          return;
        default:
          break;
      }
      if (changeOk) {
        this.myWant[option] = true;
        this.sendWill(option, false);
      } else {
        this.willWontResp[option]++;
        this.sendWont(option, false);
      }
    }
    this.myState[option] = true;
  }

  private dontOption(option: number): void {
    if (this.willWontResp[option]) {
      this.willWontResp[option]--;
      if (this.willWontResp[option] && !this.myState[option]) this.willWontResp[option]--;
    }
    if (this.willWontResp[option] === 0 && this.myWant[option]) {
      if (option === OPT_SUPPRESS_GO_AHEAD) {
        this.myWant[option] = false;
        if (this.myState[option]) this.sendWont(option, false);
        this.myState[option] = false;
        this.turnOnSga = !this.turnOnSga;
        if (this.turnOnSga) this.sendWill(option, true);
        return;
      }
      this.myWant[option] = false;
      if (this.myState[option]) this.sendWont(option, false);
    }
    this.myState[option] = false;
  }

  private subnegotiation(option: number, params: readonly number[]): void {
    switch (option) {
      case OPT_TERMINAL_SPEED:
        if (!this.hisState[option]) break;
        this.answered.add(option);
        break;
      case OPT_TERMINAL_TYPE: {
        if (!this.hisState[option]) break;
        this.answered.add(option);
        if (params[0] !== TELQUAL_IS) break;
        this.terminalType = String.fromCharCode(...params.slice(1)).toLowerCase().slice(0, 40);
        this.peer.noteTerminalType(this.terminalType);
        break;
      }
      case OPT_STATUS:
        if (params[0] === TELQUAL_SEND && this.myState[OPT_STATUS]) this.sendStatus();
        break;
      case OPT_X_DISPLAY_LOCATION:
        if (params[0] !== TELQUAL_IS) break;
        this.answered.add(option);
        this.peer.noteEnvironment('DISPLAY', String.fromCharCode(...params.slice(1)));
        break;
      case OPT_NEW_ENVIRON:
        this.environment(params);
        break;
      default:
        break;
    }
  }

  private environment(params: readonly number[]): void {
    const kind = params[0];
    if (kind === TELQUAL_IS) this.answered.add(OPT_NEW_ENVIRON);
    else if (kind !== TELQUAL_INFO) return;
    let at = 1;
    while (at < params.length && params[at] !== ENV_VAR && params[at] !== ENV_USERVAR) at++;
    if (at >= params.length) return;
    let userVariable = params[at] === ENV_USERVAR;
    at++;
    let name = '';
    let value: string | null = null;
    const flush = (): void => {
      if (environmentAllowed(name) || userVariable) this.peer.noteEnvironment(name, value);
    };
    for (; at < params.length; at++) {
      const c = params[at];
      if (c === ENV_VALUE) {
        value = '';
      } else if (c === ENV_VAR || c === ENV_USERVAR) {
        flush();
        userVariable = c === ENV_USERVAR;
        name = '';
        value = null;
      } else {
        const literal = c === ENV_ESC ? params[++at] : c;
        if (literal === undefined) break;
        if (value === null) name += String.fromCharCode(literal);
        else value += String.fromCharCode(literal);
      }
    }
    flush();
  }

  private sendStatus(): void {
    const body: number[] = [TELQUAL_IS];
    for (let option = 0; option < NTELOPTS; option++) {
      if (this.myWant[option]) body.push(WILL, option);
      if (this.hisWant[option]) body.push(DO, option);
    }
    if (this.hisWant[OPT_REMOTE_FLOW_CONTROL]) body.push(SB, OPT_REMOTE_FLOW_CONTROL, 1, SE);
    this.peer.write(String.fromCharCode(IAC, SB, OPT_STATUS, ...body, IAC, SE));
  }

  private advance(): void {
    for (let guard = 0; guard < 8; guard++) {
      if (this.phase === 'terminal') {
        const asked = [OPT_TERMINAL_TYPE, OPT_TERMINAL_SPEED, OPT_X_DISPLAY_LOCATION, OPT_NEW_ENVIRON];
        if (asked.some((option) => this.changingHis(option))) return;
        this.askSubnegotiations();
        this.phase = 'answers';
        continue;
      }
      if (this.phase === 'answers') {
        const outstanding = [OPT_TERMINAL_SPEED, OPT_X_DISPLAY_LOCATION, OPT_NEW_ENVIRON, OPT_TERMINAL_TYPE]
          .some((option) => this.hisState[option] && !this.answered.has(option));
        if (outstanding) return;
        if (!this.myState[OPT_SUPPRESS_GO_AHEAD]) this.sendWill(OPT_SUPPRESS_GO_AHEAD, true);
        this.sendDo(OPT_ECHO, true);
        this.sendDo(OPT_NAWS, true);
        this.sendWill(OPT_STATUS, true);
        this.sendDo(OPT_REMOTE_FLOW_CONTROL, true);
        this.phase = 'echo';
        continue;
      }
      if (this.phase === 'echo') {
        if (this.changingHis(OPT_NAWS)) return;
        if (this.hisWant[OPT_ECHO] && this.hisState[OPT_NAWS] && this.changingHis(OPT_ECHO)) return;
        if (this.hisWant[OPT_ECHO]) this.willOption(OPT_ECHO);
        if (!this.myState[OPT_ECHO]) this.sendWill(OPT_ECHO, true);
        this.phase = 'ready';
        this.peer.ready();
        return;
      }
      return;
    }
  }

  private askSubnegotiations(): void {
    if (this.subnegotiationsAsked) return;
    this.subnegotiationsAsked = true;
    for (const option of [OPT_TERMINAL_SPEED, OPT_X_DISPLAY_LOCATION, OPT_NEW_ENVIRON, OPT_TERMINAL_TYPE]) {
      if (this.hisState[option]) this.peer.write(encodeSubnegotiation(option, [TELQUAL_SEND]));
    }
  }
}

