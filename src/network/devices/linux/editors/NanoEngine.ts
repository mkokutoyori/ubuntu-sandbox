import type { EditorFsContext, EditorIdentity, EditorPathKind } from './EditorFsContext';
import type { EditorKeyInput } from './EditorKeyInput';
import { dotSwapPathFor } from './editorPaths';
import { buildNanoLock, cropToFit, lockQuestion, parseNanoLock } from './nano/NanoLock';
import { decodeFile, LINE_END, type NanoFileFormat } from './nano/NanoFormat';
import { directoryNameOf, fullPathOf, openingFor } from './nano/NanoOpening';
import { NanoUndoStack, type UndoKind, type UndoRestore } from './nano/NanoUndo';
import { yesNoAnswer } from './nano/NanoYesNo';
import { NanoWindow, SHORTCUT_BARS_MINIMUM, type ViewportManner } from './nano/NanoWindow';
import { MESSAGE_LEVEL, messageLevel } from './nano/NanoMessages';
import type { MinibarInfo } from './nano/NanoScreen';
import { buildNanoScreen } from './nano/NanoScreen';
import { actualX, breadth, displayString, isBlankChar, leadingBytes, parseLineAndColumn, wideness } from './nano/NanoText';
import {
  DEFAULT_QUOTE_PATTERN, beginsParagraph, breakLine, concatenateParagraph, findParagraph, inParagraph, indentLength, justifyParagraph, leadLength,
  paragraphStart, quoteLength, rewrapParagraph, squeeze, type JustifyContext,
} from './nano/NanoJustify';
import type { NanoMenuName } from './nano/NanoMenus';
import type { NanoSearchRequest, NanoStart } from './nano/NanoCommandLine';
import { defaultNanoSettings, type NanoSettings } from './nano/NanoSettings';
import type { EditorScreen } from './screen/EditorScreen';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export type NanoMode =
  | 'edit' | 'save-prompt' | 'exit-save-prompt' | 'search'
  | 'replace-search' | 'replace-with' | 'replace-confirm' | 'goto-line'
  | 'help' | 'execute-prompt' | 'read-file-prompt' | 'confirm';

const DEFAULT_FILL = -8;

const EDIT_TOGGLES: Readonly<Record<string, { readonly flag: 'breaklonglines' | 'tabstospaces' | 'autoindent' | 'smarthome' | 'cutfromcursor'; readonly epithet: string }>> = {
  l: { flag: 'breaklonglines', epithet: 'Hard wrapping of overlong lines' },
  o: { flag: 'tabstospaces', epithet: 'Conversion of typed tabs to spaces' },
  i: { flag: 'autoindent', epithet: 'Auto indent' },
  h: { flag: 'smarthome', epithet: 'Smart home key' },
  k: { flag: 'cutfromcursor', epithet: 'Cut to end' },
};

const STATUS_LINGER_KEYS = 20;
const PAUSE_MILLIS = 1800;

export interface Confirmation {
  readonly question: string | ((columns: number) => string);
  readonly startup: boolean;
  readonly yes: () => void;
  readonly no: () => void;
  readonly cancel: () => void;
}

export interface NanoLaunchOptions {
  readonly identity?: EditorIdentity;
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

function isWordChar(ch: string | undefined, punctuationAsLetters: boolean, wordChars: string | null): boolean {
  if (ch === undefined || ch === '') return false;
  if (/[\p{L}\p{N}]/u.test(ch)) return true;
  if (punctuationAsLetters && /[\p{P}\p{S}]/u.test(ch)) return true;
  return wordChars !== null && wordChars !== '' && wordChars.includes(ch);
}

function whiteLength(text: string, tabsize: number): number {
  let count = 0;
  while (true) {
    if (text[count] === '\t') return count + 1;
    if (text[count] !== ' ') return count;
    if (++count === tabsize) return tabsize;
  }
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
  private modifiedState = false;
  private get _modified(): boolean { return this.modifiedState; }
  private set _modified(value: boolean) {
    if (value && !this.modifiedState) this.lockAsModified();
    this.modifiedState = value;
  }
  private statusText = '';
  private statusCountdown = 0;
  private statusAlert = false;
  private pauseNote: string | null = null;
  private statusMore = false;
  private messageThisKey = false;
  private get _statusMessage(): string { return this.statusText; }
  private set _statusMessage(value: string) {
    this.statusText = value;
    this.statusCountdown = value === '' ? 0 : STATUS_LINGER_KEYS;
    this.statusAlert = messageLevel(value) >= MESSAGE_LEVEL.ahem;
    this.statusRaw = false;
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
  private _readOnly: boolean;
  private titleName: string;
  private bufferPath: string;
  private fileFormat: NanoFileFormat = 'unix';
  private writeMethod: 'overwrite' | 'append' | 'prepend' = 'overwrite';
  private lockPath = '';
  private lockHolder: EditorIdentity | null = null;
  private confirmation: Confirmation | null = null;
  private statusRaw = false;
  private launchIdentity: EditorIdentity | undefined;
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
  private cutBuffer: string[] | null = null;
  private cutAction: 'cut' | 'copy' | null = null;
  /** Set by ^6/M-A (Set Mark); the region runs from here to the cursor. */
  private markLine: number | null = null;
  private markCol: number | null = null;
  private spillageLine: number | null = null;

  // Undo/redo (Alt+U / Alt+E — real nano's M-U/M-E), multi-level, with
  // real nano's action-grouping: a run of consecutive keystrokes of the
  // same coalescable kind (typing, or Backspace, or Delete) is one undo
  // step; a cursor move or a different action kind starts a new step.
  private readonly undo = new NanoUndoStack();

  constructor(
    private readonly fs: EditorFsContext,
    filePath: string,
    initialContent: string,
    isNewFile: boolean,
    readOnly = false,
    initialCursor?: { line: number; col?: number },
    showLineNumbers = false,
    launch: NanoLaunchOptions = {},
  ) {
    this.settings = launch.settings ?? defaultNanoSettings({ view: readOnly, linenumbers: showLineNumbers });
    this.launchIdentity = launch.identity;
    const typedName = launch.displayName ?? filePath;
    const opening = openingFor(typedName, filePath, fs, this.identity().user);
    const named = opening.path !== '';
    this.live = { ...this.settings, view: this.settings.view && named };
    if (this.live.restricted) this.live.backup = false;
    this._readOnly = this.live.view;
    this.titleName = named ? typedName : '';
    this.bufferPath = opening.path;
    this.window = new NanoWindow(
      { lineCount: () => this.linesArr.length, lineAt: (index) => this.linesArr[index] ?? '' },
      () => ({
        softwrap: this.live.softwrap,
        tabsize: this.live.tabsize,
        lineNumbers: this.live.linenumbers && !this.marginPending,
        zero: this.live.zero,
        minibar: this.live.minibar,
        emptyline: this.live.emptyline,
        nohelp: this.live.nohelp,
        jumpyscrolling: this.live.jumpyscrolling,
        atblanks: this.live.atblanks,
      }),
    );
    const unread = this.live.noread && named;
    const decoded = unread || initialContent.length === 0 ? { lines: [''], format: 'unix' as NanoFileFormat, count: 0 } : decodeFile(initialContent, !this.live.noconvert, !this.live.nonewlines);
    this.linesArr = decoded.lines;
    this.fileFormat = this.live.unix ? 'unix' : decoded.format;
    this.ensureTrailingBlankLine();
    if (opening.alert !== null) this._statusMessage = `[ ${opening.alert} ]`;
    else if (!named) {
      if (!this.live.nohelp) this._statusMessage = '[ Welcome to nano.  For basic help, type Ctrl+G. ]';
    } else if (unread) this._statusMessage = '';
    else if (isNewFile) this._statusMessage = '[ New File ]';
    else if (!this.live.minibar && !this.live.zero) this._statusMessage = `[ Read ${decoded.count} line${decoded.count === 1 ? '' : 's'}${decoded.format === 'unix' ? '' : ` (Converted from ${decoded.format === 'dos' ? 'DOS' : 'Mac'} format)`} ]`;
    this.reportSizePending = true;
    this.saveFileNameBuffer = this.titleName;
    if (this.live.locking && !this._readOnly && named && opening.lockable) this.beginLocking();
    const start = launch.start ?? (initialCursor ? { line: initialCursor.line, column: initialCursor.col ?? 0, search: null, caseSensitive: null, regex: null, alerts: [] } : null);
    if (start !== null) this.applyStart(start);
  }

  // ── Public state (read-only) ──────────────────────────────────────

  get content(): string { return this.lines.join('\n'); }
  /** What gets written to disk: buffer content plus the trailing newline nano always restores on save. */
  private serialize(end: string = LINE_END[this.fileFormat]): string {
    const body = this.linesArr;
    return body.join(end) + (this.live.nonewlines || body[body.length - 1] === '' ? '' : end);
  }

  private locationMessage(): string {
    const totalLines = this.linesArr.length;
    const line = this._cursorLine + 1;
    const column = this.window.columnOf(this._cursorLine, this._cursorCol) + 1;
    const fullWidth = this.window.columnOf(this._cursorLine, this.line(this._cursorLine).length) + 1;
    const fullSize = [...this.serialize('\n')].length;
    let before = 0;
    for (let i = 0; i < this._cursorLine; i++) before += [...this.line(i)].length + 1;
    before += [...this.line(this._cursorLine).slice(0, this._cursorCol)].length;
    const pct = (part: number, whole: number): number => (whole === 0 ? 0 : Math.floor((100 * part) / whole));
    const pad = (n: number, width: number): string => padToWidth(String(n), width, 'right');
    const lineWidth = Math.max(2, String(totalLines).length);
    const sizeWidth = Math.max(2, String(fullSize).length);
    return `[ line ${pad(line, lineWidth)}/${totalLines} (${pad(pct(line, totalLines), 2)}%), `
      + `col ${pad(column, 2)}/${pad(fullWidth, 2)} (${pad(pct(column, fullWidth), 3)}%), `
      + `char ${pad(before, sizeWidth)}/${fullSize} (${pad(pct(before, fullSize), 2)}%) ]`;
  }

  private ensureTrailingBlankLine(): void {
    if (this.live.nonewlines) return;
    if (this.linesArr[this.linesArr.length - 1] !== '') this.linesArr.push('');
  }

  private writtenLineCount(): number {
    return this.linesArr[this.linesArr.length - 1] === '' ? this.linesArr.length - 1 : this.linesArr.length;
  }
  get lines(): readonly string[] {
    return this.linesArr.length > 1 && !this.live.nonewlines ? this.linesArr.slice(0, -1) : this.linesArr;
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
  get filePath(): string { return this.bufferPath; }
  get swapFilePath(): string { return this.lockPath; }
  get swapFileExists(): boolean { return this.lockPath !== '' && this.fs.exists(this.lockPath); }
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
    this.pauseNote = null;
    if (this.statusCountdown > 0 && --this.statusCountdown === 0) {
      this.statusText = '';
      this.statusAlert = false;
      this.statusMore = false;
    }
    this.messageThisKey = false;
    this.manner = 'centering';
    this.verticalKey = false;
    if (!this.isPrompting() && !((k.ctrl && k.key.toLowerCase() === 'k') || (k.alt && k.key === '6'))) this.cutAction = null;
    if (this.bareDisplay()) this.wipeStatus();
    const wasPrompting = this.isPrompting();
    const cursorBefore = { line: this._cursorLine, col: this._cursorCol };
    if (wasPrompting && k.alt && k.key.toLowerCase() === 'x') this.toggleHelpInPrompt();
    else this.dispatchKey(k);
    if ((wasPrompting || this.isPrompting()) && !this.messageThisKey) this.wipeStatus();
    this.ensureTrailingBlankLine();
    const promptLeftCursorAlone = (wasPrompting || this.isPrompting())
      && cursorBefore.line === this._cursorLine && cursorBefore.col === this._cursorCol;
    if (!this.verticalKey && !promptLeftCursorAlone) this.placeWant = this.window.columnOf(this._cursorLine, this._cursorCol);
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
    this._cursorCol = actualX(text, column, this.live.tabsize);
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
    const shown = displayString(this.lastSearchTerm, 0, limit, { isData: false, isPrompt: false, softwrap: false, tabsize: this.live.tabsize });
    return ` [${shown.cells.join('')}${breadth(this.lastSearchTerm, this.live.tabsize) > limit ? '...' : ''}]`;
  }

  private pauseWith(note: string): void {
    this.pauseNote = note;
  }

  private refuseWhenRestricted(): boolean {
    if (!this.live.restricted) return false;
    this._statusMessage = '[ This function is disabled in restricted mode ]';
    return true;
  }

  private discardEnabled(): boolean {
    return this.live.saveonexit && !this.live.preserve;
  }

  private writeNameFrozen(): boolean {
    return this.live.restricted && this.titleName !== '';
  }

  private beginWriteOut(exiting: boolean): void {
    this.exitAfterSave = exiting;
    this.writeMethod = 'overwrite';
    this.saveFileNameBuffer = this.markLine !== null && !exiting ? '' : this.titleName;
    this._promptCursor = this.saveFileNameBuffer.length;
    this._mode = 'save-prompt';
    if (exiting && this.live.saveonexit && this.titleName !== '') this.submitWriteName();
  }

  private readFileLabel(): string {
    return `File to insert${this.live.noconvert ? ' unconverted' : ''} [from ./]`;
  }

  private writeOutLabel(): string {
    const selection = this.markLine !== null && !this.exitAfterSave && !this.live.restricted;
    const method = this.writeMethod;
    const base = selection
      ? method === 'prepend' ? 'Prepend Selection to File' : method === 'append' ? 'Append Selection to File' : 'Write Selection to File'
      : method === 'prepend' ? 'File Name to Prepend to' : method === 'append' ? 'File Name to Append to' : 'File Name to Write';
    const format = this.fileFormat === 'dos' ? ' [DOS Format]' : this.fileFormat === 'mac' ? ' [Mac Format]' : '';
    return `${base}${format}${this.live.backup ? ' [Backup]' : ''}`;
  }

  private promptView(): { label: string; answer: string; menu: NanoMenuName } | null {
    switch (this._mode) {
      case 'save-prompt': return { label: this.writeOutLabel(), answer: this.saveFileNameBuffer, menu: 'write-out' };
      case 'search': return { label: this.searchPromptLabel(false), answer: this.searchQueryBuffer, menu: 'search' };
      case 'replace-search': return { label: this.searchPromptLabel(true), answer: this.replaceSearchBuffer, menu: 'replace' };
      case 'replace-with': return { label: 'Replace with', answer: this.replaceWithBuffer, menu: 'replace-with' };
      case 'goto-line': return { label: 'Enter line number, column number', answer: this.gotoLineBuffer, menu: 'goto' };
      case 'execute-prompt': return { label: 'Command to execute', answer: this.executeCmdBuffer, menu: 'execute' };
      case 'read-file-prompt': return { label: this.readFileLabel(), answer: this.readFileBuffer, menu: 'read-file' };
      default: return null;
    }
  }

  get screen(): EditorScreen {
    const live = this.paintScreen(false);
    if (this.pauseNote !== null) return { ...live, hold: { millis: PAUSE_MILLIS, then: this.paintScreen(true) } };
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
    const screen = buildNanoScreen({
      window: this.window,
      lines: this.linesArr,
      cursor: { line: this._cursorLine, col: this._cursorCol },
      mark: this.markLine === null ? null : { line: this.markLine, col: this.markCol ?? 0 },
      spotlight: this._pendingReplaceMatch === null ? null : { line: this._pendingReplaceMatch.line, start: this._pendingReplaceMatch.start, end: this._pendingReplaceMatch.end },
      tabsize: this.live.tabsize,
      softwrap: this.live.softwrap,
      title: {
        name: this._mode === 'help' ? 'Main nano help text' : this.titleName === '' ? 'New Buffer' : this.titleName,
        state: this._mode === 'help' ? '' : this._readOnly ? 'View' : this._modified ? 'Modified' : this.live.restricted ? 'Restricted' : '',
        branding: 'GNU nano 7.2',
        flags: this.live.stateflags ? { letters: this.stateLetters(), modified: this._modified } : null,
      },
      status: message === '' ? null : { text: message, alert: this.statusAlert, more: this.statusMore, raw: this.statusRaw },
      minibar: this.minibarInfo(messageExpired),
      prompt: prompt === null ? null : { label: prompt.label, answer: prompt.answer, cursor: this._promptCursor },
      yesNo: this._mode === 'exit-save-prompt'
        ? { question: 'Save modified buffer? ', withAll: false }
        : this._mode === 'confirm' ? { question: this.confirmationQuestion(), withAll: false }
        : this._mode === 'replace-confirm' ? { question: 'Replace this instance?', withAll: true } : null,
      menu: this._mode === 'help' ? 'help' : prompt === null ? 'main' : prompt.menu,
      menuOptions: { restricted: this.live.restricted, discard: this.discardEnabled(), view: this.settings.view },
      pause: messageExpired ? null : this.pauseNote,
      helpLines: this._mode === 'help' ? this.helpText.split('\n') : null,
    });
    if (this._mode !== 'confirm' || !this.confirmation!.startup) return screen;
    const footerFrom = this.window.layout.statusRow;
    return { ...screen, rows: screen.rows.map((row, index) => (index < footerFrom ? { text: '', spans: [] } : row)) };
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
    const text = this.line(this._cursorLine);
    let chunk: { index: number; leftedge: number } | null = null;
    if (this.live.softwrap) chunk = this.window.chunkLeft(this._cursorLine, this.window.columnOf(this._cursorLine, this._cursorCol));
    const leftX = chunk === null ? 0 : chunk.index;
    let moved = false;
    if (this.live.smarthome) {
      const indentX = indentLength(text);
      if (indentX < text.length) {
        if (this._cursorCol === indentX) {
          this._cursorCol = 0;
          moved = true;
        } else if (leftX <= indentX) {
          this._cursorCol = indentX;
          moved = true;
        }
      }
    }
    if (moved || chunk === null) {
      if (!moved) this._cursorCol = 0;
      return;
    }
    if (this._cursorCol === chunk.index) {
      this._cursorCol = 0;
    } else {
      this._cursorCol = chunk.index;
      this.placeWant = chunk.leftedge;
      this.verticalKey = true;
    }
  }

  private moveEnd(): void {
    this.manner = 'flowing';
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
    this.statusRaw = false;
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
      case 'confirm': return this.applyConfirmKey(k);
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
    this.pauseNote = null;
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const firstLine = normalized.split('\n')[0];
    switch (this._mode) {
      case 'edit':
        this.pasteIntoBuffer(normalized);
        return;
      case 'save-prompt':
        if (this.writeNameFrozen()) return;
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
    this.undoBegin('PASTE');
    const startedOn = this._cursorLine;
    this.insertText(text);
    if (this.live.breaklonglines && this._cursorLine === startedOn) this.doWrap();
    this.undoFinish();
    this._modified = true;
  }

  private typeText(text: string): void {
    this.undo.beginTyping(this.linesArr, { line: this._cursorLine, col: this._cursorCol }, this.window.cursorRow);
    const wrapped = this.inject(text);
    this.undoFinish();
    if (wrapped) this.undo.convertTopToSplit({ line: this._cursorLine, col: this._cursorCol });
    this._modified = true;
  }

  private inject(text: string): boolean {
    const window = this.window;
    const softwrap = this.live.softwrap;
    const onLastRow = window.cursorRow === window.editRows - 1;
    const rowBefore = softwrap && onLastRow ? window.chunkFor(window.columnOf(this._cursorLine, this._cursorCol), this._cursorLine) : 0;
    const chunksBefore = softwrap ? window.extraChunksIn(this._cursorLine) : 0;
    this.insertText(text);
    const wrapped = this.live.breaklonglines && this.doWrap();
    if (!softwrap) return wrapped;
    const grew = window.extraChunksIn(this._cursorLine) !== chunksBefore;
    const movedDown = onLastRow && window.chunkFor(window.columnOf(this._cursorLine, this._cursorCol), this._cursorLine) > rowBefore;
    if (grew || movedDown) this.manner = 'flowing';
    return wrapped;
  }

  private insertText(text: string): void {
    for (const ch of text) {
      if (ch === '\n') {
        this.splitLine(this._cursorCol, '');
        continue;
      }
      const cur = this.line(this._cursorLine);
      this.linesArr[this._cursorLine] = cur.slice(0, this._cursorCol) + ch + cur.slice(this._cursorCol);
      if (this.markLine === this._cursorLine && (this.markCol ?? 0) > this._cursorCol) this.markCol = (this.markCol ?? 0) + ch.length;
      this._cursorCol += ch.length;
    }
  }

  private splitLine(headLength: number, indent: string): void {
    const cur = this.line(this._cursorLine);
    const after = cur.slice(this._cursorCol);
    if (this.markLine === this._cursorLine && (this.markCol ?? 0) > this._cursorCol) {
      this.markLine++;
      this.markCol = (this.markCol ?? 0) + indent.length - this._cursorCol;
    } else if (this.markLine !== null && this.markLine > this._cursorLine) {
      this.markLine++;
    }
    if (this.spillageLine !== null && this.spillageLine > this._cursorLine) this.spillageLine++;
    this.linesArr.splice(this._cursorLine, 1, cur.slice(0, headLength), indent + after);
    this._cursorLine++;
    this._cursorCol = indent.length;
  }

  private forgetRemovedLines(first: number, last: number): void {
    if (this.spillageLine === null) return;
    if (this.spillageLine >= first && this.spillageLine <= last) this.spillageLine = null;
    else if (this.spillageLine > last) this.spillageLine -= last - first + 1;
  }

  private joinWithNext(line: number): void {
    const head = this.line(line).length;
    if (this.markLine === line + 1) {
      this.markLine = line;
      this.markCol = (this.markCol ?? 0) + head;
    } else if (this.markLine !== null && this.markLine > line + 1) {
      this.markLine--;
    }
    this.forgetRemovedLines(line + 1, line + 1);
    this.linesArr[line] += this.line(line + 1);
    this.linesArr.splice(line + 1, 1);
  }

  private line(i: number): string { return this.linesArr[i] ?? ''; }

  private placeWant = 0;
  private verticalKey = false;

  private columnAtDisplay(line: number, want: number): number {
    return actualX(this.line(line), want, this.live.tabsize);
  }

  private moveRows(count: number, forward: boolean, origin?: { line: number; leftedge: number; target: number }): number {
    const window = this.window;
    const cursor = { line: this._cursorLine, col: this._cursorCol };
    const { leftedge, target } = origin ?? window.edgeAndTarget(cursor, this.placeWant);
    const at = { line: origin?.line ?? this._cursorLine, leftedge };
    const left = forward ? window.goForward(count, at) : window.goBack(count, at);
    if (left > 0) return left;
    const landed = window.landOn(at.line, at.leftedge, target, forward);
    this._cursorLine = at.line;
    this._cursorCol = landed.col;
    this.placeWant = landed.placeWant;
    this.verticalKey = true;
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

  private undoBegin(kind: UndoKind, message: string | null = null): void {
    this.undo.begin(kind, this.linesArr, { line: this._cursorLine, col: this._cursorCol }, this.window.cursorRow, message);
  }

  private undoFinish(): void {
    this.undo.finish({ line: this._cursorLine, col: this._cursorCol }, this.window.cursorRow);
  }

  private restoreFromUndo(restore: UndoRestore | null, nothing: string, verb: string): void {
    if (restore === null) {
      this._statusMessage = `[ ${nothing} ]`;
      this.verticalKey = true;
      return;
    }
    this.linesArr = restore.lines;
    this._cursorLine = Math.min(restore.cursor.line, this.linesArr.length - 1);
    this._cursorCol = Math.min(restore.cursor.col, this.line(this._cursorLine).length);
    this.clearMark();
    this.placeWant = this.window.columnOf(this._cursorLine, this._cursorCol);
    this._modified = this.undo.modified;
    if (restore.row !== null) {
      this.window.cursorRow = restore.row;
      this.manner = 'stationary';
    }
    if (restore.message !== null && !this.live.zero) this._statusMessage = `${verb} ${restore.message}`;
  }

  private performUndo(): void {
    this.restoreFromUndo(this.undo.undo(this.linesArr, this.window.cursorRow), 'Nothing to undo', 'Undid');
  }

  private performRedo(): void {
    this.restoreFromUndo(this.undo.redo(), 'Nothing to redo', 'Redid');
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
        return;
      case 'ArrowRight':
        this.manner = 'flowing';
        if (this._cursorCol < this.line(this._cursorLine).length) this._cursorCol++;
        else if (this._cursorLine < this.linesArr.length - 1) { this._cursorLine++; this._cursorCol = 0; }
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
        if (this.markLine !== null && this.markLine !== this._cursorLine) {
          this.indentLines();
          return;
        }
        const cur = this.line(this._cursorLine);
        const tab = this.live.tabstospaces
          ? ' '.repeat(this.live.tabsize - (wideness(cur, this._cursorCol, this.live.tabsize) % this.live.tabsize))
          : '\t';
        this.typeText(tab);
        return;
      }
      case 'Enter': {
        this.manner = 'flowing';
        this.undoBegin('ENTER');
        this.breakLine();
        this.undoFinish();
        this._modified = true;
        return;
      }
      case 'Backspace': {
        this.manner = 'flowing';
        if (this.live.zap && this.markLine !== null) {
          this.zapText();
          return;
        }
        if (!this.live.nonewlines && this._cursorCol === 0 && this._cursorLine === this.linesArr.length - 1 && this._cursorLine > 0
          && this.line(this._cursorLine - 1).length > 0) {
          this.undo.beginJoin(this.linesArr, { line: this._cursorLine, col: 0 });
          this._cursorLine--;
          this._cursorCol = this.line(this._cursorLine).length;
          this.undoFinish();
          this.manner = 'flowing';
          return;
        }
        const before = { line: this._cursorLine, col: this._cursorCol };
        if (this._cursorCol > 0) {
          const cur = this.line(this._cursorLine);
          this.undo.beginDeletion('BACK', this.linesArr, { line: before.line, col: before.col - 1 }, 1, before);
          this.linesArr[this._cursorLine] = cur.slice(0, this._cursorCol - 1) + cur.slice(this._cursorCol);
          this._cursorCol--;
          if (this.markLine === this._cursorLine && (this.markCol ?? 0) > this._cursorCol) this.markCol = (this.markCol ?? 0) - 1;
          this.undoFinish();
          this._modified = true;
        } else if (this._cursorLine > 0) {
          const prevLen = this.line(this._cursorLine - 1).length;
          this.undo.beginJoin(this.linesArr, before);
          this.joinWithNext(this._cursorLine - 1);
          this._cursorLine--;
          this._cursorCol = prevLen;
          this.undoFinish();
          this._modified = true;
        }
        return;
      }
      case 'Delete': {
        if (this.live.zap && this.markLine !== null) {
          this.zapText();
          return;
        }
        const cur = this.line(this._cursorLine);
        if (!this.live.nonewlines && this._cursorCol === cur.length && this._cursorCol !== 0 && this._cursorLine === this.linesArr.length - 2) return;
        const before = { line: this._cursorLine, col: this._cursorCol };
        if (this._cursorCol < cur.length) {
          this.undo.beginDeletion('DEL', this.linesArr, before, 1, before);
          this.linesArr[this._cursorLine] = cur.slice(0, this._cursorCol) + cur.slice(this._cursorCol + 1);
          if (this.markLine === this._cursorLine && (this.markCol ?? 0) > this._cursorCol) this.markCol = (this.markCol ?? 0) - 1;
          this.undoFinish();
          this._modified = true;
        } else if (this._cursorLine < this.linesArr.length - 1) {
          this.undo.beginJoin(this.linesArr, before);
          this.joinWithNext(this._cursorLine);
          this.undoFinish();
          this._modified = true;
        }
        return;
      }
      default:
        if (k.key.length === 1 && !k.alt) this.typeText(k.key);
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
    if (key === 'r' && this.refuseWhenRestricted()) return;
    // View mode (-v): no Write Out, Cut, Paste, Replace, Justify, Read
    // File or Execute Command — real nano has none of these bound while
    // read-only, since every one of them would mutate the buffer.
    if (this._readOnly && (key === 'o' || key === 'k' || key === 'u' || key === '\\'
      || key === 'j' || key === 'r' || key === 't')) {
      this._statusMessage = '[ Key is invalid in view mode ]';
      return;
    }
    switch (key) {
      case 'o':
        this.beginWriteOut(false);
        return;
      case 'x': // Exit
        if (!this._modified) this.finishExit(true);
        else if (this.live.saveonexit && this.titleName !== '') this.beginWriteOut(true);
        else {
          if (this.live.saveonexit) this.pauseWith('No file name');
          this._mode = 'exit-save-prompt';
          this._statusMessage = 'Save modified buffer?';
        }
        return;
      case 'k':
        this.cutText();
        return;
      case 'u':
        this.wipeStatus();
        this.manner = 'flowing';
        if (this.cutBuffer) {
          const wasScreenful = this.screenfulMark();
          this.pasteIntoBuffer(this.cutBuffer.join('\n'));
          this.manner = this.lessThanScreenful(wasScreenful) ? 'flowing' : 'centering';
        } else {
          this._statusMessage = '[ Cutbuffer is empty ]';
          this.verticalKey = true;
        }
        return;
      case 'w': // Where Is (search)
        this.searchQueryBuffer = '';
        this.searchDir = 'forward';
        this._promptCursor = 0;
        this._mode = 'search';
        this.historyNavIndex = null;
        return;
      case '\\': // Replace
        this.replaceSearchBuffer = '';
        this.searchDir = 'forward';
        this._promptCursor = 0;
        this._mode = 'replace-search';
        return;
      case 'g': // Get Help
        this._mode = 'help';
        return;
      case 'c': { // Cur Pos
        this._statusMessage = this.locationMessage();
        return;
      }
      case 'j':
        this.justifyText(false);
        return;
      case '6': // Mark Text (Set Mark) — toggles a mark at the cursor
        this.toggleMark();
        return;
      case 'r': // Read File (insert another file's content at the cursor)
        this.readFileBuffer = '';
        this._promptCursor = 0;
        this._mode = 'read-file-prompt';
        return;
      case 't': // Execute Command (insert a shell command's output at the cursor)
        if (this.refuseWhenRestricted()) return;
        this.executeCmdBuffer = '';
        this._promptCursor = 0;
        this._mode = 'execute-prompt';
        return;
      case 'y': // Prev Page
        this.pageUp();
        return;
      case 'v': // Next Page
        this.pageDown();
        return;
      case '_': // Go To Line
        this.gotoLineBuffer = '';
        this._promptCursor = 0;
        this._mode = 'goto-line';
        return;
      default:
        return;
    }
  }

  private get pageRows(): number {
    return this.window.editRows < 3 ? 1 : this.window.editRows - 2;
  }

  private movePage(forward: boolean): number {
    if (!this.live.jumpyscrolling) return this.moveRows(this.pageRows, forward);
    this.window.cursorRow = 0;
    return this.moveRows(this.pageRows, forward, { line: this.window.edittop, leftedge: this.window.firstcolumn, target: 0 });
  }

  private pageUp(): void {
    if (this.movePage(false) > 0) {
      this._cursorLine = 0;
      this._cursorCol = 0;
      this.placeWant = 0;
      this.verticalKey = true;
      return;
    }
    this.manner = 'stationary';
  }

  private pageDown(): void {
    if (this.movePage(true) > 0) {
      const last = this.linesArr.length - 1;
      this._cursorLine = last;
      this._cursorCol = this.line(last).length;
      this.verticalKey = false;
      this.manner = 'flowing';
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
  private isWordAt(line: number, col: number): boolean {
    return isWordChar(this.line(line)[col], this.live.wordbounds, this.live.wordchars);
  }

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
      if (this.isWordAt(line, col)) {
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
  }

  private jumpWordRight(): void {
    this.manner = 'flowing';
    let line = this._cursorLine;
    let col = this._cursorCol;
    const startedOnWord = this.isWordAt(line, col);
    let seenSpace = !startedOnWord;
    let seenWord = startedOnWord;
    while (line < this.linesArr.length - 1 || col < this.line(line).length) {
      if (col >= this.line(line).length) {
        line++;
        col = 0;
        seenSpace = true;
      } else {
        col++;
      }
      if (this.live.afterends) {
        if (this.isWordAt(line, col)) seenWord = true;
        else if (seenWord) break;
      } else if (!this.isWordAt(line, col)) {
        seenSpace = true;
      } else if (seenSpace) {
        break;
      }
    }
    this._cursorLine = line;
    this._cursorCol = col;
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
    if (k.key === '}' || k.key === '{') {
      if (this._readOnly) { this._statusMessage = '[ Key is invalid in view mode ]'; return; }
      if (k.key === '}') this.indentLines(); else this.unindentLines();
      return;
    }
    if (key === 'j') {
      if (this._readOnly) { this._statusMessage = '[ Key is invalid in view mode ]'; return; }
      this.justifyText(true);
      return;
    }
    if (key === 't' || (k.key === '3' && !k.shift)) {
      if (this._readOnly) { this._statusMessage = '[ Key is invalid in view mode ]'; return; }
      if (key === 't') this.cutTillEnd(); else this.commentLines();
      return;
    }
    const toggle = EDIT_TOGGLES[key];
    if (toggle !== undefined) {
      this.live[toggle.flag] = !this.live[toggle.flag];
      this.manner = 'flowing';
      const quietForStateFlags = (toggle.flag === 'autoindent' || toggle.flag === 'breaklonglines')
        && this.live.minibar && !this.live.zero && this.live.stateflags;
      if (!quietForStateFlags) this._statusMessage = `[ ${toggle.epithet} ${this.live[toggle.flag] ? 'enabled' : 'disabled'} ]`;
      return;
    }
    if (key === 'u') { this.performUndo(); return; }
    if (key === 'e') { this.performRedo(); return; }
    if (key === 'g') { // Go To Line (M-G alias)
      this.gotoLineBuffer = '';
      this._promptCursor = 0;
      this._mode = 'goto-line';
      return;
    }
    if (k.key === '\\') { // First Line
      this._cursorLine = 0;
      this._cursorCol = 0;
      return;
    }
    if (k.key === '/') { // Last Line
      this.manner = 'flowing';
      this._cursorLine = this.linesArr.length - 1;
      this._cursorCol = this.line(this._cursorLine).length;
      return;
    }
    if (key === 'a') { // Mark Text (M-A alias of ^6)
      this.toggleMark();
      return;
    }
    if (k.key === '6') { // Copy Text — the marked region, or the current line without a mark
      this.copyMark();
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

  private breakLine(autoindent = this.live.autoindent): void {
    const cur = this.line(this._cursorLine);
    let extra = 0;
    let onlyBlanks = false;
    let sample = cur;
    if (autoindent) {
      const next = this.linesArr[this._cursorLine + 1];
      const context = this.justifyContext();
      if (this.live.breaklonglines && next !== undefined && inParagraph(next, context.quote)
        && !beginsParagraph(this.linesArr, this._cursorLine + 1, 0, context)) sample = next;
      extra = indentLength(sample);
      if (extra > this._cursorCol) extra = this._cursorCol;
      else if (extra === this._cursorCol) onlyBlanks = indentLength(cur) === extra;
    }
    const staysBehind = this.markLine === this._cursorLine && (this.markCol ?? 0) <= this._cursorCol;
    this.manner = 'flowing';
    this.splitLine(onlyBlanks ? 0 : this._cursorCol, sample.slice(0, extra));
    if (onlyBlanks && staysBehind) this.markCol = 0;
  }

  private doWrap(): boolean {
    const context = this.justifyContext();
    const line = this._cursorLine;
    let text = this.line(line);
    const quoted = quoteLength(text, context.quote);
    const leadLen = quoted + indentLength(text.slice(quoted));
    const cursorX = this._cursorCol;
    const found = breakLine(text.slice(leadLen), context.wrapAt - wideness(text, leadLen, context.tabsize), context.tabsize);
    if (found < 0 || leadLen + found === text.length) return false;
    const wrapLoc = leadLen + found + 1;
    if (wrapLoc >= text.length) return false;
    const remainder = text.slice(wrapLoc);
    if (this.spillageLine === line + 1 && remainder.length + breadth(this.line(line + 1), context.tabsize) <= context.wrapAt) {
      let joined = text;
      if (!isBlankChar(remainder[remainder.length - 1])) joined += ' ';
      let tail = this.line(line + 1);
      if (tail.slice(0, leadLen) === joined.slice(0, leadLen)) tail = tail.slice(leadLen);
      while (isBlankChar(tail[0])) tail = tail.slice(1);
      this.forgetRemovedLines(line + 1, line + 1);
      this.linesArr.splice(line + 1, 1);
      text = joined + tail;
      this.linesArr[line] = text;
    }
    let at = wrapLoc;
    if (context.trimblanks) {
      let rear = wrapLoc - 1;
      const typed = Math.max(0, cursorX - 1);
      while ((rear !== typed || cursorX >= wrapLoc) && isBlankChar(text[rear])) {
        at = rear;
        text = text.slice(0, rear) + text.slice(rear + 1);
        rear = Math.max(0, rear - 1);
        if (rear === 0 && !isBlankChar(text[0])) break;
      }
      this.linesArr[line] = text;
    }
    this._cursorCol = at;
    this.breakLine(quoted > 0 ? false : this.live.autoindent);
    if (quoted > 0) {
      this.linesArr[line + 1] = this.line(line).slice(0, leadLen) + this.line(line + 1);
      this._cursorCol += leadLen;
    }
    this.spillageLine = this._cursorLine;
    if (cursorX < wrapLoc) {
      this._cursorLine--;
      this._cursorCol = cursorX;
    } else {
      this._cursorCol += cursorX - wrapLoc;
    }
    return true;
  }

  private markedLineRange(): { top: number; bottom: number } {
    const region = this.getMarkedRegion();
    if (region === null) return { top: this._cursorLine, bottom: this._cursorLine };
    const dropsLast = region.endCol === 0 && region.endLine !== region.startLine;
    return { top: region.startLine, bottom: dropsLast ? region.endLine - 1 : region.endLine };
  }

  private shiftLinesRight(top: number, bottom: number, unit: string): void {
    for (let index = top; index <= bottom; index++) {
      if (this.line(index) === '') continue;
      this.linesArr[index] = unit + this.line(index);
      if (index === this.markLine && (this.markCol ?? 0) > 0) this.markCol = (this.markCol ?? 0) + unit.length;
      if (index === this._cursorLine && this._cursorCol > 0) this._cursorCol += unit.length;
    }
  }

  private cutTillEnd(): void {
    const last = this.linesArr.length - 1;
    const atEol = this._cursorCol >= this.line(this._cursorLine).length;
    if (atEol && (this._cursorLine === last || (!this.live.nonewlines && this._cursorCol > 0 && this._cursorLine + 1 === last))) {
      this._statusMessage = '[ Nothing was cut ]';
      this.verticalKey = true;
      return;
    }
    this.undoBegin('CUT_TO_EOF');
    this.cutBuffer = null;
    this.extractSegment(this._cursorLine, this._cursorCol, last, this.line(last).length);
    this.cutAction = null;
    this.undoFinish();
    this._modified = true;
    this.wipeStatus();
  }

  private commentLines(): void {
    const prefix = '#';
    const range = this.markedLineRange();
    const last = this.linesArr.length - 1;
    if (range.top === range.bottom && range.bottom === last && !this.live.nonewlines) {
      this._statusMessage = '[ Cannot comment past end of file ]';
      return;
    }
    const commentable = (index: number): boolean => this.live.nonewlines || index !== last;
    let action: 'COMMENT' | 'UNCOMMENT' = 'UNCOMMENT';
    let allEmpty = true;
    for (let index = range.top; index <= range.bottom; index++) {
      const empty = [...this.line(index)].every((ch) => isBlankChar(ch));
      if (!empty && !(commentable(index) && this.line(index).startsWith(prefix))) {
        action = 'COMMENT';
        break;
      }
      allEmpty = allEmpty && empty;
    }
    if (allEmpty) action = 'COMMENT';
    this.undoBegin(action);
    for (let index = range.top; index <= range.bottom; index++) {
      if (!commentable(index)) continue;
      const text = this.line(index);
      if (action === 'COMMENT') {
        this.linesArr[index] = prefix + text;
        if (index === this.markLine && (this.markCol ?? 0) > 0) this.markCol = (this.markCol ?? 0) + prefix.length;
        if (index === this._cursorLine && this._cursorCol > 0) this._cursorCol += prefix.length;
      } else if (text.startsWith(prefix)) {
        this.linesArr[index] = text.slice(prefix.length);
        if (index === this.markLine) this.markCol = Math.max(0, (this.markCol ?? 0) - prefix.length);
        if (index === this._cursorLine) this._cursorCol = Math.max(0, this._cursorCol - prefix.length);
      }
    }
    this.undoFinish();
    this._modified = true;
  }

  private indentLines(): void {
    const range = this.markedLineRange();
    let top = range.top;
    while (top <= range.bottom && this.line(top) === '') top++;
    if (top > range.bottom) return;
    this.undoBegin('INDENT');
    this.shiftLinesRight(top, range.bottom, this.live.tabstospaces ? ' '.repeat(this.live.tabsize) : '\t');
    this.undoFinish();
    this._modified = true;
  }

  private unindentLines(): void {
    const range = this.markedLineRange();
    let top = range.top;
    while (top <= range.bottom && whiteLength(this.line(top), this.live.tabsize) === 0) top++;
    if (top > range.bottom) return;
    this.undoBegin('UNINDENT');
    for (let index = top; index <= range.bottom; index++) {
      const removed = whiteLength(this.line(index), this.live.tabsize);
      if (removed === 0) continue;
      this.linesArr[index] = this.line(index).slice(removed);
      if (index === this.markLine) this.markCol = Math.max(0, (this.markCol ?? 0) - removed);
      if (index === this._cursorLine) this._cursorCol = Math.max(0, this._cursorCol - removed);
    }
    this.undoFinish();
    this._modified = true;
  }

  private serializeRegion(r: { startLine: number; startCol: number; endLine: number; endCol: number }): string {
    const end = LINE_END[this.fileFormat];
    const text = this.extractRegionText(r).split('\n').join(end);
    return text === '' || text.endsWith(end) ? text : text + end;
  }

  private deleteRegion(r: { startLine: number; startCol: number; endLine: number; endCol: number }): void {
    if (r.startLine === r.endLine) {
      const text = this.line(r.startLine);
      this.linesArr[r.startLine] = text.slice(0, r.startCol) + text.slice(r.endCol);
    } else {
      const merged = this.line(r.startLine).slice(0, r.startCol) + this.line(r.endLine).slice(r.endCol);
      this.forgetRemovedLines(r.startLine + 1, r.endLine);
      this.linesArr.splice(r.startLine, r.endLine - r.startLine + 1, merged);
    }
    this._cursorLine = r.startLine;
    this._cursorCol = r.startCol;
  }

  private copyMark(): void {
    this.wipeStatus();
    this.manner = 'flowing';
    const marked = this.markLine !== null;
    if (marked || this.cutAction !== 'copy') this.cutAction = null;
    if (this.cutAction === null) this.cutBuffer = null;
    const region = this.getMarkedRegion();
    if (region !== null) {
      this.undo.lastAction = 'OTHER';
      this.clearMark();
      if (region.startLine === region.endLine && region.startCol === region.endCol) {
        this._statusMessage = '[ Copied nothing ]';
        return;
      }
      this.cutBuffer = this.extractRegionText(region).split('\n');
      return;
    }
    const text = this.line(this._cursorLine);
    const atEol = this._cursorCol >= text.length;
    const onLast = this._cursorLine === this.linesArr.length - 1;
    const fromCursor = this.live.cutfromcursor;
    if (onLast && atEol && (fromCursor || this._cursorCol === 0 || this.cutBuffer !== null)) {
      this._statusMessage = '[ Copied nothing ]';
      return;
    }
    const addition = text.slice(fromCursor ? this._cursorCol : 0);
    const withoutNewline = fromCursor ? !atEol : this.live.nonewlines && onLast;
    if (this.cutBuffer === null) this.cutBuffer = withoutNewline ? [addition] : [addition, ''];
    else if (withoutNewline) this.cutBuffer = [...this.cutBuffer.slice(0, -1), addition];
    else if (fromCursor) this.cutBuffer = [...this.cutBuffer, addition];
    else this.cutBuffer = [...this.cutBuffer.slice(0, -1), addition, this.cutBuffer[this.cutBuffer.length - 1]];
    if ((!fromCursor || atEol) && !onLast) {
      this._cursorLine++;
      this._cursorCol = 0;
    } else {
      this._cursorCol = text.length;
    }
    this.cutAction = 'copy';
    this.undo.lastAction = 'COPY';
  }

  private isCuttable(testCliff: boolean): boolean {
    const text = this.line(this._cursorLine);
    const from = testCliff ? this._cursorCol : 0;
    const atEol = from >= text.length;
    const onLast = this._cursorLine === this.linesArr.length - 1;
    const beforeLast = this._cursorLine === this.linesArr.length - 2;
    const nothing = (onLast && atEol && this.markLine === null)
      || (this.markLine === this._cursorLine && this.markCol === this._cursorCol)
      || (from > 0 && !this.live.nonewlines && atEol && beforeLast);
    if (!nothing) return true;
    this._statusMessage = '[ Nothing was cut ]';
    this.clearMark();
    this.verticalKey = true;
    return false;
  }

  private excise(region: { startLine: number; startCol: number; endLine: number; endCol: number }): void {
    const topWasInside = this.window.edittop >= region.startLine && this.window.edittop <= region.endLine;
    this.deleteRegion(region);
    this.ensureTrailingBlankLine();
    if (topWasInside) this.window.adjust('stationary', { line: region.startLine, col: region.startCol });
  }

  private extractSegment(topLine: number, topCol: number, bottomLine: number, bottomCol: number): void {
    const region = { startLine: topLine, startCol: topCol, endLine: bottomLine, endCol: bottomCol };
    const piece = this.extractRegionText(region).split('\n');
    this.excise(region);
    if (this.cutBuffer === null) this.cutBuffer = piece;
    else this.cutBuffer = [...this.cutBuffer.slice(0, -1), this.cutBuffer[this.cutBuffer.length - 1] + piece[0], ...piece.slice(1)];
  }

  private zapText(): void {
    if (!this.isCuttable(false)) return;
    const region = this.getMarkedRegion();
    if (region === null) return;
    if (!this.undo.continuesCut('ZAP', this.cutAction === 'cut')) this.undoBegin('ZAP');
    const kept = this.cutBuffer;
    this.cutBuffer = null;
    this.extractSegment(region.startLine, region.startCol, region.endLine, region.endCol);
    this.cutBuffer = kept;
    this.clearMark();
    if (this.linesArr.length === 0) this.linesArr.push('');
    this.wipeStatus();
    this.cutAction = null;
    this.undoFinish();
    this._modified = true;
  }

  private cutText(): void {
    this.wipeStatus();
    const marked = this.markLine !== null;
    if (!this.isCuttable(this.live.cutfromcursor && !marked)) return;
    if (!this.undo.continuesCut('CUT', this.cutAction === 'cut')) this.undoBegin('CUT');
    if (marked || this.cutAction !== 'cut') this.cutBuffer = null;
    const line = this._cursorLine;
    const col = this._cursorCol;
    const text = this.line(line);
    const onLast = line === this.linesArr.length - 1;
    const region = this.getMarkedRegion();
    if (region !== null) {
      this.extractSegment(region.startLine, region.startCol, region.endLine, region.endCol);
      this.clearMark();
    } else if (this.live.cutfromcursor) {
      if (col < text.length) this.extractSegment(line, col, line, text.length);
      else if (!onLast) this.extractSegment(line, col, line + 1, 0);
    } else if (!onLast) {
      this.extractSegment(line, 0, line + 1, 0);
    } else {
      this.extractSegment(line, 0, line, text.length);
    }
    if (this.linesArr.length === 0) this.linesArr.push('');
    this.cutAction = marked ? null : 'cut';
    this.undoFinish();
    this._modified = true;
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
    if (k.ctrl && k.key.toLowerCase() === 'k') {
      if (this._promptCursor === text.length) this._promptCursor = 0;
      set(text.slice(0, this._promptCursor));
      return true;
    }
    if (k.alt && k.key === '6') {
      if (text !== '') {
        this.cutBuffer = [text];
        this._promptCursor = 0;
      }
      return true;
    }
    if (k.ctrl && k.key.toLowerCase() === 'u') {
      if (this.cutBuffer !== null) this.insertIntoPromptField(get, set, this.cutBuffer[0]);
      return true;
    }
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
      this.submitWriteName();
      return;
    }
    if (k.alt && this.toggleWriteOption(k.key.toLowerCase())) return;
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this.exitAfterSave = false;
      this.cancelPrompt();
      return;
    }
    if (k.ctrl && k.key.toLowerCase() === 'q' && this.discardEnabled()) {
      this.exitAfterSave = false;
      this.finishExit(false);
      return;
    }
    const editsName = k.key === 'Backspace' || k.key === 'Delete' || (!k.ctrl && !k.alt && k.key.length === 1)
      || (k.ctrl && ['k', 'u'].includes(k.key.toLowerCase()));
    if (editsName && this.writeNameFrozen()) return;
    this.applyPromptFieldKey(k, () => this.saveFileNameBuffer, (v) => { this.saveFileNameBuffer = v; });
  }

  private confirmationQuestion(): string {
    const question = this.confirmation!.question;
    return typeof question === 'string' ? question : question(this.window.cols);
  }

  private toggleWriteOption(key: string): boolean {
    if ((this.live.restricted || this.settings.view) && (key === 'a' || key === 'b' || key === 'p')) return true;
    if (key === 'd') this.fileFormat = this.fileFormat === 'dos' ? 'unix' : 'dos';
    else if (key === 'm') this.fileFormat = this.fileFormat === 'mac' ? 'unix' : 'mac';
    else if (key === 'b') this.live.backup = !this.live.backup;
    else if (key === 'a' || key === 'p') {
      const method = key === 'a' ? 'append' : 'prepend';
      this.writeMethod = this.writeMethod === method ? 'overwrite' : method;
      if (this.saveFileNameBuffer === this.titleName) this.saveFileNameBuffer = '';
      this._promptCursor = this.saveFileNameBuffer.length;
    } else return false;
    return true;
  }

  private ask(question: string | ((columns: number) => string), yes: () => void, no: () => void, cancel: () => void = no, startup = false): void {
    this.confirmation = { question, startup, yes, no, cancel };
    this._mode = 'confirm';
  }

  private applyConfirmKey(k: EditorKeyInput): void {
    const confirmation = this.confirmation!;
    const given = yesNoAnswer(k, false);
    const answer = given === 'cancel' ? confirmation.cancel : given === 'yes' ? confirmation.yes : given === 'no' ? confirmation.no : null;
    if (answer === null) return;
    this.confirmation = null;
    this._mode = 'edit';
    answer();
  }

  private backToWritePrompt(): void {
    this._mode = 'save-prompt';
    this._promptCursor = this.saveFileNameBuffer.length;
  }

  private submitWriteName(): void {
    const name = this.saveFileNameBuffer;
    if (name === '') {
      this.exitAfterSave = false;
      this.cancelPrompt();
      return;
    }
    const exiting = this.exitAfterSave;
    const selection = !exiting && this.markLine !== null && !this.live.restricted;
    const target = this.writeTarget(name);
    const nameExists = this.pathKind(target) !== 'missing';
    const warn = this.bufferPath === '' ? nameExists : this.namesDiffer(name);
    const write = (): void => this.writeBuffer(name, target, exiting, selection);
    if (!warn || this.writeMethod !== 'overwrite') {
      write();
      return;
    }
    if (this.live.restricted) {
      this.pauseWith('File exists -- cannot overwrite');
      return;
    }
    const overwrite = (): void => {
      if (!nameExists) {
        write();
        return;
      }
      const room = this.window.cols - 'File "%s" exists; OVERWRITE? '.length + 1;
      this.ask(`File "${cropToFit(name, room)}" exists; OVERWRITE? `, write, () => this.backToWritePrompt());
    };
    if (this.bufferPath !== '' && (exiting || !selection)) this.ask('Save file under DIFFERENT NAME? ', overwrite, () => this.backToWritePrompt());
    else overwrite();
  }

  private writeBuffer(name: string, target: string, exiting: boolean, selection: boolean): void {
    const region = selection ? this.getMarkedRegion() : null;
    const written = region === null ? this.serialize() : this.serializeRegion(region);
    const method = this.writeMethod;
    const existing = this.fs.exists(target) ? this.fs.readFile(target) : null;
    this.exitAfterSave = false;
    this._mode = 'edit';
    if (method === 'prepend' && existing === null) {
      this._statusMessage = `[ Error reading ${name}: No such file or directory ]`;
      return;
    }
    if (this.live.backup && existing !== null && !this.fs.writeFile(this.backupPathFor(target), existing)) {
      this._statusMessage = '[ Cannot make backup ]';
      return;
    }
    const content = existing === null ? written : method === 'append' ? existing + written : method === 'prepend' ? written + existing : written;
    if (name.endsWith('/') || !this.fs.writeFile(target, content)) {
      this._statusMessage = `[ Error writing ${name}: ${this.writeFailureReason(name, target)} ]`;
      return;
    }
    const overwrite = method === 'overwrite';
    if (region !== null) {
      const count = written.split(LINE_END[this.fileFormat]).length - 1;
      this._statusMessage = `[ Wrote ${count} line${count === 1 ? '' : 's'} ]`;
      return;
    }
    if (exiting) {
      if (overwrite) {
        this._modified = false;
        this.undo.markSaved();
      }
      this.finishExit(true);
      return;
    }
    if (overwrite) {
      if (target !== this.bufferPath) this.renameBuffer(name, target);
      this._modified = false;
      this.undo.markSaved();
    }
    const n = this.writtenLineCount();
    if (this.minibarMode()) this.reportSizePending = true;
    else this._statusMessage = `[ Wrote ${n} line${n === 1 ? '' : 's'} ]`;
  }

  private backupPathFor(target: string): string {
    const directory = this.live.backupdir;
    if (directory === null) return `${target}~`;
    const folder = this.fs.resolvePath(directory);
    const base = `${folder.endsWith('/') ? folder : `${folder}/`}${target.replaceAll('/', '!')}`;
    let candidate = `${base}~`;
    for (let attempt = 1; this.fs.exists(candidate); attempt++) candidate = `${base}~.${attempt}`;
    return candidate;
  }

  private renameBuffer(name: string, target: string): void {
    this.dropLock();
    this.titleName = name;
    this.bufferPath = target;
    if (this.live.locking) this.acquireLock(name, false);
  }

  private identity(): EditorIdentity {
    this.lockHolder ??= this.launchIdentity ?? this.fs.identity?.() ?? { user: 'root', host: 'localhost', pid: 1 };
    return this.lockHolder;
  }

  private lockFileFor(typedName: string): { path: string; shown: string } {
    const path = dotSwapPathFor(this.fs.resolvePath(typedName));
    const slash = typedName.lastIndexOf('/');
    const directory = slash < 0 ? '.' : slash === 0 ? '' : typedName.slice(0, slash);
    return { path, shown: `${directory}/.${typedName.slice(slash + 1)}.swp` };
  }

  private writeLock(typedName: string, modified: boolean): void {
    const holder = this.identity();
    this.lockPath = this.lockFileFor(typedName).path;
    this.fs.writeFile(this.lockPath, buildNanoLock({ program: 'nano 7.2', pid: holder.pid, user: holder.user, host: holder.host, name: typedName, modified }));
  }

  private acquireLock(typedName: string, ask: boolean): void {
    const lock = this.lockFileFor(typedName);
    const existing = this.fs.readFile(lock.path);
    if (existing === null) {
      this.writeLock(typedName, false);
      return;
    }
    if (!ask) {
      this._statusMessage = '[ Someone else is also editing this file ]';
      this.writeLock(typedName, false);
      return;
    }
    const holder = parseNanoLock(existing);
    if (holder === null) {
      this._statusMessage = `[ Bad lock file is ignored: ${lock.shown} ]`;
      return;
    }
    const question = (columns: number): string => lockQuestion(typedName, holder, columns);
    const takeIt = (): void => {
      this.writeLock(typedName, false);
      this._statusMessage = question(this.window.cols);
      this.statusRaw = true;
      this.statusCountdown = 0;
    };
    this.ask(question, takeIt, () => this.skipFile(), () => this.finishExit(false), true);
  }

  private beginLocking(): void {
    this.acquireLock(this.titleName, true);
  }

  private skipFile(): void {
    this.bufferPath = '';
    this.titleName = '';
    this.saveFileNameBuffer = '';
    this.linesArr = [''];
    this._cursorLine = 0;
    this._cursorCol = 0;
    this.live.view = false;
    this._readOnly = false;
    this.wipeStatus();
    if (!this.live.nohelp) this._statusMessage = '[ Welcome to nano.  For basic help, type Ctrl+G. ]';
  }

  private lockAsModified(): void {
    if (this.lockPath === '') return;
    this.writeLock(this.titleName, true);
  }

  private dropLock(): void {
    if (this.lockPath !== '') this.fs.deleteFile(this.lockPath);
    this.lockPath = '';
  }

  // ── Exit-save (Y/N/^C) prompt ───────────────────────────────────

  private applyExitSavePromptKey(k: EditorKeyInput): void {
    const given = yesNoAnswer(k, false);
    if (given === 'yes') this.beginWriteOut(true);
    else if (given === 'no') this.finishExit(false);
    else if (given === 'cancel') this.cancelPrompt();
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
      ? wideness(text, text.length, this.live.tabsize) + column + 2
      : column === 0 ? this.window.columnOf(this._cursorLine, this._cursorCol) + 1 : column;
    this._cursorLine = target;
    this._cursorCol = actualX(text, Math.max(0, displayColumn - 1), this.live.tabsize);
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
      const name = this.readFileBuffer;
      this._mode = 'edit';
      if (name === '') this.cancelPrompt();
      else this.insertFileNamed(name);
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this.cancelPrompt();
      return;
    }
    if (k.alt && k.key.toLowerCase() === 'n') {
      this.live.noconvert = !this.live.noconvert;
      return;
    }
    this.applyPromptFieldKey(k, () => this.readFileBuffer, (v) => { this.readFileBuffer = v; });
  }

  private screenfulMark(): { line: number; leftedge: number } {
    const leftedge = this.live.softwrap ? this.window.leftedgeFor(this.window.columnOf(this._cursorLine, this._cursorCol), this._cursorLine) : 0;
    return { line: this._cursorLine, leftedge };
  }

  private lessThanScreenful(was: { line: number; leftedge: number }): boolean {
    if (!this.live.softwrap) return this._cursorLine - was.line < this.window.editRows;
    const at = this.screenfulMark();
    const left = this.window.goBack(this.window.editRows - 1, at);
    return left > 0 || at.line < was.line || (at.line === was.line && at.leftedge <= was.leftedge);
  }

  private namesDiffer(name: string): boolean {
    const answer = fullPathOf(name, this.fs);
    const current = fullPathOf(this.titleName, this.fs);
    return answer !== null && current !== null ? answer !== current : name !== this.titleName;
  }

  private writeFailureReason(name: string, target: string): string {
    const parentKind = this.pathKind(directoryNameOf(target));
    if (parentKind === 'missing') return 'No such file or directory';
    if (parentKind !== 'directory') return 'Not a directory';
    const kind = this.pathKind(target);
    if (name.endsWith('/')) return kind === 'file' ? 'Not a directory' : 'Is a directory';
    return kind === 'directory' ? 'Is a directory' : 'Permission denied';
  }

  private pathKind(path: string): EditorPathKind {
    return this.fs.kindOf?.(path) ?? (this.fs.exists(path) ? 'file' : 'missing');
  }

  private insertFileNamed(name: string): void {
    const kind = this.pathKind(name);
    if (kind === 'missing') {
      this._statusMessage = `[ File "${name}" not found ]`;
      return;
    }
    if (kind !== 'file') {
      this._statusMessage = `[ "${name}" is ${kind === 'directory' ? 'a directory' : kind === 'device' ? 'a device file' : 'a FIFO'} ]`;
      return;
    }
    const decoded = decodeFile(this.fs.readFile(name) ?? '', !this.live.noconvert, false);
    const was = { line: this._cursorLine, col: this._cursorCol };
    const wasScreenful = this.screenfulMark();
    this.undoBegin('INSERT');
    this.insertText(decoded.lines.join('\n'));
    this.undoFinish();
    if (this.lessThanScreenful(wasScreenful)) this.manner = 'flowing';
    if (this._cursorLine !== was.line || this._cursorCol !== was.col) this._modified = true;
    this._statusMessage = `[ Read ${decoded.count} line${decoded.count === 1 ? '' : 's'}${decoded.format === 'unix' ? '' : ` (Converted from ${decoded.format === 'dos' ? 'DOS' : 'Mac'} format)`} ]`;
  }

  private get wrapAt(): number {
    const fill = this.live.fill ?? DEFAULT_FILL;
    const columns = this.window.cols;
    if (columns + fill < 0) return 0;
    return fill <= 0 ? columns + fill : fill;
  }

  private justifyContext(): JustifyContext {
    let quote: RegExp;
    try {
      quote = new RegExp(this.live.quotestr ?? DEFAULT_QUOTE_PATTERN);
    } catch {
      quote = new RegExp(DEFAULT_QUOTE_PATTERN);
    }
    return {
      quote,
      bookstyle: this.live.bookstyle,
      autoindent: this.live.autoindent,
      trimblanks: this.live.trimblanks,
      wrapAt: this.wrapAt,
      tabsize: this.live.tabsize,
    };
  }

  private justifyText(wholeBuffer: boolean): void {
    const context = this.justifyContext();
    const quote = context.quote;
    const last = this.linesArr.length - 1;
    const markedRegion = this.getMarkedRegion();
    const wasLine = this._cursorLine;
    let start = { line: 0, col: 0 };
    let end = { line: 0, col: 0 };
    let count = 0;
    let primaryLead = '';
    let secondaryLead = '';
    let beforeEol = false;
    if (markedRegion !== null) {
      start = { line: markedRegion.startLine, col: markedRegion.startCol };
      end = { line: markedRegion.endLine, col: markedRegion.endCol };
      if (start.line === end.line && start.col === end.col) {
        this._statusMessage = '[ Selection is empty ]';
        return;
      }
      if (start.col <= leadLength(this.line(start.line), quote)) start.col = 0;
      while (start.col > 0 && isBlankChar(this.line(start.line)[start.col - 1])) start.col--;
      if (end.col > 0 && end.col < leadLength(this.line(end.line), quote)) end.col = leadLength(this.line(end.line), quote);
      while (end.col > 0 && isBlankChar(this.line(end.line)[end.col])) end.col++;
      let sample = start.line;
      while (sample > 0 && inParagraph(this.line(sample), quote) && !beginsParagraph(this.linesArr, sample, 0, context)) sample--;
      while (sample < last && !inParagraph(this.line(sample), quote)) sample++;
      const sampleText = this.line(sample);
      const quoted = quoteLength(sampleText, quote);
      primaryLead = sampleText.slice(0, leadLength(sampleText, quote));
      if (sample < last && start.line !== end.line) sample++;
      const other = this.line(sample);
      const otherQuoted = quoteLength(other, quote);
      secondaryLead = this.line(start.line).slice(0, quoted) + other.slice(otherQuoted, otherQuoted + indentLength(other.slice(otherQuoted)));
      count = end.line - start.line + (end.col > 0 ? 1 : 0);
      beforeEol = end.col < this.line(end.line).length;
    } else {
      let from = wholeBuffer ? 0 : this._cursorLine;
      if (!wholeBuffer && inParagraph(this.line(from), quote) && !beginsParagraph(this.linesArr, from, 0, context)) {
        from = paragraphStart(this.linesArr, from, context);
      }
      const found = findParagraph(this.linesArr, from, context);
      if (found === null) {
        this._cursorLine = last;
        this._cursorCol = this.line(last).length;
        return;
      }
      count = found.count;
      start = { line: found.first, col: 0 };
      const lastLine = wholeBuffer ? last : found.first + found.count - 1;
      end = lastLine < last ? { line: lastLine + 1, col: 0 } : { line: lastLine, col: this.line(lastLine).length };
    }
    this.undoBegin('COUPLE', 'justification');
    const region = { startLine: start.line, startCol: start.col, endLine: end.line, endCol: end.col };
    const piece = this.extractRegionText(region).split('\n');
    this.excise(region);
    if (markedRegion !== null) {
      const first = piece[0];
      const trimmed = first.slice(leadLength(first, quote));
      piece[0] = primaryLead + trimmed;
      concatenateParagraph(piece, 0, count, quote);
      piece[0] = squeeze(piece[0], primaryLead.length);
      rewrapParagraph(piece, 0, secondaryLead, context);
      if (start.col > 0) piece.unshift('');
      if (end.col > 0 && beforeEol) piece.push(primaryLead);
    } else {
      let index = justifyParagraph(piece, 0, count, context);
      if (wholeBuffer) {
        let found = findParagraph(piece, index, context);
        while (found !== null) {
          index = justifyParagraph(piece, found.first, found.count, context);
          if (index >= piece.length - 1) break;
          found = findParagraph(piece, index, context);
        }
      }
    }
    if (markedRegion !== null) {
      this.markLine = start.line;
      this.markCol = start.col;
    }
    this.insertText(piece.join('\n'));
    if (markedRegion === null && wholeBuffer) {
      this._cursorLine = Math.min(wasLine, this.linesArr.length - 1);
      this._cursorCol = 0;
    }
    this.undoFinish();
    if (markedRegion !== null) this._statusMessage = '[ Justified selection ]';
    else this._statusMessage = wholeBuffer ? '[ Justified file ]' : '[ Justified paragraph ]';
    this._modified = true;
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
    this.undo.begin('REPLACE', this.linesArr, { line: pm.line, col: pm.start }, this.window.cursorRow);
    // Real nano's replacement text is always literal — it does not support
    // \1-style backreferences even when the search side is a regex.
    this.linesArr[pm.line] = line.slice(0, pm.start) + st.replacement + line.slice(pm.end);
    this.undo.finish({ line: pm.line, col: pm.start });
    st.totalReplaced++;
    this._modified = true;
    st.currentCol = pm.start + st.replacement.length;
  }

  private applyReplaceConfirmKey(k: EditorKeyInput): void {
    const given = yesNoAnswer(k, true);
    if (given === 'cancel') { this.finishReplace(); return; }
    if (given === 'yes') {
      this.applyPendingReplaceMatch();
      this._pendingReplaceMatch = null;
      if (!this.advanceReplaceMatch()) this.finishReplace();
      return;
    }
    if (given === 'no') {
      const st = this.replaceState!;
      const pm = this._pendingReplaceMatch!;
      st.currentCol = pm.end;
      this._pendingReplaceMatch = null;
      if (!this.advanceReplaceMatch()) this.finishReplace();
      return;
    }
    if (given === 'all') {
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
    this.dropLock();
  }
}
