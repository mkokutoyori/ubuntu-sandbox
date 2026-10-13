import type { EditorFsContext } from './EditorFsContext';
import type { EditorKeyInput } from './EditorKeyInput';
import { dotSwapPathFor } from './editorPaths';
import { NanoWindow, SHORTCUT_BARS_MINIMUM, type ViewportManner } from './nano/NanoWindow';
import { MESSAGE_LEVEL, messageLevel } from './nano/NanoMessages';
import type { MinibarInfo } from './nano/NanoScreen';
import { buildNanoScreen } from './nano/NanoScreen';
import { actualX, breadth, displayString, leadingBytes, parseLineAndColumn, wideness } from './nano/NanoText';
import type { NanoMenuName } from './nano/NanoMenus';
import type { NanoSearchRequest, NanoStart } from './nano/NanoCommandLine';
import { defaultNanoSettings, type NanoSettings } from './nano/NanoSettings';
import type { EditorScreen } from './screen/EditorScreen';

export type NanoMode =
  | 'edit' | 'save-prompt' | 'exit-save-prompt' | 'search'
  | 'replace-search' | 'replace-with' | 'replace-confirm' | 'goto-line'
  | 'help' | 'execute-prompt' | 'read-file-prompt';

/** Column width `^J` (Justify) wraps a paragraph to. */
const JUSTIFY_WIDTH = 72;

const TABSIZE = 8;
const STATUS_LINGER_KEYS = 20;

export interface NanoLaunchOptions {
  readonly settings?: NanoSettings;
  readonly start?: NanoStart | null;
  readonly displayName?: string;
}

export interface PendingReplaceMatch {
  line: number;
  start: number;
  end: number;
  matchText: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ctrl+Left/Right word-jump boundary: any non-whitespace character. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** Search `line` for the next match of `regex` at or after column `fromCol`. */
function execFrom(line: string, regex: RegExp, fromCol: number): RegExpExecArray | null {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  re.lastIndex = fromCol;
  return re.exec(line);
}

/**
 * Headless GNU nano engine. Owns the buffer, cursor, and modal
 * (edit / save-prompt / exit-save-prompt / search) state machine, and
 * drives all filesystem side effects (main file + lock file) through an
 * injected EditorFsContext. No DOM/React dependency, so it can be driven
 * keystroke-by-keystroke from a Vitest test exactly like a real terminal
 * would drive it.
 */
export class NanoEngine {
  private linesArr: string[];
  private _mode: NanoMode = 'edit';
  private _cursorLine = 0;
  private _cursorCol = 0;
  private _modified = false;
  private statusText = '';
  private statusCountdown = 0;
  private statusAlert = false;
  private statusMore = false;
  private messageThisKey = false;
  private get _statusMessage(): string { return this.statusText; }
  private set _statusMessage(value: string) {
    this.statusText = value;
    this.statusCountdown = value === '' ? 0 : STATUS_LINGER_KEYS;
    this.statusAlert = /not found|^\[ Error|invalid in view mode|Cutbuffer is empty|^\[ (Invalid|Empty search string|Too tiny|Not possible)/.test(value);
    this.statusMore = false;
    if (value !== '') this.messageThisKey = true;
  }
  private readonly window: NanoWindow;
  private manner: ViewportManner = 'centering';
  private sized = false;
  private startPlacement: 'hugfloor' | 'centering' | null = null;
  private reportSizePending = false;
  private tally: number | null = null;
  private marginPending = false;
  readonly settings: NanoSettings;
  private readonly live: { -readonly [K in keyof NanoSettings]: NanoSettings[K] };
  private readonly _readOnly: boolean;
  private readonly titleName: string;
  private _exited = false;
  private _savedOnExit = false;
  private saveFileNameBuffer: string;
  private gotoLineBuffer = '';
  private executeCmdBuffer = '';
  private readFileBuffer = '';
  /** Cursor position within whichever single-line prompt field is
   *  currently active (search/replace/save-name/goto-line/execute/
   *  read-file) — only one prompt is ever open at once, so one shared
   *  field suffices. Reset to the field's length wherever that field is
   *  freshly populated (prompt opened, prefilled, history recall). */
  private _promptCursor = 0;
  /** Set by ^X→Y: the save-prompt this opens must exit on a successful write, not just return to editing. */
  private exitAfterSave = false;
  private caseSensitive = false;
  private searchDir: 'forward' | 'backward' = 'forward';
  private searchQueryBuffer = '';
  private lastSearchTerm = '';
  // Up/Down history recall in the Search: prompt, scoped to this session.
  private searchHistoryList: string[] = [];
  private historyNavIndex: number | null = null;
  private historyNavStash = '';
  private useRegex = false;
  private replaceSearchBuffer = '';
  private replaceWithBuffer = '';
  private replaceState: {
    regex: RegExp; replacement: string; currentLine: number; currentCol: number; totalReplaced: number;
    originLine: number; originCol: number; wrapped: boolean; originEdittop: number; originFirstcolumn: number;
  } | null = null;
  private _pendingReplaceMatch: PendingReplaceMatch | null = null;
  private cutBuffer: { kind: 'lines'; lines: string[] } | { kind: 'chars'; text: string } | null = null;
  private lastActionWasCut = false;
  /** Set by ^6/M-A (Set Mark); the region runs from here to the cursor. */
  private markLine: number | null = null;
  private markCol: number | null = null;
  private readonly lockPath: string;

  // Undo/redo (Alt+U / Alt+E — real nano's M-U/M-E), multi-level, with
  // real nano's action-grouping: a run of consecutive keystrokes of the
  // same coalescable kind (typing, or Backspace, or Delete) is one undo
  // step; a cursor move or a different action kind starts a new step.
  private undoStack: { lines: string[]; cursorLine: number; cursorCol: number }[] = [];
  private redoStack: { lines: string[]; cursorLine: number; cursorCol: number }[] = [];
  private lastEditKind: 'type' | 'backspace' | 'delete' | null = null;

  constructor(
    private readonly fs: EditorFsContext,
    public readonly filePath: string,
    initialContent: string,
    isNewFile: boolean,
    readOnly = false,
    initialCursor?: { line: number; col?: number },
    showLineNumbers = false,
    launch: NanoLaunchOptions = {},
  ) {
    this.settings = launch.settings ?? defaultNanoSettings({ view: readOnly, linenumbers: showLineNumbers });
    this.live = { ...this.settings };
    this._readOnly = this.settings.view;
    this.titleName = launch.displayName ?? filePath;
    this.window = new NanoWindow(
      { lineCount: () => this.linesArr.length, lineAt: (index) => this.linesArr[index] ?? '' },
      () => ({
        softwrap: this.live.softwrap,
        tabsize: TABSIZE,
        lineNumbers: this.live.linenumbers && !this.marginPending,
        zero: this.live.zero,
        minibar: this.live.minibar,
        emptyline: this.live.emptyline,
        nohelp: this.live.nohelp,
      }),
    );
    this.linesArr = initialContent.length === 0 ? [''] : initialContent.split('\n');
    this.ensureTrailingBlankLine();
    if (filePath === '') this._statusMessage = '[ Welcome to nano.  For basic help, type Ctrl+G. ]';
    else if (isNewFile) this._statusMessage = '[ New File ]';
    else if (!this.live.minibar && !this.live.zero) this._statusMessage = `[ Read ${this.writtenLineCount()} line${this.writtenLineCount() === 1 ? '' : 's'} ]`;
    this.reportSizePending = true;
    this.saveFileNameBuffer = this.titleName;
    // GNU nano creates a `.<file>.swp` lock file for the duration of the
    // editing session to prevent two nano instances from editing the same
    // file concurrently; removed on clean exit (see swapFilePath below).
    // View mode (-v) never locks — it never intends to write. A genuinely
    // unnamed buffer (filePath === '') has no real file to protect yet —
    // resolving '' would collapse to the cwd's own directory path — so no
    // lock is created until a real name exists (Write Out gives it one).
    this.lockPath = filePath === '' ? '' : dotSwapPathFor(fs.resolvePath(filePath));
    if (!this._readOnly && this.lockPath !== '') this.fs.writeFile(this.lockPath, `nano lock: ${filePath}\n`);
    const start = launch.start ?? (initialCursor ? { line: initialCursor.line, column: initialCursor.col ?? 0, search: null, caseSensitive: null, regex: null, alerts: [] } : null);
    if (start !== null) this.applyStart(start);
  }

  // ── Public state (read-only) ──────────────────────────────────────

  get content(): string { return this.lines.join('\n'); }
  /** What gets written to disk: buffer content plus the trailing newline nano always restores on save. */
  private serialize(): string {
    const body = this.linesArr.slice();
    if (body[body.length - 1] === '') body.pop();
    return body.length === 0 ? '' : body.join('\n') + '\n';
  }

  private locationMessage(): string {
    const totalLines = this.linesArr.length;
    const line = this._cursorLine + 1;
    const column = this.window.columnOf(this._cursorLine, this._cursorCol) + 1;
    const fullWidth = this.window.columnOf(this._cursorLine, this.line(this._cursorLine).length) + 1;
    const fullSize = [...this.serialize()].length;
    let before = 0;
    for (let i = 0; i < this._cursorLine; i++) before += [...this.line(i)].length + 1;
    before += [...this.line(this._cursorLine).slice(0, this._cursorCol)].length;
    const pct = (part: number, whole: number): number => (whole === 0 ? 0 : Math.floor((100 * part) / whole));
    const pad = (n: number, width: number): string => String(n).padStart(width, ' ');
    const lineWidth = Math.max(2, String(totalLines).length);
    const sizeWidth = Math.max(2, String(fullSize).length);
    return `[ line ${pad(line, lineWidth)}/${totalLines} (${pad(pct(line, totalLines), 2)}%), `
      + `col ${pad(column, 2)}/${pad(fullWidth, 2)} (${pad(pct(column, fullWidth), 3)}%), `
      + `char ${pad(before, sizeWidth)}/${fullSize} (${pad(pct(before, fullSize), 2)}%) ]`;
  }

  private ensureTrailingBlankLine(): void {
    if (this.linesArr[this.linesArr.length - 1] !== '') this.linesArr.push('');
  }

  private writtenLineCount(): number {
    return this.linesArr.length - 1;
  }
  get lines(): readonly string[] {
    return this.linesArr.length > 1 ? this.linesArr.slice(0, -1) : this.linesArr;
  }
  get bufferLines(): readonly string[] { return this.linesArr; }
  get mode(): NanoMode { return this._mode; }
  get cursorLine(): number { return this._cursorLine; }
  get cursorCol(): number { return this._cursorCol; }
  get modified(): boolean { return this._modified; }
  get statusMessage(): string { return this._statusMessage; }
  get exited(): boolean { return this._exited; }
  get savedOnExit(): boolean { return this._savedOnExit; }
  get saveFileName(): string { return this.saveFileNameBuffer; }
  /** Cursor offset within the currently active prompt field (search/replace/save-name/goto-line/execute/read-file). */
  get promptCursor(): number { return this._promptCursor; }
  get gotoLineQuery(): string { return this.gotoLineBuffer; }
  get executeCommandQuery(): string { return this.executeCmdBuffer; }
  get readFileQuery(): string { return this.readFileBuffer; }
  /** Real nano's M-C toggle inside a search/replace prompt (default: case-insensitive). */
  get caseSensitiveSearch(): boolean { return this.caseSensitive; }
  /** Real nano's M-B toggle inside the search prompt (default: forward). */
  get searchDirection(): 'forward' | 'backward' { return this.searchDir; }
  /** A compact reference of the bindings this engine actually implements — shown by ^G. */
  get helpText(): string {
    return [
      'GNU nano Help Text',
      '',
      'The nano editor is a small, free text editor.',
      '',
      'Key bindings:',
      '  ^G  Display this help text',
      '  ^X  Exit / close a prompt',
      '  ^O  Write the current buffer to disk',
      '  ^R  Insert another file at the cursor',
      '  ^T  Insert the output of a shell command',
      '  ^W  Search for text (M-C case sensitive, M-R regexp, M-B backwards)',
      '  ^\\  Search and replace text',
      '  ^K  Cut the current line',
      '  ^U  Paste the last cut text',
      '  ^J  Justify the current paragraph',
      '  ^_  Go to a specific line and column',
      '  ^C  Show the current cursor position',
      '  ^Y  Scroll up one page',
      '  ^V  Scroll down one page',
      '  M-U Undo the last action',
      '  M-E Redo the last undone action',
      '',
      'Press ^X to close this help screen.',
    ].join('\n');
  }
  get searchQuery(): string { return this.searchQueryBuffer; }
  get swapFilePath(): string { return this.lockPath; }
  get swapFileExists(): boolean { return this.fs.exists(this.lockPath); }
  /** True when opened with `-v` (view mode) — real nano refuses all edits and offers no Write Out. */
  get isReadOnly(): boolean { return this._readOnly; }
  /** `nano -l`/`--linenumbers` at open, toggled at runtime by M-#. */
  get lineNumbersShown(): boolean { return this.live.linenumbers; }
  /** Real nano's regex-search toggle (Meta+R / Alt+R inside a search or replace prompt). */
  get regexSearchEnabled(): boolean { return this.useRegex; }
  get replaceSearchQuery(): string { return this.replaceSearchBuffer; }
  get replaceWithText(): string { return this.replaceWithBuffer; }
  get pendingReplaceMatch(): PendingReplaceMatch | null { return this._pendingReplaceMatch; }

  // ── Key dispatch ─────────────────────────────────────────────────

  applyKey(k: EditorKeyInput): void {
    if (this._exited) return;
    if (this.statusCountdown > 0 && --this.statusCountdown === 0) {
      this.statusText = '';
      this.statusAlert = false;
      this.statusMore = false;
    }
    this.messageThisKey = false;
    this.manner = 'centering';
    this.verticalKey = false;
    if (this.bareDisplay()) this.wipeStatus();
    const wasPrompting = this.isPrompting();
    if (wasPrompting && k.alt && k.key.toLowerCase() === 'x') this.toggleHelpInPrompt();
    else this.dispatchKey(k);
    if ((wasPrompting || this.isPrompting()) && !this.messageThisKey) this.wipeStatus();
    this.ensureTrailingBlankLine();
    if (!this.verticalKey) this.placeWant = this.window.columnOf(this._cursorLine, this._cursorCol);
    if (this.reportsPositionAsMessage() && this._mode === 'edit' && !this.messageThisKey) this._statusMessage = this.locationMessage();
    this.followCursor();
    this.makeRoomForMessage();
    this.settleTally();
  }

  private makeRoomForMessage(): void {
    if (!this.zeroMode() || this.isPrompting() || messageLevel(this.statusText) <= MESSAGE_LEVEL.hush) return;
    if (this.window.cursorRow !== this.window.editRows - 1) return;
    this.window.scroll(true);
    this.window.cursorRow = this.window.place({ line: this._cursorLine, col: this._cursorCol }).row;
  }

  private settleTally(): void {
    const drawn = this.minibarMode() && this.window.cols > 35 && !this.isPrompting() && messageLevel(this.statusText) < MESSAGE_LEVEL.remark;
    this.tally = this.reportSizePending && drawn ? this.writtenLineCount() : null;
    if (drawn) this.reportSizePending = false;
  }

  private reportsPositionAsMessage(): boolean {
    return this.live.constantshow && !this.live.minibar && !this.live.zero;
  }

  private minibarInfo(messageExpired: boolean): MinibarInfo | null {
    const prompting = this.isPrompting() || this._mode === 'help';
    if (!this.minibarMode() || prompting) return null;
    if (!messageExpired && messageLevel(this.statusText) >= MESSAGE_LEVEL.remark) return null;
    const text = this.line(this._cursorLine);
    const code = this._cursorCol < text.length
      ? `U+${text.codePointAt(this._cursorCol)!.toString(16).toUpperCase().padStart(4, '0')}`
      : this._cursorLine < this.linesArr.length - 1 ? 'U+000A' : '  ----';
    return {
      name: this.titleName === '' ? '(nameless)' : this.titleName,
      modified: this._modified,
      line: this._cursorLine + 1,
      column: this.window.columnOf(this._cursorLine, this._cursorCol) + 1,
      lineCount: this.tally,
      showPosition: this.live.constantshow,
      hex: code,
      stateLetters: this.live.stateflags ? this.stateLetters() : null,
      percent: Math.floor((100 * (this._cursorLine + 1)) / this.linesArr.length),
    };
  }

  clickAt(row: number, col: number): void {
    if (this._mode !== 'edit') return;
    const window = this.window;
    const top = window.layout.editFrom;
    if (row < top || row >= top + window.editRows) return;
    const at = { line: window.edittop, leftedge: window.firstcolumn };
    window.goForward(row - top, at);
    const text = this.line(at.line);
    let column = Math.max(0, col - window.margin);
    if (this.live.softwrap) column += at.leftedge;
    else if (at.line === this._cursorLine) column += window.pageStart(window.columnOf(this._cursorLine, this._cursorCol));
    this._cursorLine = at.line;
    this._cursorCol = actualX(text, column, TABSIZE);
    this.lastEditKind = null;
    this.manner = 'flowing';
    this.placeWant = window.columnOf(this._cursorLine, this._cursorCol);
    this.verticalKey = true;
    this.followCursor();
  }

  get softwrapEnabled(): boolean { return this.live.softwrap; }

  private searchPromptLabel(replacing: boolean): string {
    const replaceNote = replacing ? (this.markLine === null ? ' (to replace)' : ' (to replace) in selection') : '';
    return `Search${this.caseSensitive ? ' [Case Sensitive]' : ''}${this.useRegex ? ' [Regexp]' : ''}`
      + `${this.searchDir === 'backward' ? ' [Backwards]' : ''}${replaceNote}${this.searchDefaultNote()}`;
  }

  private searchDefaultNote(): string {
    if (this.lastSearchTerm === '') return '';
    const limit = Math.floor(this.window.cols / 3);
    const shown = displayString(this.lastSearchTerm, 0, limit, { isData: false, isPrompt: false, softwrap: false, tabsize: TABSIZE });
    return ` [${shown.cells.join('')}${breadth(this.lastSearchTerm, TABSIZE) > limit ? '...' : ''}]`;
  }

  private promptView(): { label: string; answer: string; menu: NanoMenuName } | null {
    switch (this._mode) {
      case 'save-prompt': return { label: this.markLine !== null && !this.exitAfterSave ? 'Write Selection to File' : 'File Name to Write', answer: this.saveFileNameBuffer, menu: 'write-out' };
      case 'search': return { label: this.searchPromptLabel(false), answer: this.searchQueryBuffer, menu: 'search' };
      case 'replace-search': return { label: this.searchPromptLabel(true), answer: this.replaceSearchBuffer, menu: 'replace' };
      case 'replace-with': return { label: 'Replace with', answer: this.replaceWithBuffer, menu: 'replace-with' };
      case 'goto-line': return { label: 'Enter line number, column number', answer: this.gotoLineBuffer, menu: 'goto' };
      case 'execute-prompt': return { label: 'Command to execute', answer: this.executeCmdBuffer, menu: 'execute' };
      case 'read-file-prompt': return { label: 'File to insert [from ./]', answer: this.readFileBuffer, menu: 'read-file' };
      default: return null;
    }
  }

  get screen(): EditorScreen {
    const live = this.paintScreen(false);
    const level = messageLevel(this.statusText);
    const transient = this.bareDisplay() && level > MESSAGE_LEVEL.hush && level < MESSAGE_LEVEL.alert && level !== MESSAGE_LEVEL.info;
    if (!transient || this.isPrompting()) return live;
    return { ...live, hold: { millis: 1500, then: this.paintScreen(true) } };
  }

  private minibarMode(): boolean {
    return this.live.minibar && !this.live.zero && this.window.rows > 1;
  }

  private zeroMode(): boolean {
    return this.live.zero && this.window.rows > 1;
  }

  private bareDisplay(): boolean {
    return this.minibarMode() || this.zeroMode();
  }

  private paintScreen(messageExpired: boolean): EditorScreen {
    const prompt = this.promptView();
    const hidden = messageExpired || (this.bareDisplay() && messageLevel(this.statusText) < MESSAGE_LEVEL.remark);
    const message = hidden ? '' : this.statusText.replace(/^\[ (.*) \]$/, '$1');
    return buildNanoScreen({
      window: this.window,
      lines: this.linesArr,
      cursor: { line: this._cursorLine, col: this._cursorCol },
      mark: this.markLine === null ? null : { line: this.markLine, col: this.markCol ?? 0 },
      spotlight: this._pendingReplaceMatch === null ? null : { line: this._pendingReplaceMatch.line, start: this._pendingReplaceMatch.start, end: this._pendingReplaceMatch.end },
      tabsize: TABSIZE,
      softwrap: this.live.softwrap,
      title: {
        name: this._mode === 'help' ? 'Main nano help text' : this.titleName === '' ? 'New Buffer' : this.titleName,
        state: this._mode === 'help' ? '' : this._readOnly ? 'View' : this._modified ? 'Modified' : '',
        branding: 'GNU nano 7.2',
        flags: this.live.stateflags ? { letters: this.stateLetters(), modified: this._modified } : null,
      },
      status: message === '' ? null : { text: message, alert: this.statusAlert, more: this.statusMore },
      minibar: this.minibarInfo(messageExpired),
      prompt: prompt === null ? null : { label: prompt.label, answer: prompt.answer, cursor: this._promptCursor },
      yesNo: this._mode === 'exit-save-prompt'
        ? { question: 'Save modified buffer?', withAll: false }
        : this._mode === 'replace-confirm' ? { question: 'Replace this instance?', withAll: true } : null,
      menu: this._mode === 'help' ? 'help' : prompt === null ? 'main' : prompt.menu,
      helpLines: this._mode === 'help' ? this.helpText.split('\n') : null,
    });
  }

  private toggleHelpLines(): void {
    this.verticalKey = true;
    this.manner = 'flowing';
    if (this.window.rows < SHORTCUT_BARS_MINIMUM) {
      this._statusMessage = '[ Too tiny ]';
      return;
    }
    this.live.nohelp = !this.live.nohelp;
    this.window.align();
    if (!this.bareInterface()) this._statusMessage = `[ Help mode ${this.live.nohelp ? 'disabled' : 'enabled'} ]`;
  }

  private toggleHiddenInterface(): void {
    this.verticalKey = true;
    this.manner = 'flowing';
    this.live.zero = !this.live.zero;
    this.window.align();
    this.wipeStatus();
  }

  private toggleHelpInPrompt(): void {
    this.verticalKey = true;
    this.manner = 'flowing';
    this.live.nohelp = !this.live.nohelp;
    this.window.align();
  }

  private bareInterface(): boolean {
    return this.live.minibar || this.live.zero || this.window.rows === 1;
  }

  private toggleConstantShow(): void {
    this.verticalKey = true;
    if (this.window.rows === 1) {
      this._statusMessage = '[ Too tiny ]';
      return;
    }
    if (this.live.zero) {
      this._statusMessage = '[ Not possible ]';
      return;
    }
    this.live.constantshow = !this.live.constantshow;
    if (!this.live.minibar) this.wipeStatus();
  }

  private stateLetters(): string {
    return (this.live.autoindent ? 'I' : ' ') + (this.markLine !== null ? 'M' : ' ')
      + (this.live.breaklonglines ? 'L' : ' ') + ' ' + (this.live.softwrap ? 'S' : ' ');
  }

  private moveHome(): void {
    this.manner = 'flowing';
    this.lastEditKind = null;
    if (this.live.softwrap) {
      const column = this.window.columnOf(this._cursorLine, this._cursorCol);
      const chunk = this.window.chunkLeft(this._cursorLine, column);
      if (this._cursorCol === chunk.index) {
        this._cursorCol = 0;
      } else {
        this._cursorCol = chunk.index;
        this.placeWant = chunk.leftedge;
        this.verticalKey = true;
      }
      return;
    }
    this._cursorCol = 0;
  }

  private moveEnd(): void {
    this.manner = 'flowing';
    this.lastEditKind = null;
    const length = this.line(this._cursorLine).length;
    if (this.live.softwrap) {
      const column = this.window.columnOf(this._cursorLine, this._cursorCol);
      const chunk = this.window.chunkRight(this._cursorLine, column);
      if (this._cursorCol === chunk.index) {
        this._cursorCol = length;
      } else {
        this._cursorCol = chunk.index;
        this.placeWant = chunk.rightedge;
        this.verticalKey = true;
      }
      return;
    }
    this._cursorCol = length;
  }

  private wipeStatus(): void {
    this.statusText = '';
    this.statusCountdown = 0;
    this.statusAlert = false;
    this.statusMore = false;
  }

  private followCursor(): void {
    this.window.follow(this.manner, { line: this._cursorLine, col: this._cursorCol });
  }

  resize(rows: number, cols: number): void {
    if (this.sized && (rows !== this.window.rows || cols !== this.window.cols)) this.wipeStatus();
    const first = !this.sized;
    this.sized = true;
    const cursor = { line: this._cursorLine, col: this._cursorCol };
    this.window.resize(rows, cols, cursor);
    this.settleTally();
    if (first && this.startPlacement !== null) {
      this.marginPending = true;
      this.window.align();
      if (this.startPlacement === 'hugfloor') this.window.hugFloor(cursor);
      else this.window.follow('recentering', cursor);
      this.marginPending = false;
      this.window.align();
      this.window.follow('centering', cursor);
    }
    if (this.reportsPositionAsMessage() && this._mode === 'edit' && this.statusText === '') this._statusMessage = this.locationMessage();
  }

  scrollView(up: boolean, count: number): void {
    for (let i = 0; i < count; i++) this.scrollRow(up);
    this.window.cursorRow = this.window.place({ line: this._cursorLine, col: this._cursorCol }).row;
  }

  private scrollRow(forward: boolean): void {
    const window = this.window;
    if (!forward) {
      if (window.edittop === 0 && window.firstcolumn === 0) return;
      if (window.cursorRow === window.editRows - 1) this.moveRows(1, false);
      if (window.editRows > 1) window.scroll(false);
    } else {
      if (window.cursorRow === 0) this.moveRows(1, true);
      const more = window.edittop < this.linesArr.length - 1
        || (this.live.softwrap && window.extraChunksIn(window.edittop) > window.chunkFor(window.firstcolumn, window.edittop));
      if (window.editRows > 1 && more) window.scroll(true);
    }
    window.cursorRow = window.place({ line: this._cursorLine, col: this._cursorCol }).row;
  }

  private dispatchKey(k: EditorKeyInput): void {
    switch (this._mode) {
      case 'edit': return this.applyEditKey(k);
      case 'save-prompt': return this.applySavePromptKey(k);
      case 'exit-save-prompt': return this.applyExitSavePromptKey(k);
      case 'search': return this.applySearchKey(k);
      case 'replace-search': return this.applyReplaceSearchKey(k);
      case 'replace-with': return this.applyReplaceWithKey(k);
      case 'replace-confirm': return this.applyReplaceConfirmKey(k);
      case 'goto-line': return this.applyGotoLineKey(k);
      case 'help': return this.applyHelpKey(k);
      case 'execute-prompt': return this.applyExecutePromptKey(k);
      case 'read-file-prompt': return this.applyReadFilePromptKey(k);
    }
  }

  /**
   * Insert pasted text at the cursor (edit mode) or at the active
   * prompt field's cursor (search/replace/save-name — single-line, so
   * embedded newlines are dropped past the first). No bracketed-paste
   * distinction is modeled: characters land exactly as if typed very
   * fast, so a literal Tab in the clipboard still inserts `\t` even
   * though the Tab *key* is otherwise unbound in edit mode.
   */
  applyPaste(text: string): void {
    if (this._exited || !text) return;
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const firstLine = normalized.split('\n')[0];
    switch (this._mode) {
      case 'edit':
        this.pasteIntoBuffer(normalized);
        return;
      case 'save-prompt':
        this.insertIntoPromptField(() => this.saveFileNameBuffer, (v) => { this.saveFileNameBuffer = v; }, firstLine);
        return;
      case 'search':
        this.insertIntoPromptField(() => this.searchQueryBuffer, (v) => { this.searchQueryBuffer = v; }, firstLine);
        return;
      case 'replace-search':
        this.insertIntoPromptField(() => this.replaceSearchBuffer, (v) => { this.replaceSearchBuffer = v; }, firstLine);
        return;
      case 'replace-with':
        this.insertIntoPromptField(() => this.replaceWithBuffer, (v) => { this.replaceWithBuffer = v; }, firstLine);
        return;
      case 'goto-line':
        this.insertIntoPromptField(() => this.gotoLineBuffer, (v) => { this.gotoLineBuffer = v; }, firstLine);
        return;
      case 'execute-prompt':
        this.insertIntoPromptField(() => this.executeCmdBuffer, (v) => { this.executeCmdBuffer = v; }, firstLine);
        return;
      case 'read-file-prompt':
        this.insertIntoPromptField(() => this.readFileBuffer, (v) => { this.readFileBuffer = v; }, firstLine);
        return;
      default:
        return;
    }
  }

  private pasteIntoBuffer(text: string): void {
    if (this._readOnly) return;
    this.beginDiscreteEdit();
    for (const ch of text) {
      if (ch === '\n') {
        const cur = this.line(this._cursorLine);
        const before = cur.slice(0, this._cursorCol);
        const after = cur.slice(this._cursorCol);
        this.linesArr.splice(this._cursorLine, 1, before, after);
        this._cursorLine++;
        this._cursorCol = 0;
      } else {
        const cur = this.line(this._cursorLine);
        this.linesArr[this._cursorLine] = cur.slice(0, this._cursorCol) + ch + cur.slice(this._cursorCol);
        this._cursorCol++;
      }
    }
    this._modified = true;
    this.lastActionWasCut = false;
    this.lastEditKind = null;
  }

  private line(i: number): string { return this.linesArr[i] ?? ''; }

  private placeWant = 0;
  private verticalKey = false;

  private columnAtDisplay(line: number, want: number): number {
    return actualX(this.line(line), want, TABSIZE);
  }

  private moveRows(count: number, forward: boolean): number {
    const window = this.window;
    const cursor = { line: this._cursorLine, col: this._cursorCol };
    const { leftedge, target } = window.edgeAndTarget(cursor, this.placeWant);
    const at = { line: this._cursorLine, leftedge };
    const left = forward ? window.goForward(count, at) : window.goBack(count, at);
    if (left > 0) return left;
    const landed = window.landOn(at.line, at.leftedge, target, forward);
    this._cursorLine = at.line;
    this._cursorCol = landed.col;
    this.placeWant = landed.placeWant;
    this.verticalKey = true;
    this.lastEditKind = null;
    return 0;
  }

  private moveVertical(delta: number): void {
    this.manner = 'flowing';
    this.verticalKey = true;
    this.moveRows(Math.abs(delta), delta > 0);
  }

  private clampCol(line: number, col: number): number {
    return Math.max(0, Math.min(col, this.line(line).length));
  }

  // ── Undo/redo ────────────────────────────────────────────────────

  private pushUndoSnapshot(): void {
    this.undoStack.push({ lines: [...this.linesArr], cursorLine: this._cursorLine, cursorCol: this._cursorCol });
    this.redoStack = [];
  }

  /** Start (or continue) a run of same-kind edits as one undo step; a kind change snapshots the pre-edit state. */
  private beginCoalescableEdit(kind: 'type' | 'backspace' | 'delete'): void {
    if (this.lastEditKind !== kind) this.pushUndoSnapshot();
    this.lastEditKind = kind;
  }

  /** Always its own undo step (Enter, Cut, Paste — never coalesced with adjacent edits). */
  private beginDiscreteEdit(): void {
    this.pushUndoSnapshot();
    this.lastEditKind = null;
  }

  private performUndo(): void {
    const snap = this.undoStack.pop();
    if (!snap) { this._statusMessage = 'Nothing to undo!'; return; }
    this.redoStack.push({ lines: [...this.linesArr], cursorLine: this._cursorLine, cursorCol: this._cursorCol });
    this.linesArr = [...snap.lines];
    this._cursorLine = Math.min(snap.cursorLine, this.linesArr.length - 1);
    this._cursorCol = snap.cursorCol;
    this._modified = this.undoStack.length > 0;
    this._statusMessage = 'Undid action';
    this.lastEditKind = null;
  }

  private performRedo(): void {
    const snap = this.redoStack.pop();
    if (!snap) { this._statusMessage = 'Nothing to redo!'; return; }
    this.undoStack.push({ lines: [...this.linesArr], cursorLine: this._cursorLine, cursorCol: this._cursorCol });
    this.linesArr = [...snap.lines];
    this._cursorLine = Math.min(snap.cursorLine, this.linesArr.length - 1);
    this._cursorCol = snap.cursorCol;
    this._modified = true;
    this._statusMessage = 'Redid action';
    this.lastEditKind = null;
  }

  // ── Edit mode ────────────────────────────────────────────────────

  private applyEditKey(k: EditorKeyInput): void {
    if (k.ctrl) return this.applyEditCtrlKey(k);
    if (k.alt) return this.applyEditAltKey(k);
    // View mode (-v): navigation still works, but the buffer is immutable —
    // real nano simply ignores keys that would modify it.
    if (this._readOnly && (k.key === 'Enter' || k.key === 'Backspace' || k.key === 'Delete' || k.key === 'Tab'
      || (k.key.length === 1 && !k.alt))) {
      this._statusMessage = '[ Key is invalid in view mode ]';
      return;
    }

    switch (k.key) {
      case 'ArrowLeft':
        this.manner = 'flowing';
        if (this._cursorCol > 0) this._cursorCol--;
        else if (this._cursorLine > 0) { this._cursorLine--; this._cursorCol = this.line(this._cursorLine).length; }
        this.lastEditKind = null;
        return;
      case 'ArrowRight':
        this.manner = 'flowing';
        if (this._cursorCol < this.line(this._cursorLine).length) this._cursorCol++;
        else if (this._cursorLine < this.linesArr.length - 1) { this._cursorLine++; this._cursorCol = 0; }
        this.lastEditKind = null;
        return;
      case 'ArrowUp':
        this.moveVertical(-1);
        return;
      case 'ArrowDown':
        this.moveVertical(1);
        return;
      case 'Home': this.moveHome(); return;
      case 'End': this.moveEnd(); return;
      case 'PageUp':
        this.pageUp();
        return;
      case 'PageDown':
        this.pageDown();
        return;
      case 'Tab': {
        this.beginCoalescableEdit('type');
        const cur = this.line(this._cursorLine);
        this.linesArr[this._cursorLine] = cur.slice(0, this._cursorCol) + '\t' + cur.slice(this._cursorCol);
        this._cursorCol++;
        this._modified = true;
        this.lastActionWasCut = false;
        return;
      }
      case 'Enter': {
        this.manner = 'flowing';
        this.beginDiscreteEdit();
        const cur = this.line(this._cursorLine);
        const before = cur.slice(0, this._cursorCol);
        const after = cur.slice(this._cursorCol);
        this.linesArr.splice(this._cursorLine, 1, before, after);
        this._cursorLine++;
        this._cursorCol = 0;
        this._modified = true;
        this.lastActionWasCut = false;
        return;
      }
      case 'Backspace': {
        this.manner = 'flowing';
        if (this._cursorCol === 0 && this._cursorLine === this.linesArr.length - 1 && this._cursorLine > 0
          && this.line(this._cursorLine - 1).length > 0) {
          this._cursorLine--;
          this._cursorCol = this.line(this._cursorLine).length;
          this.lastEditKind = null;
          return;
        }
        if (this._cursorCol > 0 || this._cursorLine > 0) this.beginCoalescableEdit('backspace');
        if (this._cursorCol > 0) {
          const cur = this.line(this._cursorLine);
          this.linesArr[this._cursorLine] = cur.slice(0, this._cursorCol - 1) + cur.slice(this._cursorCol);
          this._cursorCol--;
          this._modified = true;
        } else if (this._cursorLine > 0) {
          const prevLen = this.line(this._cursorLine - 1).length;
          this.linesArr[this._cursorLine - 1] += this.line(this._cursorLine);
          this.linesArr.splice(this._cursorLine, 1);
          this._cursorLine--;
          this._cursorCol = prevLen;
          this._modified = true;
        }
        this.lastActionWasCut = false;
        return;
      }
      case 'Delete': {
        const cur = this.line(this._cursorLine);
        if (this._cursorCol === cur.length && this._cursorCol !== 0 && this._cursorLine === this.linesArr.length - 2) return;
        if (this._cursorCol < cur.length || this._cursorLine < this.linesArr.length - 1) this.beginCoalescableEdit('delete');
        if (this._cursorCol < cur.length) {
          this.linesArr[this._cursorLine] = cur.slice(0, this._cursorCol) + cur.slice(this._cursorCol + 1);
          this._modified = true;
        } else if (this._cursorLine < this.linesArr.length - 1) {
          this.linesArr[this._cursorLine] = cur + this.line(this._cursorLine + 1);
          this.linesArr.splice(this._cursorLine + 1, 1);
          this._modified = true;
        }
        this.lastActionWasCut = false;
        return;
      }
      default:
        if (k.key.length === 1 && !k.alt) {
          this.beginCoalescableEdit('type');
          const cur = this.line(this._cursorLine);
          this.linesArr[this._cursorLine] = cur.slice(0, this._cursorCol) + k.key + cur.slice(this._cursorCol);
          this._cursorCol++;
          this._modified = true;
          this.lastActionWasCut = false;
        }
        return;
    }
  }

  private applyEditCtrlKey(k: EditorKeyInput): void {
    // Ctrl+Left/Right: word jump — pure navigation, always available
    // (including view mode), so it's checked before the mnemonic switch
    // below (which keys off the lowercased letter, not arrow names).
    if (k.key === 'ArrowLeft') { this.jumpWordLeft(); return; }
    if (k.key === 'ArrowRight') { this.jumpWordRight(); return; }
    const key = k.key.toLowerCase();
    const emacs: Record<string, string> = { b: 'ArrowLeft', f: 'ArrowRight', p: 'ArrowUp', n: 'ArrowDown', a: 'Home', e: 'End', d: 'Delete', h: 'Backspace' };
    if (emacs[key]) { this.applyEditKey({ ...k, key: emacs[key], ctrl: false }); return; }
    // View mode (-v): no Write Out, Cut, Paste, Replace, Justify, Read
    // File or Execute Command — real nano has none of these bound while
    // read-only, since every one of them would mutate the buffer.
    if (this._readOnly && (key === 'o' || key === 'k' || key === 'u' || key === '\\'
      || key === 'j' || key === 'r' || key === 't')) {
      this._statusMessage = '[ Key is invalid in view mode ]';
      return;
    }
    switch (key) {
      case 'o': // Write Out
        this.saveFileNameBuffer = this.markLine !== null ? '' : this.titleName;
        this._promptCursor = this.saveFileNameBuffer.length;
        this._mode = 'save-prompt';
        return;
      case 'x': // Exit
        if (this._modified) {
          this._mode = 'exit-save-prompt';
          this._statusMessage = 'Save modified buffer?';
        } else {
          this.finishExit(true);
        }
        return;
      case 'k': { // Cut line, or the marked region if a mark is active
        this.wipeStatus();
        const region = this.getMarkedRegion();
        if (region && region.startLine === region.endLine && region.startCol === region.endCol) {
          this.clearMark();
          this._statusMessage = '[ Nothing was cut ]';
          this.lastActionWasCut = false;
          return;
        }
        if (region) {
          this.beginDiscreteEdit();
          this.cutBuffer = { kind: 'chars', text: this.extractRegionText(region) };
          this.deleteRegion(region);
          this.clearMark();
          this._modified = true;
          this.lastActionWasCut = false; // a region cut is discrete, never accumulated
          return;
        }
        if (this._cursorLine === this.linesArr.length - 1) {
          this._statusMessage = '[ Nothing was cut ]';
          this.lastActionWasCut = false;
          return;
        }
        if (this._cursorLine < this.linesArr.length) {
          this.beginDiscreteEdit();
          const cut = this.linesArr[this._cursorLine];
          const prevLines = this.lastActionWasCut && this.cutBuffer?.kind === 'lines' ? this.cutBuffer.lines : [];
          this.cutBuffer = { kind: 'lines', lines: [...prevLines, cut] };
          this.linesArr.splice(this._cursorLine, 1);
          if (this.linesArr.length === 0) this.linesArr.push('');
          this._cursorCol = 0;
          this._modified = true;
          this.lastActionWasCut = true;
        }
        return;
      }
      case 'u': // Paste (uncut)
        this.wipeStatus();
        this.manner = 'flowing';
        if (this.cutBuffer) {
          this.pasteIntoBuffer(this.cutBuffer.kind === 'lines' ? `${this.cutBuffer.lines.join('\n')}\n` : this.cutBuffer.text);
        } else {
          this._statusMessage = '[ Cutbuffer is empty ]';
        }
        this.lastActionWasCut = false;
        return;
      case 'w': // Where Is (search)
        this.searchQueryBuffer = '';
        this.searchDir = 'forward';
        this._promptCursor = 0;
        this._mode = 'search';
        this.historyNavIndex = null;
        this.lastActionWasCut = false;
        return;
      case '\\': // Replace
        this.replaceSearchBuffer = '';
        this.searchDir = 'forward';
        this._promptCursor = 0;
        this._mode = 'replace-search';
        this.lastActionWasCut = false;
        return;
      case 'g': // Get Help
        this._mode = 'help';
        this.lastActionWasCut = false;
        return;
      case 'c': { // Cur Pos
        this._statusMessage = this.locationMessage();
        this.lastActionWasCut = false;
        return;
      }
      case 'j': // Justify
        this.justifyParagraph();
        this.lastActionWasCut = false;
        return;
      case '6': // Mark Text (Set Mark) — toggles a mark at the cursor
        this.toggleMark();
        this.lastActionWasCut = false;
        return;
      case 'r': // Read File (insert another file's content at the cursor)
        this.readFileBuffer = '';
        this._promptCursor = 0;
        this._mode = 'read-file-prompt';
        this.lastActionWasCut = false;
        return;
      case 't': // Execute Command (insert a shell command's output at the cursor)
        this.executeCmdBuffer = '';
        this._promptCursor = 0;
        this._mode = 'execute-prompt';
        this.lastActionWasCut = false;
        return;
      case 'y': // Prev Page
        this.pageUp();
        this.lastActionWasCut = false;
        return;
      case 'v': // Next Page
        this.pageDown();
        this.lastActionWasCut = false;
        return;
      case '_': // Go To Line
        this.gotoLineBuffer = '';
        this._promptCursor = 0;
        this._mode = 'goto-line';
        this.lastActionWasCut = false;
        return;
      default:
        this.lastActionWasCut = false;
        return;
    }
  }

  private get pageRows(): number {
    return this.window.editRows < 3 ? 1 : this.window.editRows - 2;
  }

  private pageUp(): void {
    if (this.moveRows(this.pageRows, false) > 0) {
      this._cursorLine = 0;
      this._cursorCol = 0;
      this.placeWant = 0;
      this.verticalKey = true;
      this.lastEditKind = null;
      return;
    }
    this.manner = 'stationary';
  }

  private pageDown(): void {
    if (this.moveRows(this.pageRows, true) > 0) {
      const last = this.linesArr.length - 1;
      this._cursorLine = last;
      this._cursorCol = this.line(last).length;
      this.verticalKey = false;
      this.manner = 'flowing';
      this.lastEditKind = null;
      return;
    }
    this.manner = 'stationary';
  }

  /**
   * One Ctrl+Left/Right press crosses exactly ONE boundary — either a
   * word edge within the current line, or (only when already sitting
   * at the line's very edge) into the adjacent line. Crossing both in
   * a single press would skip past the last word of a line entirely.
   */
  private jumpWordLeft(): void {
    this.manner = 'flowing';
    let line = this._cursorLine;
    let col = this._cursorCol;
    let seenWord = false;
    let stepForward = false;
    while (true) {
      if (col === 0) {
        if (line === 0) break;
        line--;
        col = this.line(line).length;
      }
      if (col > 0) col--;
      if (isWordChar(this.line(line)[col])) {
        seenWord = true;
        if (col === 0) break;
      } else if (seenWord) {
        stepForward = true;
        break;
      }
    }
    if (stepForward) col++;
    this._cursorLine = line;
    this._cursorCol = col;
    this.lastEditKind = null;
  }

  private jumpWordRight(): void {
    this.manner = 'flowing';
    let line = this._cursorLine;
    let col = this._cursorCol;
    let seenSpace = !isWordChar(this.line(line)[col]);
    while (line < this.linesArr.length - 1 || col < this.line(line).length) {
      if (col >= this.line(line).length) {
        line++;
        col = 0;
        seenSpace = true;
      } else {
        col++;
      }
      if (isWordChar(this.line(line)[col])) {
        if (seenSpace) break;
      } else {
        seenSpace = true;
      }
    }
    this._cursorLine = line;
    this._cursorCol = col;
    this.lastEditKind = null;
  }

  private applyEditAltKey(k: EditorKeyInput): void {
    const key = k.key.toLowerCase();
    if (k.key === 'ArrowUp') { this.manner = 'flowing'; this.scrollView(false, 1); return; }
    if (k.key === 'ArrowDown') { this.manner = 'flowing'; this.scrollView(true, 1); return; }
    if (key === 'z') { this.toggleHiddenInterface(); return; }
    if (key === 'x') { this.toggleHelpLines(); return; }
    if (key === 'c') { this.toggleConstantShow(); return; }
    if (key === 'n') {
      this.verticalKey = true;
      this.live.linenumbers = !this.live.linenumbers;
      if (!this.bareInterface()) this._statusMessage = `[ Line numbering ${this.live.linenumbers ? 'enabled' : 'disabled'} ]`;
      this.manner = 'flowing';
      this.window.align();
      return;
    }
    if (key === 's') {
      this.verticalKey = true;
      this.live.softwrap = !this.live.softwrap;
      if (!(this.live.minibar && !this.live.zero && this.live.stateflags)) this._statusMessage = `[ Soft wrapping of overlong lines ${this.live.softwrap ? 'enabled' : 'disabled'} ]`;
      this.manner = 'flowing';
      this.window.firstcolumn = 0;
      this.window.align();
      return;
    }
    if (key === 'u') { this.performUndo(); this.lastActionWasCut = false; return; }
    if (key === 'e') { this.performRedo(); this.lastActionWasCut = false; return; }
    if (key === 'g') { // Go To Line (M-G alias)
      this.gotoLineBuffer = '';
      this._promptCursor = 0;
      this._mode = 'goto-line';
      this.lastActionWasCut = false;
      return;
    }
    if (k.key === '\\') { // First Line
      this._cursorLine = 0;
      this._cursorCol = 0;
      this.lastEditKind = null;
      this.lastActionWasCut = false;
      return;
    }
    if (k.key === '/') { // Last Line
      this.manner = 'flowing';
      this._cursorLine = this.linesArr.length - 1;
      this._cursorCol = this.line(this._cursorLine).length;
      this.lastEditKind = null;
      this.lastActionWasCut = false;
      return;
    }
    if (key === 'a') { // Mark Text (M-A alias of ^6)
      this.toggleMark();
      this.lastActionWasCut = false;
      return;
    }
    if (k.key === '6') { // Copy Text — the marked region, or the current line without a mark
      this.copyMark();
      this.lastActionWasCut = false;
      return;
    }
    // Toggle line numbers — a display setting, not a buffer edit. Real
    // browsers don't shift-transform `key` when Alt is already held (a
    // physical Alt+Shift+3 on a US layout reports key:'3', not '#'), so
    // both the literal character and the raw shifted digit are accepted.
    if (k.key === '#' || (k.shift && k.key === '3')) {
      this.live.linenumbers = !this.live.linenumbers;
      return;
    }
  }

  // ── Mark / region (^6, M-A, M-6) ─────────────────────────────────

  private toggleMark(): void {
    this.verticalKey = true;
    if (this.markLine !== null) {
      this.clearMark();
      this._statusMessage = 'Mark Unset';
    } else {
      this.markLine = this._cursorLine;
      this.markCol = this._cursorCol;
      this._statusMessage = 'Mark Set';
    }
  }

  private clearMark(): void {
    this.markLine = null;
    this.markCol = null;
  }

  /** The marked region, ordered so `start` precedes `end` regardless of
   *  which of the mark/cursor came first. `null` when no mark is set. */
  private getMarkedRegion(): { startLine: number; startCol: number; endLine: number; endCol: number } | null {
    if (this.markLine === null || this.markCol === null) return null;
    const a = { line: this.markLine, col: this.markCol };
    const b = { line: this._cursorLine, col: this._cursorCol };
    const aFirst = a.line < b.line || (a.line === b.line && a.col <= b.col);
    const [start, end] = aFirst ? [a, b] : [b, a];
    return { startLine: start.line, startCol: start.col, endLine: end.line, endCol: end.col };
  }

  private extractRegionText(r: { startLine: number; startCol: number; endLine: number; endCol: number }): string {
    if (r.startLine === r.endLine) return this.line(r.startLine).slice(r.startCol, r.endCol);
    const parts: string[] = [this.line(r.startLine).slice(r.startCol)];
    for (let l = r.startLine + 1; l < r.endLine; l++) parts.push(this.line(l));
    parts.push(this.line(r.endLine).slice(0, r.endCol));
    return parts.join('\n');
  }

  private deleteRegion(r: { startLine: number; startCol: number; endLine: number; endCol: number }): void {
    if (r.startLine === r.endLine) {
      const text = this.line(r.startLine);
      this.linesArr[r.startLine] = text.slice(0, r.startCol) + text.slice(r.endCol);
    } else {
      const merged = this.line(r.startLine).slice(0, r.startCol) + this.line(r.endLine).slice(r.endCol);
      this.linesArr.splice(r.startLine, r.endLine - r.startLine + 1, merged);
    }
    this._cursorLine = r.startLine;
    this._cursorCol = r.startCol;
  }

  private copyMark(): void {
    this.wipeStatus();
    this.manner = 'flowing';
    const region = this.getMarkedRegion();
    if (region && region.startLine === region.endLine && region.startCol === region.endCol) {
      this.clearMark();
      this._statusMessage = '[ Copied nothing ]';
    } else if (region) {
      this.cutBuffer = { kind: 'chars', text: this.extractRegionText(region) };
      this.clearMark();
    } else if (this._cursorLine === this.linesArr.length - 1) {
      this._statusMessage = '[ Copied nothing ]';
    } else {
      this.cutBuffer = { kind: 'lines', lines: [this.line(this._cursorLine)] };
      if (this._cursorLine < this.linesArr.length - 1) {
        this._cursorLine++;
        this._cursorCol = 0;
      }
    }
  }

  // ── Shared single-line prompt field editing ───────────────────────

  /**
   * Left/Right/Home/End move `_promptCursor`; Backspace/Delete edit
   * around it; a printable character (or a pasted string, via
   * `applyPaste`) inserts at it. Shared by all seven single-line
   * prompts (search/replace-search/replace-with/save-name/goto-line/
   * execute/read-file) so cursor-aware editing isn't reimplemented
   * seven times. Returns true when the key was handled — callers fall
   * through to their own Enter/Escape/mode-specific handling otherwise.
   */
  private applyPromptFieldKey(k: EditorKeyInput, get: () => string, set: (v: string) => void): boolean {
    const text = get();
    if (k.key === 'ArrowLeft') { this._promptCursor = Math.max(0, this._promptCursor - 1); return true; }
    if (k.key === 'ArrowRight') { this._promptCursor = Math.min(text.length, this._promptCursor + 1); return true; }
    if (k.key === 'Home') { this._promptCursor = 0; return true; }
    if (k.key === 'End') { this._promptCursor = text.length; return true; }
    if (k.key === 'Delete') {
      if (this._promptCursor < text.length) set(text.slice(0, this._promptCursor) + text.slice(this._promptCursor + 1));
      return true;
    }
    if (k.key === 'Backspace') {
      if (this._promptCursor > 0) {
        set(text.slice(0, this._promptCursor - 1) + text.slice(this._promptCursor));
        this._promptCursor--;
      }
      return true;
    }
    if (!k.ctrl && !k.alt && k.key.length === 1) {
      set(text.slice(0, this._promptCursor) + k.key + text.slice(this._promptCursor));
      this._promptCursor++;
      return true;
    }
    return false;
  }

  /** Insert pasted text at the prompt field's cursor (newlines already stripped to the first line by the caller). */
  private insertIntoPromptField(get: () => string, set: (v: string) => void, insert: string): void {
    const text = get();
    set(text.slice(0, this._promptCursor) + insert + text.slice(this._promptCursor));
    this._promptCursor += insert.length;
  }

  private reportNotFound(query: string): void {
    const shown = leadingBytes(query, Math.floor(this.window.cols / 2));
    this._statusMessage = `[ "${shown}${shown.length < query.length ? '...' : ''}" not found ]`;
  }

  private isPrompting(): boolean {
    return this._mode !== 'edit' && this._mode !== 'help';
  }

  private writeTarget(name: string): string {
    return name === this.titleName ? this.filePath : this.fs.resolvePath(name);
  }

  private cancelPrompt(): void {
    this._statusMessage = 'Cancelled';
    this._mode = 'edit';
  }

  // ── Save prompt ──────────────────────────────────────────────────

  private applySavePromptKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      const ok = this.fs.writeFile(this.writeTarget(this.saveFileNameBuffer), this.serialize());
      const wasExitFlow = this.exitAfterSave;
      this.exitAfterSave = false;
      this._mode = 'edit';
      if (!ok) {
        this._statusMessage = `[ Error writing ${this.saveFileNameBuffer} ]`;
        return;
      }
      this._modified = false;
      if (wasExitFlow) {
        this.finishExit(true);
        return;
      }
      const n = this.writtenLineCount();
      this._statusMessage = `[ Wrote ${n} line${n === 1 ? '' : 's'} ]`;
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this.exitAfterSave = false;
      this.cancelPrompt();
      return;
    }
    this.applyPromptFieldKey(k, () => this.saveFileNameBuffer, (v) => { this.saveFileNameBuffer = v; });
  }

  // ── Exit-save (Y/N/^C) prompt ───────────────────────────────────

  private applyExitSavePromptKey(k: EditorKeyInput): void {
    const key = k.key.toLowerCase();
    if (!k.ctrl && key === 'y') {
      // Real nano always chains to "File Name to Write:" here, exactly
      // like a plain ^O — it never writes directly.
      this.exitAfterSave = true;
      this.saveFileNameBuffer = this.titleName;
      this._promptCursor = this.saveFileNameBuffer.length;
      this._mode = 'save-prompt';
      return;
    }
    if (!k.ctrl && key === 'n') {
      this.finishExit(false);
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && key === 'c')) this.cancelPrompt();
  }

  // ── Go To Line (^_ / M-G) ────────────────────────────────────────

  private applyGotoLineKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      this.performGotoLine(this.gotoLineBuffer);
      this._mode = 'edit';
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this.cancelPrompt();
      return;
    }
    this.applyPromptFieldKey(k, () => this.gotoLineBuffer, (v) => { this.gotoLineBuffer = v; });
  }

  private performGotoLine(input: string): void {
    if (input === '') {
      this.cancelPrompt();
      return;
    }
    const parsed = parseLineAndColumn(input);
    if (parsed === null) {
      this._statusMessage = '[ Invalid line or column number ]';
      return;
    }
    this.gotoLineNumbers(parsed.line, parsed.column);
    this.manner = 'recentering';
  }

  private applyStart(start: NanoStart): void {
    if (start.caseSensitive !== null) this.caseSensitive = start.caseSensitive;
    if (start.regex !== null) this.useRegex = start.regex;
    if (start.line !== 0 || start.column !== 0) {
      this.gotoLineNumbers(start.line, start.column);
      this.startPlacement = 'hugfloor';
    } else if (start.search !== null) {
      this.searchAtStartup(start.search);
      this.startPlacement = 'centering';
    }
    if (start.alerts.length === 0) return;
    this._statusMessage = `[ ${start.alerts[0]} ]`;
    this.statusMore = start.alerts.length > 1;
  }

  private searchAtStartup(request: NanoSearchRequest): void {
    this.searchDir = request.backwards ? 'backward' : 'forward';
    this.lastSearchTerm = request.pattern;
    this.performSearch(request.pattern);
    if (this.statusText === '[ Search Wrapped ]') this.wipeStatus();
  }

  private gotoLineNumbers(line: number, column: number): void {
    const last = this.linesArr.length;
    const wanted = line < 0 ? last + line + 1 : line === 0 ? this._cursorLine + 1 : line;
    const target = Math.min(Math.max(1, wanted), last) - 1;
    const text = this.line(target);
    const displayColumn = column < 0
      ? wideness(text, text.length, TABSIZE) + column + 2
      : column === 0 ? this.window.columnOf(this._cursorLine, this._cursorCol) + 1 : column;
    this._cursorLine = target;
    this._cursorCol = actualX(text, Math.max(0, displayColumn - 1), TABSIZE);
    this.lastEditKind = null;
  }

  // ── Help (^G) ────────────────────────────────────────────────────

  private applyHelpKey(k: EditorKeyInput): void {
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'x')) {
      this._mode = 'edit';
    }
  }

  // ── Execute Command (^T) — insert a shell command's output ───────

  private applyExecutePromptKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      const output = this.fs.runShellCommand(this.executeCmdBuffer);
      this._mode = 'edit';
      const body = output.endsWith('\n') ? output.slice(0, -1) : output;
      if (body.length > 0) this.pasteIntoBuffer(body);
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this.cancelPrompt();
      return;
    }
    this.applyPromptFieldKey(k, () => this.executeCmdBuffer, (v) => { this.executeCmdBuffer = v; });
  }

  // ── Read File (^R) — insert a file's content at the cursor ───────

  private applyReadFilePromptKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      const content = this.fs.readFile(this.readFileBuffer);
      this._mode = 'edit';
      if (content === null) {
        this._statusMessage = `[ Error reading ${this.readFileBuffer}: No such file or directory ]`;
        return;
      }
      const body = content.endsWith('\n') ? content.slice(0, -1) : content;
      if (body.length > 0) this.pasteIntoBuffer(body);
      this._statusMessage = '';
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this.cancelPrompt();
      return;
    }
    this.applyPromptFieldKey(k, () => this.readFileBuffer, (v) => { this.readFileBuffer = v; });
  }

  // ── Justify (^J) — reflow the current paragraph to JUSTIFY_WIDTH ──

  private indentWidth(text: string): number {
    const lead = text.match(/^[ \t]*/)?.[0] ?? '';
    return wideness(lead, lead.length, TABSIZE);
  }

  private paragraphContaining(target: number): { start: number; end: number } {
    let blockStart = target;
    while (blockStart > 0 && this.line(blockStart - 1).trim() !== '') blockStart--;
    let start = blockStart;
    while (true) {
      let end = start;
      if (start + 1 < this.linesArr.length && this.line(start + 1).trim() !== '') {
        end = start + 1;
        const bodyIndent = this.indentWidth(this.line(end));
        while (end + 1 < this.linesArr.length && this.line(end + 1).trim() !== ''
          && this.indentWidth(this.line(end + 1)) === bodyIndent) end++;
      }
      if (target <= end) return { start, end };
      start = end + 1;
    }
  }

  private squeezeText(text: string): string {
    return text.replace(/[ \t]+/g, (run, offset: number, whole: string) => {
      const endsSentence = /[.?!][)\]"'}>]*$/.test(whole.slice(0, offset));
      return endsSentence && run.length >= 2 ? '  ' : ' ';
    });
  }

  private justifyParagraph(): void {
    let first = this._cursorLine;
    while (first < this.linesArr.length && this.line(first).trim() === '') first++;
    if (first >= this.linesArr.length) return;
    const { start, end } = this.paragraphContaining(first);

    const indentOf = (i: number): string => this.line(i).match(/^[ \t]*/)?.[0] ?? '';
    const firstIndent = indentOf(start);
    const restIndent = end > start ? indentOf(start + 1) : firstIndent;
    const bodies = this.linesArr.slice(start, end + 1).map((l) => l.replace(/^[ \t]+/, ''));
    const joined = bodies.map((body, i) => {
      if (i === bodies.length - 1) return body.trimEnd();
      const trailing = body.match(/[ \t]*$/)?.[0] ?? '';
      const endsSentence = /[.?!][)\]"'}>]*$/.test(body.trimEnd());
      return body.trimEnd() + (endsSentence && (trailing.length >= 2 || trailing === '\t') ? '  ' : ' ');
    }).join('');
    const squeezed = this.squeezeText(joined);
    const words = Array.from(squeezed.matchAll(/(\S+)( {1,2})?/g), (m) => ({ text: m[1], gap: m[2] ?? ' ' }));

    const wrapped: string[] = [];
    let current = firstIndent;
    let currentHasWord = false;
    let pendingGap = '';
    const widthOf = (text: string): number => wideness(text, text.length, TABSIZE);
    for (const word of words) {
      if (!currentHasWord) {
        current += word.text;
        currentHasWord = true;
      } else if (widthOf(current + pendingGap + word.text) <= JUSTIFY_WIDTH) {
        current += pendingGap + word.text;
      } else {
        wrapped.push(current);
        current = restIndent + word.text;
      }
      pendingGap = word.gap;
    }
    if (currentHasWord) wrapped.push(current);
    if (wrapped.length === 0) wrapped.push('');

    this.beginDiscreteEdit();
    this.linesArr.splice(start, end - start + 1, ...wrapped);
    this._cursorLine = start + wrapped.length;
    this._cursorCol = 0;
    this._modified = true;
    this._statusMessage = '[ Justified paragraph ]';
  }

  // ── Search ───────────────────────────────────────────────────────

  private applySearchKey(k: EditorKeyInput): void {
    if (k.alt && k.key.toLowerCase() === 'r') {
      this.useRegex = !this.useRegex;
      return;
    }
    if (k.alt && k.key.toLowerCase() === 'c') {
      this.caseSensitive = !this.caseSensitive;
      return;
    }
    if (k.alt && k.key.toLowerCase() === 'b') {
      this.searchDir = this.searchDir === 'forward' ? 'backward' : 'forward';
      return;
    }
    if (k.key === 'Enter') {
      const term = this.searchQueryBuffer !== '' ? this.searchQueryBuffer : this.lastSearchTerm;
      this._mode = 'edit';
      this.historyNavIndex = null;
      if (term === '') {
        this._statusMessage = 'Cancelled';
        return;
      }
      this.lastSearchTerm = term;
      this.searchHistoryList.push(term);
      this.performSearch(term);
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this.historyNavIndex = null;
      this.cancelPrompt();
      return;
    }
    if (k.key === 'ArrowUp') {
      if (this.historyNavIndex === null) {
        if (this.searchHistoryList.length === 0) return;
        this.historyNavStash = this.searchQueryBuffer;
        this.historyNavIndex = this.searchHistoryList.length - 1;
      } else if (this.historyNavIndex > 0) {
        this.historyNavIndex--;
      }
      this.searchQueryBuffer = this.searchHistoryList[this.historyNavIndex];
      this._promptCursor = this.searchQueryBuffer.length;
      return;
    }
    if (k.key === 'ArrowDown') {
      if (this.historyNavIndex === null) return;
      if (this.historyNavIndex < this.searchHistoryList.length - 1) {
        this.historyNavIndex++;
        this.searchQueryBuffer = this.searchHistoryList[this.historyNavIndex];
      } else {
        this.historyNavIndex = null;
        this.searchQueryBuffer = this.historyNavStash;
      }
      this._promptCursor = this.searchQueryBuffer.length;
      return;
    }
    this.applyPromptFieldKey(k, () => this.searchQueryBuffer, (v) => { this.searchQueryBuffer = v; });
  }

  private buildSearchRegex(query: string): RegExp {
    // Real nano's search is case-insensitive by default (M-C toggles it).
    return new RegExp(this.useRegex ? query : escapeRegExp(query), this.caseSensitive ? '' : 'i');
  }

  private setCursorFromFlatOffset(idx: number): void {
    const before = this.content.slice(0, idx).split('\n');
    this._cursorLine = before.length - 1;
    this._cursorCol = before[before.length - 1].length;
  }

  private performSearch(query: string): void {
    const flatOffset = this.linesArr.slice(0, this._cursorLine).join('\n').length
      + (this._cursorLine > 0 ? 1 : 0) + this._cursorCol;
    const text = this.content;
    const re = this.buildSearchRegex(query);

    if (this.searchDir === 'backward') {
      const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      const before = [...text.slice(0, flatOffset).matchAll(globalRe)];
      let idx: number;
      let wrapped = false;
      if (before.length > 0) {
        idx = before[before.length - 1].index!;
      } else {
        const all = [...text.matchAll(globalRe)];
        if (all.length === 0) {
          this.reportNotFound(query);
          return;
        }
        idx = all[all.length - 1].index!;
        wrapped = true;
      }
      if (wrapped && idx === flatOffset) {
        this._statusMessage = '[ This is the only occurrence ]';
        return;
      }
      this.setCursorFromFlatOffset(idx);
      this._statusMessage = wrapped ? '[ Search Wrapped ]' : '';
      return;
    }

    let m = text.slice(flatOffset + 1).match(re);
    let idx = m && m.index !== undefined ? flatOffset + 1 + m.index : -1;
    let wrapped = false;
    if (idx < 0) {
      m = text.match(re);
      idx = m && m.index !== undefined ? m.index : -1;
      wrapped = true;
    }
    if (idx < 0) {
      this.reportNotFound(query);
      return;
    }
    if (wrapped && idx === flatOffset) {
      this._statusMessage = '[ This is the only occurrence ]';
      return;
    }
    this.setCursorFromFlatOffset(idx);
    this._statusMessage = wrapped ? '[ Search Wrapped ]' : '';
  }

  // ── Replace (Ctrl+\) ────────────────────────────────────────────

  private applyReplaceSearchKey(k: EditorKeyInput): void {
    if (k.alt && k.key.toLowerCase() === 'r') {
      this.useRegex = !this.useRegex;
      return;
    }
    if (k.alt && k.key.toLowerCase() === 'c') {
      this.caseSensitive = !this.caseSensitive;
      return;
    }
    if (k.key === 'Enter') {
      const term = this.replaceSearchBuffer !== '' ? this.replaceSearchBuffer : this.lastSearchTerm;
      if (term === '') {
        this._mode = 'edit';
        this._statusMessage = 'Cancelled';
        return;
      }
      this.lastSearchTerm = term;
      this.replaceWithBuffer = '';
      this._promptCursor = 0;
      this._mode = 'replace-with';
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this.cancelPrompt();
      return;
    }
    this.applyPromptFieldKey(k, () => this.replaceSearchBuffer, (v) => { this.replaceSearchBuffer = v; });
  }

  private applyReplaceWithKey(k: EditorKeyInput): void {
    if (k.alt && k.key.toLowerCase() === 'c') {
      this.caseSensitive = !this.caseSensitive;
      return;
    }
    if (k.key === 'Enter') {
      this.startReplace();
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this.cancelPrompt();
      return;
    }
    this.applyPromptFieldKey(k, () => this.replaceWithBuffer, (v) => { this.replaceWithBuffer = v; });
  }

  private startReplace(): void {
    const regex = this.buildSearchRegex(this.lastSearchTerm);
    this.replaceState = {
      regex, replacement: this.replaceWithBuffer, currentLine: this._cursorLine, currentCol: this._cursorCol, totalReplaced: 0,
      originLine: this._cursorLine, originCol: this._cursorCol, wrapped: false,
      originEdittop: this.window.edittop, originFirstcolumn: this.window.firstcolumn,
    };
    if (this.advanceReplaceMatch()) return;
    this.replaceState = null;
    this._mode = 'edit';
    this.reportNotFound(this.lastSearchTerm);
  }

  private advanceReplaceMatch(): boolean {
    const st = this.replaceState;
    if (!st) return false;
    for (;;) {
      if (st.currentLine >= this.linesArr.length) {
        if (st.wrapped) return false;
        st.wrapped = true;
        st.currentLine = 0;
        st.currentCol = 0;
        continue;
      }
      if (st.wrapped && st.currentLine > st.originLine) return false;
      const m = execFrom(this.linesArr[st.currentLine], st.regex, st.currentCol);
      if (m && !(st.wrapped && st.currentLine === st.originLine && m.index >= st.originCol)) {
        this._pendingReplaceMatch = { line: st.currentLine, start: m.index, end: m.index + m[0].length, matchText: m[0] };
        this._cursorLine = st.currentLine;
        this._cursorCol = m.index;
        this._mode = 'replace-confirm';
        return true;
      }
      st.currentLine++;
      st.currentCol = 0;
    }
  }

  private applyPendingReplaceMatch(): void {
    const st = this.replaceState!;
    const pm = this._pendingReplaceMatch!;
    const line = this.linesArr[pm.line];
    // Real nano's replacement text is always literal — it does not support
    // \1-style backreferences even when the search side is a regex.
    this.linesArr[pm.line] = line.slice(0, pm.start) + st.replacement + line.slice(pm.end);
    st.totalReplaced++;
    this._modified = true;
    st.currentCol = pm.start + st.replacement.length;
  }

  private applyReplaceConfirmKey(k: EditorKeyInput): void {
    const key = k.key.toLowerCase();
    if (k.key === 'Escape' || (k.ctrl && key === 'c')) { this.finishReplace(); return; }
    if (key === 'y') {
      this.applyPendingReplaceMatch();
      this._pendingReplaceMatch = null;
      if (!this.advanceReplaceMatch()) this.finishReplace();
      return;
    }
    if (key === 'n') {
      const st = this.replaceState!;
      const pm = this._pendingReplaceMatch!;
      st.currentCol = pm.end;
      this._pendingReplaceMatch = null;
      if (!this.advanceReplaceMatch()) this.finishReplace();
      return;
    }
    if (key === 'a') {
      this.applyPendingReplaceMatch();
      this._pendingReplaceMatch = null;
      while (this.advanceReplaceMatch()) this.applyPendingReplaceMatch();
      this._pendingReplaceMatch = null;
      this.finishReplace();
      return;
    }
  }

  private finishReplace(): void {
    const st = this.replaceState;
    this._mode = 'edit';
    this._pendingReplaceMatch = null;
    this.replaceState = null;
    if (st) {
      this.window.edittop = Math.min(st.originEdittop, this.linesArr.length - 1);
      this.window.firstcolumn = st.originFirstcolumn;
      this._cursorLine = Math.min(st.originLine, this.linesArr.length - 1);
      this._cursorCol = Math.min(st.originCol, this.line(this._cursorLine).length);
      this._statusMessage = `Replaced ${st.totalReplaced} occurrence${st.totalReplaced === 1 ? '' : 's'}`;
    }
  }

  // ── Exit bookkeeping ─────────────────────────────────────────────

  private finishExit(saved: boolean): void {
    this._exited = true;
    this._savedOnExit = saved;
    if (this.lockPath !== '') this.fs.deleteFile(this.lockPath);
  }
}
