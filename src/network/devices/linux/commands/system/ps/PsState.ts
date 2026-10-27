import type { PsHost } from './PsHost';
import {
  OUTBUF_SIZE, PER_BSD_h, PER_BSD_m, PER_FORCE_BSD, PER_GOOD_o, PER_HPUX_x, PER_IRIX_l, PER_NO_DEFAULT_g, PER_OLD_m, PER_SANE_USER,
  PER_SVR4_x, PER_ZAP_ADDR,
  type DeferredOption, type FormatNode, type HeaderType, type SelectionNode, type SortNode,
} from './PsTypes';

export class PsOutput {
  stdout = '';
  stderr = '';
  interleaved = '';

  out(text: string): void {
    this.stdout += text;
    this.interleaved += text;
  }

  err(text: string): void {
    this.stderr += text;
    this.interleaved += text;
  }
}

const PERSONALITY_NAMES: ReadonlySet<string> = new Set([
  '390', 'aix', 'bsd', 'compaq', 'debian', 'default', 'digital', 'gnu', 'hp', 'hpux', 'irix', 'linux', 'old', 'os390', 'posix', 's390',
  'sco', 'sgi', 'solaris2', 'sunos4', 'svr4', 'sysv', 'tru64', 'unix', 'unix95', 'unix98', 'unknown',
]);

export class PsState {
  allProcesses = false;
  bsdJFormat = 'OL_j';
  bsdLFormat = 'OL_l';
  bsdSFormat: string | null = 'OL_s';
  bsdUFormat = 'OL_u';
  bsdVFormat = 'OL_v';
  bsdCOption = false;
  bsdEOption = false;
  cachedEuid = 0;
  cachedTty = 0;
  forestPrefix = '';
  forestType = '';
  formatFlags = 0;
  formatList: FormatNode[] = [];
  formatModifiers = 0;
  headerGap = -1;
  headerType: HeaderType = 'single';
  includeDeadChildren = false;
  linesToNextHeader = 1;
  lstartFormat: string | null = null;
  negateSelection = false;
  runningOnly = false;
  personality = 0;
  savedPersonalityText = 'You found a bug!';
  preferBsdDefaults = false;
  screenCols = 80;
  screenRows = 24;
  selectionList: SelectionNode[] = [];
  simpleSelect = 0;
  sortList: SortNode[] = [];
  sysvFFormat: string | null = null;
  sysvFlFormat: string | null = null;
  sysvJFormat: string | null = null;
  sysvLFormat: string | null = null;
  threadFlags = 0;
  unixFOption = false;
  userIsNumber = false;
  wchanIsNumber = false;
  signalNames = false;
  deferred: DeferredOption[] = [];
  haveGnuSort = false;
  alreadyParsedSort = false;
  alreadyParsedFormat = false;
  wCount = 0;
  selectBits = 0;
  readonly output = new PsOutput();

  constructor(readonly host: PsHost) {
    this.resetGlobal();
  }

  resetGlobal(): void {
    this.setScreenSize();
    this.setPersonality();
    this.allProcesses = false;
    this.bsdCOption = false;
    this.bsdEOption = false;
    this.cachedEuid = this.host.effectiveUid;
    this.cachedTty = this.host.controllingTty;
    this.forestPrefix = '';
    this.forestType = '';
    this.formatFlags = 0;
    this.formatList = [];
    this.formatModifiers = 0;
    this.headerGap = -1;
    this.headerType = 'single';
    this.includeDeadChildren = false;
    this.linesToNextHeader = 1;
    this.negateSelection = false;
    this.runningOnly = false;
    this.selectionList = [];
    this.simpleSelect = 0;
    this.sortList = [];
    this.threadFlags = 0;
    this.unixFOption = false;
    this.userIsNumber = false;
    this.wchanIsNumber = false;
  }

  resetSortFormat(): void {
    this.deferred = [];
    this.formatList = [];
    this.sortList = [];
    this.haveGnuSort = false;
    this.alreadyParsedSort = false;
    this.alreadyParsedFormat = false;
  }

  private setScreenSize(): void {
    const terminal = this.host.terminal;
    this.screenCols = terminal.columns > 0 ? terminal.columns : 80;
    this.screenRows = terminal.rows > 0 ? terminal.rows : 24;
    if (!terminal.isTerminal) this.screenCols = OUTBUF_SIZE;
    const columns = this.host.environment('COLUMNS');
    if (columns !== undefined && columns !== '') {
      const parsed = strictInteger(columns);
      if (parsed !== null && parsed > 0 && parsed < OUTBUF_SIZE) this.screenCols = parsed;
    }
    const lines = this.host.environment('LINES');
    if (lines !== undefined && lines !== '') {
      const parsed = strictInteger(lines);
      if (parsed !== null && parsed > 0 && parsed < OUTBUF_SIZE) this.screenRows = parsed;
    }
    if (this.screenCols < 9 || this.screenRows < 2) {
      this.output.err(`your ${this.screenCols}x${this.screenRows} screen size is bogus. expect trouble\n`);
    }
  }

  private setPersonality(): void {
    this.personality = 0;
    this.preferBsdDefaults = false;
    this.bsdJFormat = 'OL_j';
    this.bsdLFormat = 'OL_l';
    this.bsdSFormat = 'OL_s';
    this.bsdUFormat = 'OL_u';
    this.bsdVFormat = 'OL_v';
    this.sysvFFormat = null;
    this.sysvFlFormat = null;
    this.sysvJFormat = null;
    this.sysvLFormat = null;
    let name = this.host.environment('PS_PERSONALITY');
    if (name === undefined || name === '') name = this.host.environment('CMD_ENV');
    if (name === undefined || name === '') name = 'unknown';
    const broken = this.host.environment('I_WANT_A_BROKEN_PS');
    if (broken !== undefined) name = 'old';
    if (name.length > 15) return;
    this.savedPersonalityText = name;
    const key = name.toLowerCase();
    if (!PERSONALITY_NAMES.has(key)) return;
    switch (key) {
      case 'bsd':
        this.personality = PER_FORCE_BSD | PER_BSD_h | PER_BSD_m;
        this.preferBsdDefaults = true;
        this.bsdJFormat = 'FB_j';
        this.bsdLFormat = 'FB_l';
        this.bsdUFormat = 'FB_u';
        this.bsdVFormat = 'FB_v';
        return;
      case 'old':
        this.personality = PER_FORCE_BSD | PER_OLD_m;
        this.preferBsdDefaults = true;
        return;
      case 'debian':
      case 'gnu':
        this.personality = PER_GOOD_o | PER_OLD_m;
        this.preferBsdDefaults = true;
        this.sysvFFormat = 'RD_f';
        this.sysvJFormat = 'RD_j';
        this.sysvLFormat = 'RD_l';
        return;
      case 'linux':
        this.personality = PER_GOOD_o | PER_ZAP_ADDR | PER_SANE_USER;
        return;
      case 'aix':
        this.bsdJFormat = 'FB_j';
        this.bsdLFormat = 'FB_l';
        this.bsdUFormat = 'FB_u';
        this.bsdVFormat = 'FB_v';
        return;
      case 'tru64':
      case 'compaq':
      case 'digital':
        this.personality = PER_GOOD_o | PER_BSD_h;
        this.preferBsdDefaults = true;
        this.sysvFFormat = 'F5FMT';
        this.sysvFlFormat = 'FL5FMT';
        this.sysvJFormat = 'JFMT';
        this.sysvLFormat = 'L5FMT';
        this.bsdJFormat = 'JFMT';
        this.bsdLFormat = 'LFMT';
        this.bsdSFormat = 'SFMT';
        this.bsdUFormat = 'UFMT';
        this.bsdVFormat = 'VFMT';
        return;
      case 'sunos4':
        this.personality = PER_NO_DEFAULT_g;
        this.preferBsdDefaults = true;
        this.bsdJFormat = 'FB_j';
        this.bsdLFormat = 'FB_l';
        this.bsdUFormat = 'FB_u';
        this.bsdVFormat = 'FB_v';
        return;
      case 'irix':
      case 'sgi': {
        const xpg = this.host.environment('_XPG');
        if (xpg !== undefined && xpg[0] > '0' && xpg[0] <= '9') return;
        this.personality = PER_IRIX_l;
        return;
      }
      case 'os390':
      case 's390':
      case '390':
        this.sysvJFormat = 'J390';
        return;
      case 'hp':
      case 'hpux':
        this.personality = PER_HPUX_x;
        return;
      case 'svr4':
      case 'sysv':
      case 'sco':
        this.personality = PER_SVR4_x;
        return;
      default:
        return;
    }
  }
}

export function strictInteger(text: string): number | null {
  const match = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.exec(text);
  if (match === null) return null;
  const body = match[2];
  const magnitude = body.startsWith('0x') || body.startsWith('0X') ? parseInt(body.slice(2), 16) : body.length > 1 && body.startsWith('0') ? parseInt(body, 8) : parseInt(body, 10);
  return match[1] === '-' ? -magnitude : magnitude;
}
