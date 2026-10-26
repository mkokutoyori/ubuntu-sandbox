import type { ChildShellRun, EditorFsContext, EditorIdentity, EditorPathKind } from './EditorFsContext';
import { editorKey, type EditorKeyInput } from './EditorKeyInput';
import { dotSwapPathFor } from './editorPaths';
import { buildNanoLock, cropToFit, lockQuestion, parseNanoLock } from './nano/NanoLock';
import { decodeFile, LINE_END, type DecodedFile, type NanoFileFormat } from './nano/NanoFormat';
import { directoryNameOf, fullPathOf, openingFor, writeFailureReason } from './nano/NanoOpening';
import { appendToHistory, parseHistoryLists, serializeHistoryLists } from './nano/NanoHistoryLists';
import { findPosition, parsePositionHistory, serializePositionHistory, withPositionRecorded } from './nano/NanoPositionHistory';
import type { NanoRcNotices } from './editorLaunch';
import { POSITION_HISTORY_FILE, resolveStateDirectory, SEARCH_HISTORY_FILE, STARTUP_PROBLEM } from './nano/NanoStateDirectory';
import { NanoUndoStack, type UndoKind, type UndoRestore } from './nano/NanoUndo';
import {
  expandReplacement, PosixRegexError, SearchCircuit, SearchPattern,
  type SearchHit, type SearchModus, type SearchSpot, type SearchStyle,
} from './nano/NanoSearch';
import { yesNoAnswer } from './nano/NanoYesNo';
import { NanoWindow, SHORTCUT_BARS_MINIMUM, type ViewportManner } from './nano/NanoWindow';
import { MESSAGE_LEVEL, messageLevel } from './nano/NanoMessages';
import type { MinibarInfo } from './nano/NanoScreen';
import { buildNanoScreen, promptCursorAtColumn } from './nano/NanoScreen';
import { actualX, breadth, displayString, isBlankChar, leadingBytes, parseLineAndColumn, wideness } from './nano/NanoText';
import {
  DEFAULT_BRACKETS, DEFAULT_PUNCTUATION, DEFAULT_QUOTE_PATTERN, beginsParagraph, breakLine, concatenateParagraph, findParagraph, inParagraph, indentLength, justifyParagraph, leadLength,
  paragraphEnd, paragraphStart, quoteLength, rewrapParagraph, squeeze, type JustifyContext,
} from './nano/NanoJustify';
import { nextBlockLine, nextWordSpot, previousBlockLine, previousWordSpot } from './nano/NanoMotion';
import type { MenuOptions, NanoMenuName } from './nano/NanoMenus';
import { helpAction, helpCursorMotion, unboundKeyMessage } from './nano/NanoHelpKeys';
import { helpPage, type HelpMenu } from './nano/NanoHelpText';
import type { NanoSearchRequest, NanoStart } from './nano/NanoCommandLine';
import { defaultNanoSettings, type NanoSettings } from './nano/NanoSettings';
import { resolveInterfacePaints } from './nano/NanoPaint';
import { GENERAL_COMMENT, type SyntaxCatalog, type SyntaxDefinition } from './nano/NanoSyntax';
import { precalculateMultiData, type MultiData } from './nano/NanoSyntaxPaint';
import type { EditorScreen, ScreenRow } from './screen/EditorScreen';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';
import { OperatingDirectory, operatingDirectoryRoot } from './nano/NanoOperatingDirectory';
import { completeFileName, nextHistoryCompletion } from './nano/NanoCompletion';
import { clickedShortcut, clickedYesNo, keyOfShortcutLabel, WHEEL_STEP } from './nano/NanoMouse';
import { WorkingDirectoryFs } from './WorkingDirectoryFs';

export type NanoMode =
  | 'edit' | 'save-prompt' | 'exit-save-prompt' | 'search'
  | 'replace-search' | 'replace-with' | 'replace-confirm' | 'goto-line'
  | 'help' | 'execute-prompt' | 'read-file-prompt' | 'confirm';

const DEFAULT_FILL = -8;

const EDIT_TOGGLES: Readonly<Record<string, { readonly flag: 'breaklonglines' | 'tabstospaces' | 'autoindent' | 'smarthome' | 'cutfromcursor' | 'mouse'; readonly epithet: string }>> = {
  l: { flag: 'breaklonglines', epithet: 'Hard wrapping of overlong lines' },
  o: { flag: 'tabstospaces', epithet: 'Conversion of typed tabs to spaces' },
  i: { flag: 'autoindent', epithet: 'Auto indent' },
  h: { flag: 'smarthome', epithet: 'Smart home key' },
  k: { flag: 'cutfromcursor', epithet: 'Cut to end' },
  m: { flag: 'mouse', epithet: 'Mouse support' },
};

function swappedDeleteKey(input: EditorKeyInput): EditorKeyInput {
  if (input.ctrl || input.alt) return input;
  if (input.key === 'Backspace') return { ...input, key: 'Delete' };
  if (input.key === 'Delete') return { ...input, key: 'Backspace' };
  return input;
}

const CONTROL_MOTIONS: Readonly<Record<string, string>> = { b: 'ArrowLeft', f: 'ArrowRight', p: 'ArrowUp', n: 'ArrowDown', a: 'Home', e: 'End', d: 'Delete', h: 'Backspace' };
const STATUS_LINGER_KEYS = 20;
const PAUSE_MILLIS = 1800;
const VIEW_WARNING_MILLIS = 600;

export interface Confirmation {
  readonly question: string | ((columns: number) => string);
  readonly startup: boolean;
  readonly yes: () => void;
  readonly no: () => void;
  readonly cancel: () => void;
}

export interface MenuFlags {
  readonly preserve: boolean;
  readonly saveonexit: boolean;
}

export interface NanoLaunchOptions {
  readonly identity?: EditorIdentity;
  readonly settings?: NanoSettings;
  readonly start?: NanoStart | null;
  readonly displayName?: string;
  readonly helpTitle?: string;
  readonly staleFooter?: ScreenRow;
  readonly rc?: NanoRcNotices | null;
  readonly menuFlags?: MenuFlags;
}

export interface PendingReplaceMatch {
  line: number;
  start: number;
  end: number;
  matchText: string;
}

interface ReplaceRun {
  readonly pattern: SearchPattern;
  readonly replacement: string;
  readonly backwards: boolean;
  readonly circuit: SearchCircuit;
  readonly begin: SearchSpot;
  readonly edittop: number;
  readonly firstcolumn: number;
  modus: SearchModus;
  skipOne: boolean;
  replaceAll: boolean;
  replaced: number;
  region: { topLine: number; topCol: number; botLine: number; botCol: number } | null;
  mark: SearchSpot | null;
  markIsBeforeCursor: boolean;
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
    if (value !== this.modifiedState) this.markFlagHidden = false;
    this.modifiedState = value;
  }
  private markFlagHidden = false;
  private statusText = '';
  private statusCountdown = 0;
  private statusAlert = false;
  private pauseNote: string | null = null;
  private pauseMillis = PAUSE_MILLIS;
  private pauseKeepsMenu = false;
  private statusMore = false;
  private openingAlerted = false;
  private messageThisKey = false;
  private get _statusMessage(): string { return this.statusText; }
  private set _statusMessage(value: string) {
    this.staleFooter = null;
    this.statusText = value;
    this.statusCountdown = value === '' ? 0 : this.live.quickblank ? 1 : STATUS_LINGER_KEYS;
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
  private readonly helpTitle: string | null;
  private staleFooter: ScreenRow | null;
  private helpViewer: NanoEngine | null = null;
  private metaKeyUsed = false;
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
  private executeHistory: string[] = [];
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
  private searchAnswer = '';
  private searchDefaultText = '';
  private lastSearchTerm = '';
  private searchHistory: string[] = [];
  private replaceHistory: string[] = [];
  private historyPosition: number | null = null;
  private tabPointers = new Map<string[], number>();
  private historyInUse: string[] | null = null;
  private listedCompletions: readonly string[] | null = null;
  private listedIn: NanoMode | null = null;
  private tabFragmentLength: number | null = null;
  private tabPressedThisKey = false;
  private stateDirectory: string | null = null;
  private historyChanged = false;
  private startupProblem: string | null = null;
  private catalog: SyntaxCatalog | null = null;
  private activeSyntax: SyntaxDefinition | null = null;
  private syntaxHidden = false;
  private multiCache: { readonly key: string; readonly syntax: SyntaxDefinition; readonly data: MultiData } | null = null;
  private readonly exitNotices: string[] = [];
  private historyStash: string | null = null;
  private useRegex = false;
  private replaceWithBuffer = '';
  private replaceOrigin: { pattern: SearchPattern; line: number; col: number; edittop: number; firstcolumn: number } | null = null;
  private replaceRun: ReplaceRun | null = null;
  private pendingHit: SearchHit | null = null;
  private searchSpotlight: { line: number; start: number; end: number } | null = null;
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

  private readonly fs: EditorFsContext;
  private readonly operating: OperatingDirectory | null;
  private readonly menuFlags: MenuFlags;

  constructor(
    fsContext: EditorFsContext,
    filePath: string,
    initialContent: string,
    isNewFile: boolean,
    readOnly = false,
    initialCursor?: { line: number; col?: number },
    showLineNumbers = false,
    launch: NanoLaunchOptions = {},
  ) {
    this.helpTitle = launch.helpTitle ?? null;
    this.staleFooter = launch.staleFooter ?? null;
    this.settings = launch.settings ?? defaultNanoSettings({ view: readOnly, linenumbers: showLineNumbers });
    this.launchIdentity = launch.identity;
    this.menuFlags = launch.menuFlags ?? { preserve: this.settings.preserve, saveonexit: this.settings.saveonexit };
    const operatingRoot = this.settings.operatingdir === null ? null : operatingDirectoryRoot(fsContext, this.settings.operatingdir);
    this.fs = operatingRoot === null ? fsContext : new WorkingDirectoryFs(fsContext, operatingRoot.replace(/\/$/, '') || '/');
    this.operating = operatingRoot === null ? null : new OperatingDirectory(operatingRoot, this.fs);
    const typedName = launch.displayName ?? filePath;
    const confined = this.operating !== null && filePath !== '' && this.operating.outside(typedName);
    const opening = confined ? { path: '', alert: this.operating!.readRefusal(), lockable: false } : openingFor(typedName, filePath, this.fs, this.identity().user);
    const content = confined ? '' : initialContent;
    const named = opening.path !== '';
    this.live = { ...this.settings, view: this.settings.view && named };
    if (this.live.restricted) {
      this.live.backup = false;
      this.live.historylog = false;
      this.live.positionlog = false;
    }
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
        indicator: this.live.indicator,
      }),
    );
    const unread = this.live.noread && named;
    const decoded = unread || content.length === 0 ? { lines: [''], format: 'unix' as NanoFileFormat, count: 0 } : decodeFile(content, !this.live.noconvert, !this.live.nonewlines);
    this.linesArr = decoded.lines;
    this.fileFormat = this.live.unix ? 'unix' : decoded.format;
    this.ensureTrailingBlankLine();
    this.openingAlerted = opening.alert !== null;
    if (opening.alert !== null) this._statusMessage = `[ ${opening.alert} ]`;
    else if (!named) {
      if (!this.live.nohelp && this.helpTitle === null) this._statusMessage = '[ Welcome to nano.  For basic help, type Ctrl+G. ]';
    } else if (unread) this._statusMessage = '';
    else if (isNewFile) this._statusMessage = '[ New File ]';
    else if (!this.live.minibar && !this.live.zero) this._statusMessage = `[ Read ${decoded.count} line${decoded.count === 1 ? '' : 's'}${decoded.format === 'unix' ? '' : ` (Converted from ${decoded.format === 'dos' ? 'DOS' : 'Mac'} format)`} ]`;
    this.reportSizePending = true;
    this.saveFileNameBuffer = this.titleName;
    if (this.live.locking && !this._readOnly && named && opening.lockable) this.beginLocking();
    const start = launch.start ?? (initialCursor ? { line: initialCursor.line, column: initialCursor.col ?? 0, search: null, caseSensitive: null, regex: null, alerts: [] } : null);
    if (launch.rc) {
      this.exitNotices.push(...launch.rc.errors);
      this.startupProblem = launch.rc.startupProblem;
    }
    this.caseSensitive = this.live.casesensitive;
    this.useRegex = this.live.regexp;
    this.openStateFiles();
    this.catalog = launch.rc?.catalog ?? null;
    this.selectSyntax();
    const positioned = start !== null && this.applyStart(start);
    if (!positioned && named) this.restoreLoggedPosition(typedName);
    if (this.startupProblem !== null) this.announceStartupProblem(this.startupProblem);
  }

  private announceStartupProblem(problem: string): void {
    this.raiseAlert(problem);
  }

  private raiseAlert(text: string): void {
    if (messageLevel(this._statusMessage) === MESSAGE_LEVEL.alert) this.statusMore = true;
    else this._statusMessage = `[ ${text} ]`;
  }

  private selectSyntax(): void {
    if (this.catalog === null || this.helpTitle !== null) return;
    const name = this.titleName;
    const fullName = (name === '' ? null : fullPathOf(name, this.fs)) ?? name;
    const selection = this.catalog.select(this.live.syntax, fullName, this.linesArr[0] ?? '', (message, at) => this.recordSyntaxError(message, at?.file ?? '', at?.line ?? 0));
    this.activeSyntax = selection.syntax;
    this.multiCache = null;
    if (selection.alert !== null) this.raiseAlert(selection.alert);
  }

  private recordSyntaxError(message: string, file: string, line: number): void {
    this.exitNotices.push(line > 0 ? `Error in ${file} on line ${line}: ${message}` : message);
    this.startupProblem ??= `Mistakes in '${file}'`;
  }

  private syntaxPainting(): { rules: SyntaxDefinition['rules']; multi: MultiData } | null {
    const syntax = this.activeSyntax;
    if (syntax === null || this.syntaxHidden || syntax.rules.length === 0) return null;
    const key = this.linesArr.join('\n');
    if (this.multiCache === null || this.multiCache.key !== key || this.multiCache.syntax !== syntax) {
      this.multiCache = { key, syntax, data: precalculateMultiData(this.linesArr, syntax.rules, syntax.multiCount) };
    }
    return { rules: syntax.rules, multi: this.multiCache.data.map((states) => states.slice()) };
  }

  private toggleSyntax(): void {
    this.verticalKey = true;
    this.syntaxHidden = !this.syntaxHidden;
    this._statusMessage = `[ Color syntax highlighting ${this.syntaxHidden ? 'disabled' : 'enabled'} ]`;
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
  get mode(): NanoMode { return this.helpViewer !== null ? 'help' : this._mode; }
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
  get helpText(): string { return this.helpViewer === null ? '' : this.helpViewer.bufferLines.join('\n'); }
  get searchQuery(): string { return this.searchAnswer; }
  get filePath(): string { return this.bufferPath; }
  get swapFilePath(): string { return this.lockPath; }
  get swapFileExists(): boolean { return this.lockPath !== '' && this.fs.exists(this.lockPath); }
  /** True when opened with `-v` (view mode) — real nano refuses all edits and offers no Write Out. */
  get isReadOnly(): boolean { return this._readOnly; }
  /** `nano -l`/`--linenumbers` at open, toggled at runtime by M-#. */
  get lineNumbersShown(): boolean { return this.live.linenumbers; }
  /** Real nano's regex-search toggle (Meta+R / Alt+R inside a search or replace prompt). */
  get regexSearchEnabled(): boolean { return this.useRegex; }
  get replaceSearchQuery(): string { return this.searchAnswer; }
  get replaceWithText(): string { return this.replaceWithBuffer; }
  get pendingReplaceMatch(): PendingReplaceMatch | null { return this._pendingReplaceMatch; }

  // ── Key dispatch ─────────────────────────────────────────────────

  applyKey(input: EditorKeyInput): void {
    if (this._exited) return;
    const k = this.live.rebinddelete ? swappedDeleteKey(input) : input;
    if (this.live.preserve && k.ctrl && (k.key.toLowerCase() === 'q' || k.key.toLowerCase() === 's')) return;
    if (k.alt) this.metaKeyUsed = true;
    if (this.helpViewer !== null) {
      this.keyInHelp(k);
      return;
    }
    this.runInput(k, () => {
      const wasPrompting = this.isPrompting();
      if (wasPrompting && k.alt && k.key.toLowerCase() === 'x') {
        if (this.helpTitle === null) this.toggleHelpInPrompt();
      } else if (wasPrompting && this.helpTitle === null && k.ctrl && k.key.toLowerCase() === 'g' && this.helpMenuOfPrompt() !== null) {
        this.openHelp(this.helpMenuOfPrompt()!);
      } else {
        this.dispatchKey(k);
      }
    });
  }

  private runInput(k: EditorKeyInput | null, act: () => void): void {
    this.pauseNote = null;
    if (this.statusCountdown > 0 && --this.statusCountdown === 0) {
      this.statusText = '';
      this.statusAlert = false;
      this.statusMore = false;
    }
    this.messageThisKey = false;
    const carriedSpotlight = this.searchSpotlight;
    this.searchSpotlight = null;
    this.manner = 'centering';
    this.verticalKey = false;
    this.redrawsOnlyChangedLines = false;
    const viewBefore = { top: this.window.edittop, left: this.window.firstcolumn };
    if (k !== null && !this.isPrompting() && !((k.ctrl && k.key.toLowerCase() === 'k') || (k.alt && k.key === '6'))) this.cutAction = null;
    if (this.bareDisplay()) this.wipeStatus();
    const wasPrompting = this.isPrompting();
    const cursorBefore = { line: this._cursorLine, col: this._cursorCol };
    this.tabPressedThisKey = false;
    act();
    if (k !== null && !this.tabPressedThisKey) this.tabFragmentLength = null;
    if (this.listedCompletions !== null && this._mode !== this.listedIn) this.listedCompletions = null;
    if (this.searchSpotlight === null && this.isPrompting()) this.searchSpotlight = carriedSpotlight;
    if ((wasPrompting || this.isPrompting()) && !this.messageThisKey) this.wipeStatus();
    this.ensureTrailingBlankLine();
    const promptLeftCursorAlone = (wasPrompting || this.isPrompting())
      && cursorBefore.line === this._cursorLine && cursorBefore.col === this._cursorCol;
    if (!this.verticalKey && !promptLeftCursorAlone) this.placeWant = this.window.columnOf(this._cursorLine, this._cursorCol);
    if (this.reportsPositionAsMessage() && this._mode === 'edit' && !this.messageThisKey) this._statusMessage = this.locationMessage();
    this.followCursor();
    if (this.redrawsOnlyChangedLines && this.zeroMode() && this._mode === 'edit' && viewBefore.top === this.window.edittop && viewBefore.left === this.window.firstcolumn) this.staleFooter = { text: '', spans: [] };
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
    const prompting = this.isPrompting();
    if (!this.minibarMode() || prompting || this.helpTitle !== null) return null;
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
    if (!this.live.mouse || this._exited) return;
    if (this.helpViewer !== null) {
      this.helpViewer.clickAt(row, col);
      this.settleHelpViewer();
      return;
    }
    const yesNo = this.yesNoQuestion();
    if (yesNo !== null) {
      const footerRow = this.footerRowOf(row);
      const choice = footerRow === null ? null : clickedYesNo(this.window.cols, yesNo.withAll, footerRow, col);
      if (choice !== null) this.feedKeys([choice === 'cancel' ? editorKey('c', { ctrl: true }) : editorKey(choice)]);
      return;
    }
    const footerRow = this.footerRowOf(row);
    if (footerRow !== null && footerRow > 0 && this.window.layout.barsFrom !== null) {
      this.feedOrIgnore(this.pointerKeys(row, col, null));
      return;
    }
    if (this.helpTitle !== null) {
      this.runInput(null, () => undefined);
      return;
    }
    this.runInput(null, () => {
      if (this._mode === 'edit') this.clickInEditWindow(row, col);
      else if (footerRow !== null) this.clickInPrompt(col);
    });
  }

  wheelAt(row: number, col: number, forward: boolean): void {
    if (!this.live.mouse || this._exited) return;
    if (this.helpViewer !== null) {
      this.helpViewer.wheelAt(row, col, forward);
      this.settleHelpViewer();
      return;
    }
    this.feedOrIgnore(this.pointerKeys(row, col, forward ? 'down' : 'up'));
  }

  pointerKeys(row: number, col: number, wheel: 'up' | 'down' | null): EditorKeyInput[] {
    const layout = this.window.layout;
    const footerRow = this.footerRowOf(row);
    if (wheel !== null) {
      const inMiddle = row >= layout.editFrom && row < layout.editFrom + this.window.editRows;
      if (!inMiddle && footerRow !== 0) return [];
      return Array.from({ length: WHEEL_STEP }, () => editorKey(wheel === 'up' ? 'ArrowUp' : 'ArrowDown'));
    }
    if (footerRow === null || footerRow === 0 || layout.barsFrom === null) return [];
    const entry = clickedShortcut(this.window.cols, this.activeMenu(), this.menuOptions(), footerRow, col);
    const key = entry === null ? null : keyOfShortcutLabel(entry.key);
    return key === null ? [] : [key];
  }

  private feedOrIgnore(keys: readonly EditorKeyInput[]): void {
    if (keys.length === 0) this.runInput(null, () => undefined);
    else this.feedKeys(keys);
  }

  private feedKeys(keys: readonly EditorKeyInput[]): void {
    for (const key of keys) this.applyKey(key);
  }

  private footerRowOf(row: number): number | null {
    const statusRow = this.window.layout.statusRow;
    return row >= statusRow && row < this.window.rows ? row - statusRow : null;
  }

  private yesNoQuestion(): { withAll: boolean } | null {
    switch (this._mode) {
      case 'exit-save-prompt':
      case 'confirm':
        return { withAll: false };
      case 'replace-confirm':
        return { withAll: true };
      default:
        return null;
    }
  }

  private clickInEditWindow(row: number, col: number): void {
    const window = this.window;
    const top = window.layout.editFrom;
    if (row < top || row >= top + window.editRows || col < window.margin) return;
    const was = { line: this._cursorLine, col: this._cursorCol, row: window.cursorRow };
    const at = { line: window.edittop, leftedge: window.firstcolumn };
    window.goForward(row - top, at);
    const text = this.line(at.line);
    let column = Math.max(0, col - window.margin);
    if (this.live.softwrap) column += at.leftedge;
    else column += window.pageStart(window.columnOf(this._cursorLine, this._cursorCol));
    this._cursorLine = at.line;
    this._cursorCol = actualX(text, column, this.live.tabsize);
    this.manner = 'flowing';
    this.placeWant = window.columnOf(this._cursorLine, this._cursorCol);
    this.verticalKey = true;
    this.followCursor();
    if (row - top === was.row && this._cursorLine === was.line && this._cursorCol === was.col) this.toggleMark();
    else this.cutAction = null;
  }

  private clickInPrompt(col: number): void {
    const prompt = this.promptView();
    if (prompt === null) return;
    this._promptCursor = promptCursorAtColumn(this.window.cols, prompt.label, prompt.answer, this._promptCursor, this.live.tabsize, col);
  }

  get softwrapEnabled(): boolean { return this.live.softwrap; }

  private searchPromptLabel(replacing: boolean): string {
    const replaceNote = replacing ? (this.markLine === null ? ' (to replace)' : ' (to replace) in selection') : '';
    return `Search${this.caseSensitive ? ' [Case Sensitive]' : ''}${this.useRegex ? ' [Regexp]' : ''}`
      + `${this.searchDir === 'backward' ? ' [Backwards]' : ''}${replaceNote}${this.searchDefaultText}`;
  }

  private searchDefaultNote(): string {
    if (this.lastSearchTerm === '') return '';
    const limit = Math.floor(this.window.cols / 3);
    const shown = displayString(this.lastSearchTerm, 0, limit, { isData: false, isPrompt: false, softwrap: false, tabsize: this.live.tabsize });
    return ` [${shown.cells.join('')}${breadth(this.lastSearchTerm, this.live.tabsize) > limit ? '...' : ''}]`;
  }

  private pauseWith(note: string, millis = PAUSE_MILLIS, keepsMenu = false): void {
    this.pauseNote = note;
    this.pauseMillis = millis;
    this.pauseKeepsMenu = keepsMenu;
  }

  private refuseWhenRestricted(): boolean {
    if (!this.live.restricted) return false;
    this._statusMessage = '[ This function is disabled in restricted mode ]';
    return true;
  }

  private discardEnabled(): boolean {
    return this.menuFlags.saveonexit && !this.menuFlags.preserve;
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
    return `File to insert${this.live.noconvert ? ' unconverted' : ''} [from ${this.operating?.root ?? './'}]`;
  }

  private saveInPlace(): void {
    if (this.titleName === '') {
      this.beginWriteOut(false);
      return;
    }
    this.exitAfterSave = false;
    this.writeMethod = 'overwrite';
    this.writeBuffer(this.titleName, this.writeTarget(this.titleName), false, false);
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

  private promptAnswer(): { get: () => string; set: (value: string) => void; history: string[] | null; files: boolean } | null {
    switch (this._mode) {
      case 'save-prompt': return { get: () => this.saveFileNameBuffer, set: (v) => { this.saveFileNameBuffer = v; }, history: null, files: true };
      case 'read-file-prompt': return { get: () => this.readFileBuffer, set: (v) => { this.readFileBuffer = v; }, history: null, files: true };
      case 'search':
      case 'replace-search': return { get: () => this.searchAnswer, set: (v) => { this.searchAnswer = v; }, history: this.searchHistory, files: false };
      case 'replace-with': return { get: () => this.replaceWithBuffer, set: (v) => { this.replaceWithBuffer = v; }, history: this.replaceHistory, files: false };
      case 'execute-prompt': return { get: () => this.executeCmdBuffer, set: (v) => { this.executeCmdBuffer = v; }, history: this.executeHistory, files: false };
      default: return null;
    }
  }

  private completeWithTab(): boolean {
    const field = this.promptAnswer();
    if (field === null) return false;
    this.tabPressedThisKey = true;
    if (field.history !== null) {
      this.completeFromHistory(field.history, field.get, field.set);
      return true;
    }
    if (this.live.restricted) return true;
    const answer = field.get();
    if (this._promptCursor < answer.length) return true;
    const completion = completeFileName(this.fs, answer, (fullName) => this.operating === null || !this.operating.outside(fullName, true));
    if (this.listedCompletions !== null && (completion === null || completion.list === null)) this.listedCompletions = null;
    if (completion === null) return true;
    if (completion.answer !== answer) {
      field.set(completion.answer);
      this._promptCursor = completion.answer.length;
    }
    if (completion.list !== null) {
      this.listedCompletions = completion.list;
      this.listedIn = this._mode;
    }
    return true;
  }

  private completeFromHistory(history: string[], get: () => string, set: (value: string) => void): void {
    if (this.tabFragmentLength === null) this.tabFragmentLength = get().length;
    if (this.tabFragmentLength > 0) {
      const next = nextHistoryCompletion(history, this.historyPosition ?? this.tabPointers.get(history) ?? history.length, get(), this.tabFragmentLength);
      if (next !== null) {
        this.historyPosition = next.position;
        this.tabPointers.set(history, next.position);
        set(next.text);
      }
    }
    this._promptCursor = get().length;
  }

  private activeMenu(prompt: { menu: NanoMenuName } | null = this.promptView()): NanoMenuName {
    if (this.helpTitle !== null) return prompt === null ? 'help' : 'search-in-help';
    return prompt === null ? 'main' : prompt.menu;
  }

  private menuOptions(): MenuOptions {
    return { restricted: this.live.restricted, discard: this.discardEnabled(), view: this.settings.view, preserve: this.menuFlags.preserve };
  }

  private promptView(): { label: string; answer: string; menu: NanoMenuName } | null {
    switch (this._mode) {
      case 'save-prompt': return { label: this.writeOutLabel(), answer: this.saveFileNameBuffer, menu: 'write-out' };
      case 'search': return { label: this.searchPromptLabel(false), answer: this.searchAnswer, menu: 'search' };
      case 'replace-search': return { label: this.searchPromptLabel(true), answer: this.searchAnswer, menu: 'replace' };
      case 'replace-with': return { label: 'Replace with', answer: this.replaceWithBuffer, menu: 'replace-with' };
      case 'goto-line': return { label: 'Enter line number, column number', answer: this.gotoLineBuffer, menu: 'goto' };
      case 'execute-prompt': return { label: 'Command to execute', answer: this.executeCmdBuffer, menu: 'execute' };
      case 'read-file-prompt': return { label: this.readFileLabel(), answer: this.readFileBuffer, menu: 'read-file' };
      default: return null;
    }
  }

  get screen(): EditorScreen {
    if (this.helpViewer !== null) return this.helpViewer.screen;
    const live = this.paintScreen(false);
    if (this.pauseNote !== null) return { ...live, hold: { millis: this.pauseMillis, then: this.paintScreen(true) } };
    const level = messageLevel(this.statusText);
    const transient = this.bareDisplay() && level > MESSAGE_LEVEL.hush && level < MESSAGE_LEVEL.alert && level !== MESSAGE_LEVEL.info;
    if (!transient || this.isPrompting()) return live;
    return { ...live, hold: { millis: 1500, then: this.paintScreen(true) } };
  }

  private interfacePaints() {
    return resolveInterfacePaints(this.live.colors, this.live.boldtext, (this.fs.environmentVariable?.('NO_COLOR') ?? null) !== null);
  }

  private minibarMode(): boolean {
    return this.live.minibar && !this.live.zero && this.window.rows > 1;
  }

  private zeroMode(): boolean {
    return this.live.zero && this.window.rows > 1;
  }

  private bareDisplay(): boolean {
    return this.helpTitle === null && (this.minibarMode() || this.zeroMode());
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
      spotlight: this._pendingReplaceMatch === null ? this.searchSpotlight : { line: this._pendingReplaceMatch.line, start: this._pendingReplaceMatch.start, end: this._pendingReplaceMatch.end },
      tabsize: this.live.tabsize,
      softwrap: this.live.softwrap,
      emphasis: this.live.boldtext ? 'bold' : 'reverse',
      paints: this.interfacePaints(),
      syntax: this.syntaxPainting(),
      stripe: this.live.guidestripe,
      title: {
        name: this.titleName === '' ? 'New Buffer' : this.titleName,
        state: this._readOnly ? 'View' : this._modified ? 'Modified' : this.live.restricted ? 'Restricted' : '',
        branding: 'GNU nano 7.2',
        flags: this.live.stateflags ? { letters: this.stateLetters(), modified: this._modified } : null,
        heading: this.helpTitle ?? undefined,
      },
      status: message === '' ? null : { text: message, alert: this.statusAlert, more: this.statusMore, raw: this.statusRaw },
      minibar: this.minibarInfo(messageExpired),
      prompt: prompt === null ? null : { label: prompt.label, answer: prompt.answer, cursor: this._promptCursor },
      yesNo: this._mode === 'exit-save-prompt'
        ? { question: 'Save modified buffer? ', withAll: false }
        : this._mode === 'confirm' ? { question: this.confirmationQuestion(), withAll: false }
        : this._mode === 'replace-confirm' ? { question: 'Replace this instance?', withAll: true } : null,
      completions: this.listedCompletions === null ? null : { names: this.listedCompletions, hiddenRows: this.live.zero && this.window.rows > 1 ? 1 : 0 },
      menu: this.activeMenu(prompt),
      menuOptions: this.menuOptions(),
      pause: messageExpired ? null : this.pauseNote,
      pauseKeepsMenu: this.pauseKeepsMenu,
    });
    if (this.staleFooter !== null && this._mode === 'edit' && this.statusText === '') {
      const rows = [...screen.rows];
      rows[this.window.layout.statusRow] = this.staleFooter;
      return { ...screen, rows };
    }
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
    return (this.live.autoindent ? 'I' : ' ') + (this.markLine !== null && !this.markFlagHidden ? 'M' : ' ')
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
    this.staleFooter = null;
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
    this.helpViewer?.resize(rows, cols);
    if (this.sized && (rows !== this.window.rows || cols !== this.window.cols)) {
      this.wipeStatus();
      this.markFlagHidden = false;
      this.searchSpotlight = null;
    }
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

  scrollView(forward: boolean, count: number): void {
    if (this.live.mouse) this.wheelAt(this.window.layout.editFrom, 0, forward);
    else this.scrollLines(forward, count);
  }

  private scrollLines(forward: boolean, count: number): void {
    for (let i = 0; i < count; i++) this.scrollRow(forward);
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
    if (k.key === 'Tab' && !k.ctrl && !k.alt && !k.shift && this.completeWithTab()) return;
    switch (this._mode) {
      case 'edit': return this.helpTitle === null ? this.applyEditKey(k) : this.applyHelpViewerKey(k);
      case 'save-prompt': return this.applySavePromptKey(k);
      case 'exit-save-prompt': return this.applyExitSavePromptKey(k);
      case 'confirm': return this.applyConfirmKey(k);
      case 'search': return this.applySearchKey(k);
      case 'replace-search': return this.applySearchKey(k);
      case 'replace-with': return this.applyReplaceWithKey(k);
      case 'replace-confirm': return this.applyReplaceConfirmKey(k);
      case 'goto-line': return this.applyGotoLineKey(k);
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
      case 'replace-search':
        this.insertIntoPromptField(() => this.searchAnswer, (v) => { this.searchAnswer = v; }, firstLine);
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
  private redrawsOnlyChangedLines = false;

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

  private refuseInViewMode(): void {
    this._statusMessage = '[ Key is invalid in view mode ]';
    this.verticalKey = true;
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
      this.refuseInViewMode();
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
        const tab = this.activeSyntax?.tab ?? (this.live.tabstospaces
          ? ' '.repeat(this.live.tabsize - (wideness(cur, this._cursorCol, this.live.tabsize) % this.live.tabsize))
          : '\t');
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
    if (k.key === 'ArrowUp') { this.toPreviousBlock(); return; }
    if (k.key === 'ArrowDown') { this.toNextBlock(); return; }
    const key = k.key.toLowerCase();
    if (key === 'h' && this._cursorLine === 0 && this._cursorCol === 0 && !this.live.nohelp && !this._readOnly && this.markLine === null && !this.metaKeyUsed) {
      this._statusMessage = '[ ^W = Ctrl+W    M-W = Alt+W ]';
      return;
    }
    const motion = CONTROL_MOTIONS[key];
    if (motion) { this.applyEditKey({ ...k, key: motion, ctrl: false }); return; }
    if (key === 'r' && this.refuseWhenRestricted()) return;
    // View mode (-v): no Write Out, Cut, Paste, Replace, Justify, Read
    // File or Execute Command — real nano has none of these bound while
    // read-only, since every one of them would mutate the buffer.
    if (this._readOnly && (key === 'o' || key === 's' || key === 'k' || key === 'u' || key === '\\'
      || key === 'j' || key === 'r' || key === 't')) {
      this.refuseInViewMode();
      return;
    }
    switch (key) {
      case 'o':
        this.beginWriteOut(false);
        return;
      case 's':
        this.saveInPlace();
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
        this.beginSearchPrompt(false);
        return;
      case '\\': // Replace
        this.beginReplacePrompt();
        return;
      case 'q':
        this.beginSearchPrompt(true);
        return;
      case 'g': // Get Help
        this.openHelp('main');
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
        this.resetHistoryRecall();
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
      this._cursorCol = this.helpTitle !== null ? 0 : this.line(last).length;
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
  private jumpWordLeft(): void {
    this.manner = 'flowing';
    const spot = previousWordSpot(this.linesArr, { line: this._cursorLine, col: this._cursorCol }, (character) => isWordChar(character, this.live.wordbounds, this.live.wordchars));
    this._cursorLine = spot.line;
    this._cursorCol = spot.col;
  }

  private jumpWordRight(): void {
    this.manner = 'flowing';
    const spot = nextWordSpot(this.linesArr, { line: this._cursorLine, col: this._cursorCol }, (character) => isWordChar(character, this.live.wordbounds, this.live.wordchars), this.live.afterends);
    this._cursorLine = spot.line;
    this._cursorCol = spot.col;
  }

  private applyEditAltKey(k: EditorKeyInput): void {
    const key = k.key.toLowerCase();
    if (k.key === 'ArrowUp') { this.manner = 'flowing'; this.scrollLines(false, 1); return; }
    if (k.key === 'ArrowDown') { this.manner = 'flowing'; this.scrollLines(true, 1); return; }
    if (key === 'z') { this.toggleHiddenInterface(); return; }
    if (key === 'y') { this.toggleSyntax(); return; }
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
      if (this._readOnly) { this.refuseInViewMode(); return; }
      if (k.key === '}') this.indentLines(); else this.unindentLines();
      return;
    }
    if (key === 'j') {
      if (this._readOnly) { this.refuseInViewMode(); return; }
      this.justifyText(true);
      return;
    }
    if (key === 't' || (k.key === '3' && !k.shift)) {
      if (this._readOnly) { this.refuseInViewMode(); return; }
      if (key === 't') this.cutTillEnd(); else this.commentLines();
      return;
    }
    const toggle = EDIT_TOGGLES[key];
    if (toggle !== undefined) {
      if (toggle.flag === 'tabstospaces' && this.activeSyntax?.tab != null) {
        this._statusMessage = '[ Current syntax determines Tab ]';
        return;
      }
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
      this.toFirstLine();
      return;
    }
    if (k.key === '/') { // Last Line
      this.toLastLine();
      return;
    }
    if (k.key === '(' || k.key === '9') { this.toParagraphBegin(); return; }
    if (k.key === ')' || k.key === '0') { this.toParagraphEnd(); return; }
    if (k.key === '7') { this.toPreviousBlock(); return; }
    if (k.key === '8') { this.toNextBlock(); return; }
    if (key === 'r') {
      this.beginReplacePrompt();
      return;
    }
    if (key === 'b') {
      this._statusMessage = '[ No linter is defined for this type of file ]';
      return;
    }
    if (key === 'f') {
      this._statusMessage = '[ No formatter is defined for this type of file ]';
      return;
    }
    if (key === 'w') {
      this.wipeStatus();
      this.researchWith(false);
      return;
    }
    if (key === 'q') {
      this.wipeStatus();
      this.researchWith(true);
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

  private toFirstLine(): void {
    this._cursorLine = 0;
    this._cursorCol = 0;
  }

  private toLastLine(): void {
    this.manner = 'flowing';
    this._cursorLine = this.linesArr.length - 1;
    this._cursorCol = this.helpTitle !== null ? 0 : this.line(this._cursorLine).length;
  }

  private toParagraphBegin(): void {
    this._cursorLine = paragraphStart(this.linesArr, this._cursorLine, this.justifyContext());
    this._cursorCol = 0;
  }

  private toParagraphEnd(): void {
    const end = paragraphEnd(this.linesArr, this._cursorLine, this.justifyContext());
    if (end < this.linesArr.length - 1) {
      this._cursorLine = end + 1;
      this._cursorCol = 0;
    } else {
      this._cursorLine = end;
      this._cursorCol = this.line(end).length;
    }
  }

  private toPreviousBlock(): void {
    this._cursorLine = previousBlockLine(this.linesArr, this._cursorLine);
    this._cursorCol = 0;
  }

  private toNextBlock(): void {
    this._cursorLine = nextBlockLine(this.linesArr, this._cursorLine);
    this._cursorCol = 0;
  }

  // ── Mark / region (^6, M-A, M-6) ─────────────────────────────────

  private toggleMark(): void {
    this.verticalKey = true;
    this.markFlagHidden = false;
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
      if (index === this._cursorLine && this._cursorCol > 0) {
        this._cursorCol += unit.length;
        this.placeWant = this.window.columnOf(this._cursorLine, this._cursorCol);
      }
    }
    this.verticalKey = true;
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
    const sequence = this.activeSyntax?.comment ?? GENERAL_COMMENT;
    if (sequence === '') {
      this._statusMessage = '[ Commenting is not supported for this file type ]';
      return;
    }
    const bar = sequence.indexOf('|');
    const prefix = bar < 0 ? sequence : sequence.slice(0, bar);
    const suffix = bar < 0 ? '' : sequence.slice(bar + 1);
    const range = this.markedLineRange();
    const last = this.linesArr.length - 1;
    if (range.top === range.bottom && range.bottom === last && !this.live.nonewlines) {
      this._statusMessage = '[ Cannot comment past end of file ]';
      return;
    }
    const commentable = (index: number): boolean => this.live.nonewlines || index !== last;
    const isCommented = (text: string): boolean => text.startsWith(prefix) && (suffix === '' || text.endsWith(suffix));
    let action: 'COMMENT' | 'UNCOMMENT' = 'UNCOMMENT';
    let allEmpty = true;
    for (let index = range.top; index <= range.bottom; index++) {
      const empty = [...this.line(index)].every((ch) => isBlankChar(ch));
      if (!empty && !(commentable(index) && isCommented(this.line(index)))) {
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
        this.linesArr[index] = prefix + text + suffix;
        if (index === this.markLine && (this.markCol ?? 0) > 0) this.markCol = (this.markCol ?? 0) + prefix.length;
        if (index === this._cursorLine && this._cursorCol > 0) {
          this._cursorCol += prefix.length;
          this.placeWant = this.window.columnOf(this._cursorLine, this._cursorCol);
        }
      } else if (isCommented(text)) {
        this.linesArr[index] = text.slice(prefix.length, text.length - suffix.length);
        if (index === this.markLine) this.markCol = Math.max(0, (this.markCol ?? 0) - prefix.length);
        if (index === this._cursorLine) {
          this._cursorCol = Math.max(0, this._cursorCol - prefix.length);
          this.placeWant = this.window.columnOf(this._cursorLine, this._cursorCol);
        }
      }
    }
    this.verticalKey = true;
    this.undoFinish();
    this._modified = true;
  }

  private indentLines(): void {
    const range = this.markedLineRange();
    let top = range.top;
    while (top <= range.bottom && this.line(top) === '') top++;
    if (top > range.bottom) {
      this.verticalKey = true;
      return;
    }
    this.undoBegin('INDENT');
    this.shiftLinesRight(top, range.bottom, this.activeSyntax?.tab ?? (this.live.tabstospaces ? ' '.repeat(this.live.tabsize) : '\t'));
    this.undoFinish();
    this._modified = true;
  }

  private unindentLines(): void {
    const range = this.markedLineRange();
    let top = range.top;
    while (top <= range.bottom && whiteLength(this.line(top), this.live.tabsize) === 0) top++;
    if (top > range.bottom) {
      this.verticalKey = true;
      return;
    }
    this.undoBegin('UNINDENT');
    for (let index = top; index <= range.bottom; index++) {
      const removed = whiteLength(this.line(index), this.live.tabsize);
      if (removed === 0) continue;
      this.linesArr[index] = this.line(index).slice(removed);
      if (index === this.markLine) this.markCol = Math.max(0, (this.markCol ?? 0) - removed);
      if (index === this._cursorLine) {
        this._cursorCol = Math.max(0, this._cursorCol - removed);
        this.placeWant = this.window.columnOf(this._cursorLine, this._cursorCol);
      }
    }
    this.verticalKey = true;
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
    if (k.ctrl && !k.alt && (k.key === 'ArrowLeft' || k.key === 'ArrowRight')) {
      const isWord = (character: string | undefined): boolean => isWordChar(character, false, this.live.wordchars);
      const from = { line: 0, col: this._promptCursor };
      this._promptCursor = (k.key === 'ArrowLeft' ? previousWordSpot([text], from, isWord) : nextWordSpot([text], from, isWord, this.live.afterends)).col;
      return true;
    }
    const motion = k.ctrl && !k.alt ? CONTROL_MOTIONS[k.key.toLowerCase()] : undefined;
    const name = motion ?? k.key;
    if (name === 'ArrowLeft') { this._promptCursor = Math.max(0, this._promptCursor - 1); return true; }
    if (name === 'ArrowRight') { this._promptCursor = Math.min(text.length, this._promptCursor + 1); return true; }
    if (name === 'Home') { this._promptCursor = 0; return true; }
    if (name === 'End') { this._promptCursor = text.length; return true; }
    if (name === 'Delete') {
      if (this._promptCursor < text.length) set(text.slice(0, this._promptCursor) + text.slice(this._promptCursor + 1));
      return true;
    }
    if (name === 'Backspace') {
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
    return this._mode !== 'edit';
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
    if (this.operating?.outside(name)) {
      this.exitAfterSave = false;
      this._mode = 'edit';
      this._statusMessage = `[ ${this.operating.writeRefusal()} ]`;
      return;
    }
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
    this.selectSyntax();
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
    if (k.ctrl && !k.alt && this.jumpFromGotoPrompt(k.key.toLowerCase())) return;
    this.applyPromptFieldKey(k, () => this.gotoLineBuffer, (v) => { this.gotoLineBuffer = v; });
  }

  private jumpFromGotoPrompt(key: string): boolean {
    if (key === 't' || key === '_') {
      this.searchDefaultText = this.searchDefaultNote();
      this.searchAnswer = this.gotoLineBuffer;
      this.searchDir = 'forward';
      this._promptCursor = Math.min(this._promptCursor, this.searchAnswer.length);
      this._mode = 'search';
      this.resetHistoryRecall();
      return true;
    }
    if (key !== 'y' && key !== 'v' && key !== 'w' && key !== 'o') return false;
    this._mode = 'edit';
    if (key === 'y') this.toFirstLine();
    else if (key === 'v') this.toLastLine();
    else {
      if (key === 'w') this.toParagraphBegin(); else this.toParagraphEnd();
      this.redrawsOnlyChangedLines = true;
    }
    return true;
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
    if (parsed.line !== null) this.manner = 'recentering';
  }

  private applyStart(start: NanoStart): boolean {
    if (start.caseSensitive !== null) this.caseSensitive = start.caseSensitive;
    if (start.regex !== null) this.useRegex = start.regex;
    let positioned = false;
    if (start.line !== 0 || start.column !== 0) {
      this.gotoLineNumbers(start.line, start.column);
      this.startPlacement = 'hugfloor';
      positioned = true;
    } else if (start.search !== null) {
      this.searchAtStartup(start.search);
      this.startPlacement = 'centering';
      positioned = true;
    }
    if (start.alerts.length === 0) return positioned;
    this._statusMessage = `[ ${start.alerts[0]} ]`;
    this.statusMore = start.alerts.length + (this.openingAlerted ? 1 : 0) > 1;
    return positioned;
  }

  private searchAtStartup(request: NanoSearchRequest): void {
    this.searchDir = request.backwards ? 'backward' : 'forward';
    this.lastSearchTerm = request.pattern;
    const pattern = this.compileSearch(request.pattern);
    if (pattern === null) return;
    const circuit = new SearchCircuit(pattern, request.backwards);
    const hit = this.findNext(pattern, 'JUSTFIND', false, { line: 0, col: 0 }, circuit);
    if (hit === null) this.reportNotFound(request.pattern);
    else if (messageLevel(this.statusText) <= MESSAGE_LEVEL.remark) this.wipeStatus();
  }

  private gotoLineNumbers(line: number | null, column: number): void {
    const last = this.linesArr.length;
    const wanted = line === null ? this._cursorLine + 1 : line < 0 ? last + line + 1 : line === 0 ? 1 : line;
    const target = Math.min(Math.max(1, wanted), last) - 1;
    const text = this.line(target);
    const displayColumn = column < 0
      ? wideness(text, text.length, this.live.tabsize) + column + 2
      : column === 0 ? this.placeWant + 1 : column;
    this._cursorLine = target;
    this._cursorCol = actualX(text, Math.max(0, displayColumn - 1), this.live.tabsize);
    this.verticalKey = true;
    this.placeWant = displayColumn - 1;
  }

  // ── Help (^G) ────────────────────────────────────────────────────

  private helpMenuOfPrompt(): HelpMenu | null {
    switch (this._mode) {
      case 'search': return 'search';
      case 'replace-search': return 'replace';
      case 'replace-with': return 'replace-with';
      case 'goto-line': return 'goto';
      case 'save-prompt': return 'write';
      case 'read-file-prompt': return 'insert';
      case 'execute-prompt': return 'execute';
      default: return null;
    }
  }

  private openHelp(menu: HelpMenu): void {
    const rows = this.window.rows;
    const cols = this.window.cols;
    const page = helpPage(
      menu,
      { restricted: this.live.restricted, preserve: this.menuFlags.preserve, saveonexit: this.menuFlags.saveonexit, view: this._readOnly },
      { columns: cols, rows, leadingBlank: (this.live.minibar || !this.live.emptyline) && rows > 6, sidebar: this.window.sidebar },
    );
    const settings = defaultNanoSettings({
      ...this.live,
      tabsize: 8,
      linenumbers: false,
      nohelp: false,
      zero: false,
      view: false,
      restricted: false,
      rebinddelete: false,
      operatingdir: null,
      nonewlines: true,
      locking: false,
      constantshow: false,
      stateflags: false,
      guidestripe: null,
    });
    const tiny = this.footerKeepsStaleText();
    const viewer = new NanoEngine(this.fs, '', page.lines.join('\n'), false, false, undefined, false, {
      identity: this.launchIdentity,
      settings,
      menuFlags: this.menuFlags,
      helpTitle: page.title,
      staleFooter: tiny ? this.paintScreen(false).rows[this.window.layout.statusRow] : undefined,
    });
    viewer.lastSearchTerm = this.lastSearchTerm;
    viewer.searchHistory = this.searchHistory;
    viewer.replaceHistory = this.replaceHistory;
    viewer.tabPointers = this.tabPointers;
    viewer.resize(rows, cols);
    this.helpViewer = viewer;
    this.wipeStatus();
  }

  private footerKeepsStaleText(): boolean {
    return this.window.layout.barsFrom === null && this.window.rows > 1 && !this.live.nohelp && !this.live.zero;
  }

  private keyInHelp(k: EditorKeyInput): void {
    this.helpViewer!.applyKey(k);
    this.settleHelpViewer();
  }

  private settleHelpViewer(): void {
    const viewer = this.helpViewer!;
    if (!viewer.exited) return;
    const footer = viewer.screen.rows[this.window.layout.statusRow];
    this.lastSearchTerm = viewer.lastSearchTerm;
    if (viewer.historyChanged) this.historyChanged = true;
    this.helpViewer = null;
    this.wipeStatus();
    if (this.footerKeepsStaleText()) this.staleFooter = footer;
    if (this.reportsPositionAsMessage() && this._mode === 'edit') this._statusMessage = this.locationMessage();
  }

  private applyHelpViewerKey(k: EditorKeyInput): void {
    const cursorMotion = this.live.showcursor ? helpCursorMotion(k) : null;
    if (cursorMotion !== null) {
      this.applyEditKey(cursorMotion);
      return;
    }
    const action = helpAction(k, this.menuFlags.preserve);
    switch (action) {
      case 'scroll-up':
        this.scrollLines(false, 1);
        return;
      case 'scroll-down':
        if (this.window.edittop + this.window.editRows - 1 < this.linesArr.length - 1) this.scrollLines(true, 1);
        return;
      case 'page-up':
        this.pageUp();
        return;
      case 'page-down':
        this.pageDown();
        return;
      case 'first-line':
        this.toFirstLine();
        return;
      case 'last-line':
        this.toLastLine();
        return;
      case 'search-forward':
        this.beginSearchPrompt(false);
        return;
      case 'search-backward':
        this.beginSearchPrompt(true);
        return;
      case 'find-next':
        this.wipeStatus();
        this.researchWith(false);
        return;
      case 'find-previous':
        this.wipeStatus();
        this.researchWith(true);
        return;
      case 'refresh':
        return;
      case 'exit':
        this._exited = true;
        return;
      default:
        this._statusMessage = `[ ${unboundKeyMessage(k)} ]`;
        this.statusCountdown = 1;
    }
  }

  // ── Execute Command (^T) — insert a shell command's output ───────

  private applyExecutePromptKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      this.runExecuteCommand();
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this.resetHistoryRecall();
      this.cancelPrompt();
      return;
    }
    if (k.alt && k.key === '\\') {
      this.togglePipeMark();
      return;
    }
    if (k.ctrl && !k.alt && this.runExecuteShortcut(k.key.toLowerCase())) return;
    if (this.recallHistory(k, this.executeHistory, () => this.executeCmdBuffer, (v) => { this.executeCmdBuffer = v; })) return;
    this.applyPromptFieldKey(k, () => this.executeCmdBuffer, (v) => { this.executeCmdBuffer = v; });
  }

  private togglePipeMark(): void {
    const piped = this.executeCmdBuffer.startsWith('|');
    this.executeCmdBuffer = piped ? this.executeCmdBuffer.slice(1) : `|${this.executeCmdBuffer}`;
    this._promptCursor = piped ? Math.max(0, this._promptCursor - 1) : this._promptCursor + 1;
  }

  private runExecuteShortcut(key: string): boolean {
    if (key === 'x') {
      this.resetHistoryRecall();
      this.readFileBuffer = this.executeCmdBuffer;
      this._promptCursor = Math.min(this._promptCursor, this.readFileBuffer.length);
      this._mode = 'read-file-prompt';
      return true;
    }
    if (key !== 's' && key !== 't' && key !== 'y' && key !== 'o' && key !== 'j' && key !== 'v') return false;
    this.resetHistoryRecall();
    this._mode = 'edit';
    if (key === 's' || key === 't') this._statusMessage = '[ Error invoking "spell" ]';
    else if (key === 'y') this._statusMessage = '[ No linter is defined for this type of file ]';
    else if (key === 'o') this._statusMessage = '[ No formatter is defined for this type of file ]';
    else if (key === 'j') this.justifyText(true);
    else this.cutTillEnd();
    return true;
  }

  private runChildShell(command: string, stdin?: string): ChildShellRun {
    return this.fs.runChildShell?.(command, stdin)
      ?? { output: stdin === undefined ? this.fs.runShellCommand(command) : this.fs.filterThroughShell(command, stdin), status: 0 };
  }

  private reportCommandFailure(output: string): void {
    const lines = output.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const last = lines[lines.length - 1] ?? '';
    const cut = last.indexOf(': ');
    this._statusMessage = `[ Error: ${cut < 0 ? '---' : last.slice(cut + 2)} ]`;
    if (this.undo.modified) this._modified = true;
    this.clearMark();
  }

  private runExecuteCommand(): void {
    const command = this.executeCmdBuffer;
    this.resetHistoryRecall();
    this._mode = 'edit';
    if (command === '') {
      this.cancelPrompt();
      return;
    }
    this.rememberInHistory(this.executeHistory, command);
    if (command.startsWith('|')) this.pipeThroughCommand(command.slice(1));
    else this.insertCommandOutput(command);
    if (this.minibarMode()) this.reportSizePending = true;
  }

  private insertCommandOutput(command: string): void {
    const run = this.runChildShell(command);
    if (run.status !== 0) {
      this.reportCommandFailure(run.output);
      return;
    }
    this.insertDecoded(decodeFile(run.output, !this.live.noconvert, false));
  }

  private pipeThroughCommand(command: string): void {
    const region = this.getMarkedRegion();
    const text = region === null ? this.linesArr.join('\n') : this.extractRegionText(region);
    const run = this.runChildShell(command, text);
    if (run.status !== 0) {
      this.reportCommandFailure('');
      return;
    }
    const decoded = decodeFile(run.output, !this.live.noconvert, false);
    const wasLine = this._cursorLine;
    this.undoBegin('FILTER');
    if (region === null) {
      this.linesArr = [''];
      this._cursorLine = 0;
      this._cursorCol = 0;
      this.insertText(decoded.lines.join('\n'));
      this.ensureTrailingBlankLine();
      this._cursorLine = Math.min(wasLine, this.linesArr.length - 1);
      this._cursorCol = 0;
    } else {
      this.excise(region);
      this.insertText(decoded.lines.join('\n'));
      this.ensureTrailingBlankLine();
      this.manner = 'flowing';
    }
    this.clearMark();
    this.undoFinish();
    this._modified = true;
    if (this.minibarMode()) this.reportSizePending = true;
    this._statusMessage = `[ Read ${decoded.count} line${decoded.count === 1 ? '' : 's'} ]`;
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
    if (k.ctrl && !k.alt && k.key.toLowerCase() === 'x' && !this.live.restricted) {
      this.executeCmdBuffer = this.readFileBuffer;
      this._promptCursor = Math.min(this._promptCursor, this.executeCmdBuffer.length);
      this._mode = 'execute-prompt';
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
    return writeFailureReason(this.fs, name, target);
  }

  private pathKind(path: string): EditorPathKind {
    return this.fs.kindOf?.(path) ?? (this.fs.exists(path) ? 'file' : 'missing');
  }

  private insertFileNamed(name: string): void {
    if (this.operating?.outside(name)) {
      this._statusMessage = `[ ${this.operating.readRefusal()} ]`;
      return;
    }
    const kind = this.pathKind(name);
    if (kind === 'missing') {
      this._statusMessage = `[ File "${name}" not found ]`;
      return;
    }
    if (kind !== 'file') {
      this._statusMessage = `[ "${name}" is ${kind === 'directory' ? 'a directory' : kind === 'device' ? 'a device file' : 'a FIFO'} ]`;
      return;
    }
    this.insertDecoded(decodeFile(this.fs.readFile(name) ?? '', !this.live.noconvert, false));
  }

  private insertDecoded(decoded: DecodedFile): void {
    const was = { line: this._cursorLine, col: this._cursorCol };
    const wasScreenful = this.screenfulMark();
    this.undoBegin('INSERT');
    this.insertText(decoded.lines.join('\n'));
    this.undoFinish();
    if (this.lessThanScreenful(wasScreenful)) this.manner = 'flowing';
    if (this._cursorLine !== was.line || this._cursorCol !== was.col) this._modified = true;
    if (this.minibarMode()) this.reportSizePending = true;
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
      punctuation: this.live.punct ?? DEFAULT_PUNCTUATION,
      brackets: this.live.brackets ?? DEFAULT_BRACKETS,
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
      piece[0] = squeeze(piece[0], primaryLead.length, context.punctuation, context.brackets);
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
    const key = k.key.toLowerCase();
    const inHelp = this.helpTitle !== null;
    if (k.alt && (key === 'c' || key === 'r' || key === 'b')) {
      if (inHelp) return;
      if (key === 'c') this.caseSensitive = !this.caseSensitive;
      else if (key === 'r') this.useRegex = !this.useRegex;
      else this.searchDir = this.searchDir === 'forward' ? 'backward' : 'forward';
      this.resetHistoryRecall();
      return;
    }
    if (k.ctrl && key === 'r') {
      if (inHelp) return;
      this.resetHistoryRecall();
      if (this._readOnly) this.pauseWith('Key is invalid in view mode', VIEW_WARNING_MILLIS, true);
      else this._mode = this._mode === 'search' ? 'replace-search' : 'search';
      return;
    }
    if (k.ctrl && (key === 't' || key === '_') && this._mode === 'search' && !inHelp) {
      this.resetHistoryRecall();
      this.gotoLineBuffer = this.searchAnswer;
      this._promptCursor = Math.min(this._promptCursor, this.gotoLineBuffer.length);
      this._mode = 'goto-line';
      return;
    }
    if (k.ctrl && (key === 'y' || key === 'v') && this._mode === 'search') {
      this.resetHistoryRecall();
      this._mode = 'edit';
      if (key === 'y') this.toFirstLine(); else this.toLastLine();
      return;
    }
    if (k.key === 'Enter') {
      this.submitSearch();
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && key === 'c')) {
      this.resetHistoryRecall();
      this.cancelPrompt();
      return;
    }
    if (this.recallHistory(k, this.searchHistory, () => this.searchAnswer, (value) => { this.searchAnswer = value; })) return;
    this.applyPromptFieldKey(k, () => this.searchAnswer, (value) => { this.searchAnswer = value; });
  }

  private beginSearchPrompt(backwards: boolean): void {
    this.searchDefaultText = this.searchDefaultNote();
    this.searchAnswer = '';
    this.searchDir = backwards ? 'backward' : 'forward';
    this._promptCursor = 0;
    this._mode = 'search';
    this.resetHistoryRecall();
  }

  private beginReplacePrompt(): void {
    if (this._readOnly) {
      this.refuseInViewMode();
      return;
    }
    this.searchDefaultText = this.searchDefaultNote();
    this.searchAnswer = '';
    this.searchDir = 'forward';
    this._promptCursor = 0;
    this._mode = 'replace-search';
    this.resetHistoryRecall();
  }

  private resetHistoryRecall(): void {
    if (this.historyStash !== null && this.historyInUse !== null) this.tabPointers.delete(this.historyInUse);
    this.historyPosition = null;
    this.historyStash = null;
    this.historyInUse = null;
  }

  private recallHistory(k: EditorKeyInput, history: string[], get: () => string, set: (value: string) => void): boolean {
    const plainArrow = !k.ctrl && !k.alt;
    const older = (plainArrow && k.key === 'ArrowUp') || (k.ctrl && !k.alt && k.key.toLowerCase() === 'p');
    const newer = (plainArrow && k.key === 'ArrowDown') || (k.ctrl && !k.alt && k.key.toLowerCase() === 'n');
    if (!older && !newer) return false;
    let replaced = false;
    const replace = (value: string): void => {
      set(value);
      replaced = true;
    };
    if (older) {
      if (this.historyStash === null) this.historyPosition = history.length;
      if (this.historyPosition === history.length) this.historyStash = get();
      this.historyInUse = history;
      if (this.historyPosition !== null && this.historyPosition > 0) {
        this.historyPosition--;
        replace(history[this.historyPosition]);
      }
    } else {
      if (this.historyPosition !== null && this.historyPosition < history.length) {
        this.historyPosition++;
        replace(this.historyPosition === history.length ? '' : history[this.historyPosition]);
      }
      if (this.historyPosition === history.length && this.historyStash !== null && get() === '') replace(this.historyStash);
    }
    if (replaced) this._promptCursor = get().length;
    return true;
  }

  private rememberInHistory(history: string[], text: string): void {
    appendToHistory(history, text, true);
    this.historyChanged = true;
    this.tabPointers.delete(history);
  }

  private searchStyle(): SearchStyle {
    return { caseSensitive: this.caseSensitive, regex: this.useRegex, backwards: this.searchDir === 'backward' };
  }

  private compileSearch(needle: string): SearchPattern | null {
    try {
      return new SearchPattern(needle, this.searchStyle());
    } catch (error) {
      if (!(error instanceof PosixRegexError)) throw error;
      this._statusMessage = `[ Bad regex "${needle}": ${error.message} ]`;
      return null;
    }
  }

  private submitSearch(): void {
    const replacing = this._mode === 'replace-search';
    this.resetHistoryRecall();
    this._mode = 'edit';
    if (this.searchAnswer === '' && this.lastSearchTerm === '') {
      this._statusMessage = 'Cancelled';
      return;
    }
    if (this.searchAnswer !== '') {
      this.lastSearchTerm = this.searchAnswer;
      this.rememberInHistory(this.searchHistory, this.searchAnswer);
    }
    const pattern = this.compileSearch(this.lastSearchTerm);
    if (pattern === null) return;
    if (replacing) this.askForReplacement(pattern);
    else this.goLooking(pattern);
  }

  private findNext(pattern: SearchPattern, modus: SearchModus, skipOne: boolean, begin: SearchSpot, circuit: SearchCircuit): SearchHit | null {
    const hit = circuit.next({
      lines: this.linesArr,
      modus,
      from: { line: this._cursorLine, col: this._cursorCol },
      skipOne,
      begin,
    });
    if (hit === null) return null;
    this._cursorLine = hit.line;
    this._cursorCol = hit.col;
    return hit;
  }

  private goLooking(pattern: SearchPattern): void {
    const wasLine = this._cursorLine;
    const wasCol = this._cursorCol;
    const circuit = new SearchCircuit(pattern, this.searchDir === 'backward');
    const hit = this.findNext(pattern, 'JUSTFIND', true, { line: wasLine, col: wasCol }, circuit);
    if (hit === null) {
      this.reportNotFound(pattern.needle);
      return;
    }
    if (this.markLine === null) this.searchSpotlight = { line: hit.line, start: hit.col, end: hit.col + hit.length };
    if (hit.line === wasLine && hit.col === wasCol) this._statusMessage = '[ This is the only occurrence ]';
    else if (hit.wrapped) this._statusMessage = '[ Search Wrapped ]';
  }

  private researchWith(backwards: boolean): void {
    this.searchDir = backwards ? 'backward' : 'forward';
    if (this.lastSearchTerm === '' && this.searchHistory.length > 0) this.lastSearchTerm = this.searchHistory[this.searchHistory.length - 1];
    if (this.lastSearchTerm === '') {
      this._statusMessage = '[ No current search pattern ]';
      return;
    }
    const pattern = this.compileSearch(this.lastSearchTerm);
    if (pattern !== null) this.goLooking(pattern);
  }

  private askForReplacement(pattern: SearchPattern): void {
    this.replaceOrigin = {
      pattern,
      line: this._cursorLine,
      col: this._cursorCol,
      edittop: this.window.edittop,
      firstcolumn: this.window.firstcolumn,
    };
    this.replaceWithBuffer = '';
    this._promptCursor = 0;
    this._mode = 'replace-with';
  }

  private applyReplaceWithKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      this.resetHistoryRecall();
      if (this.replaceWithBuffer !== '') this.rememberInHistory(this.replaceHistory, this.replaceWithBuffer);
      this.startReplaceRun();
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this.resetHistoryRecall();
      this.replaceOrigin = null;
      this.cancelPrompt();
      return;
    }
    if (this.recallHistory(k, this.replaceHistory, () => this.replaceWithBuffer, (value) => { this.replaceWithBuffer = value; })) return;
    this.applyPromptFieldKey(k, () => this.replaceWithBuffer, (value) => { this.replaceWithBuffer = value; });
  }

  private startReplaceRun(): void {
    const origin = this.replaceOrigin!;
    this.replaceOrigin = null;
    const pattern = this.lastSearchTerm === origin.pattern.needle ? origin.pattern : this.compileSearch(this.lastSearchTerm) ?? origin.pattern;
    const backwards = this.searchDir === 'backward';
    const marked = this.markLine !== null;
    const run: ReplaceRun = {
      pattern,
      replacement: this.replaceWithBuffer,
      backwards,
      circuit: new SearchCircuit(pattern, backwards),
      begin: { line: origin.line, col: origin.col },
      edittop: origin.edittop,
      firstcolumn: origin.firstcolumn,
      modus: 'REPLACING',
      skipOne: backwards,
      replaceAll: false,
      replaced: -1,
      region: null,
      mark: null,
      markIsBeforeCursor: false,
    };
    if (marked) {
      const region = this.getMarkedRegion()!;
      run.region = { topLine: region.startLine, topCol: region.startCol, botLine: region.endLine, botCol: region.endCol };
      run.mark = { line: this.markLine!, col: this.markCol! };
      run.markIsBeforeCursor = this.markLine! < this._cursorLine || (this.markLine === this._cursorLine && this.markCol! < this._cursorCol);
      run.modus = 'INREGION';
      this._cursorLine = backwards ? region.endLine : region.startLine;
      this._cursorCol = backwards ? region.endCol : region.startCol;
    }
    this.replaceRun = run;
    this.continueReplace();
  }

  private continueReplace(): void {
    const run = this.replaceRun!;
    for (;;) {
      const hit = this.findNext(run.pattern, run.modus, run.skipOne, run.begin, run.circuit);
      if (hit === null) break;
      const region = run.region;
      if (region !== null && (hit.line > region.botLine || hit.line < region.topLine
        || (hit.line === region.botLine && hit.col + hit.length > region.botCol)
        || (hit.line === region.topLine && hit.col < region.topCol))) break;
      if (run.replaced === -1) run.replaced = 0;
      if (!run.replaceAll) {
        const text = this.linesArr[hit.line];
        this.pendingHit = hit;
        this._pendingReplaceMatch = { line: hit.line, start: hit.col, end: hit.col + hit.length, matchText: text.slice(hit.col, hit.col + hit.length) };
        this._mode = 'replace-confirm';
        return;
      }
      this.replaceHit(hit);
    }
    this.finishReplace();
  }

  private applyReplaceConfirmKey(k: EditorKeyInput): void {
    const given = yesNoAnswer(k, true);
    if (given === null) return;
    const run = this.replaceRun!;
    const hit = this.pendingHit!;
    this.pendingHit = null;
    this._pendingReplaceMatch = null;
    this._mode = 'edit';
    if (given === 'cancel') {
      this.finishReplace();
      return;
    }
    run.replaceAll = given === 'all';
    run.skipOne = given === 'no' || run.backwards;
    if (given === 'yes' || run.replaceAll) this.replaceHit(hit);
    this.continueReplace();
  }

  private replaceHit(hit: SearchHit): void {
    const run = this.replaceRun!;
    const text = this.linesArr[hit.line];
    const replacement = run.pattern.isRegex
      ? expandReplacement(run.replacement, text, { index: hit.col, length: hit.length, groups: hit.groups }, run.pattern.groupCount)
      : run.replacement;
    const altered = text.slice(0, hit.col) + replacement + text.slice(hit.col + hit.length);
    const lengthChange = altered.length - text.length;
    this.undo.begin('REPLACE', this.linesArr, { line: hit.line, col: hit.col }, this.window.cursorRow);
    const region = run.region;
    if (run.mark !== null && !run.markIsBeforeCursor) {
      if (hit.line === run.mark.line && run.mark.col > hit.col) {
        run.mark.col = run.mark.col < hit.col + hit.length ? hit.col : run.mark.col + lengthChange;
        region!.botCol = run.mark.col;
      }
    }
    if (run.mark === null || run.markIsBeforeCursor) {
      if (hit.line === run.begin.line && hit.col < run.begin.col) {
        if (run.begin.col < hit.col + hit.length) run.begin.col = hit.col + hit.length;
        run.begin.col += lengthChange;
        if (region !== null) region.botCol = run.begin.col;
      }
    }
    if (hit.length === 0 || (run.pattern.needle[0] === '^' && run.pattern.isRegex)) run.skipOne = true;
    this._cursorCol = run.backwards ? hit.col : hit.col + hit.length + lengthChange;
    this._cursorLine = hit.line;
    this.linesArr[hit.line] = altered;
    this.undo.finish({ line: hit.line, col: hit.col });
    const firstModification = !this.modifiedState;
    this._modified = true;
    if (firstModification && run.mark !== null) this.markFlagHidden = true;
    run.replaced++;
  }

  private finishReplace(): void {
    const run = this.replaceRun!;
    this.replaceRun = null;
    this._mode = 'edit';
    if (run.replaced === -1) this.reportNotFound(run.pattern.needle);
    this.window.edittop = Math.min(run.edittop, this.linesArr.length - 1);
    this.window.firstcolumn = run.firstcolumn;
    this._cursorLine = Math.min(run.begin.line, this.linesArr.length - 1);
    this._cursorCol = Math.min(run.begin.col, this.line(this._cursorLine).length);
    if (run.replaced >= 0) this._statusMessage = `Replaced ${run.replaced} occurrence${run.replaced === 1 ? '' : 's'}`;
  }

  // ── Exit bookkeeping ─────────────────────────────────────────────

  private finishExit(saved: boolean): void {
    this._exited = true;
    this._savedOnExit = saved;
    this.dropLock();
    if (this.helpTitle !== null) return;
    this.recordLoggedPosition();
    this.saveHistoryLists();
  }

  get exitNotice(): string {
    return this.exitNotices.map((notice) => `${notice}\n`).join('');
  }

  private openStateFiles(): void {
    if (this.helpTitle !== null || !(this.live.historylog || this.live.positionlog)) return;
    const state = resolveStateDirectory(this.fs);
    this.exitNotices.push(...state.errors);
    if (state.errors.length > 0) this.startupProblem ??= STARTUP_PROBLEM;
    if (state.path === null) {
      this.live.historylog = false;
      this.live.positionlog = false;
      return;
    }
    this.stateDirectory = state.path;
    if (this.live.historylog) this.loadHistoryLists(`${state.path}${SEARCH_HISTORY_FILE}`);
    if (this.live.positionlog) this.refuseUnreadable(this.positionFile(), () => { this.live.positionlog = false; });
  }

  private loadHistoryLists(file: string): void {
    if (!this.refuseUnreadable(file, () => { this.live.historylog = false; })) return;
    const lists = parseHistoryLists(this.fs.readFile(file) ?? '');
    this.searchHistory = lists.search;
    this.replaceHistory = lists.replace;
    this.executeHistory = lists.execute;
  }

  private refuseUnreadable(file: string, giveUp: () => void): boolean {
    const failure = this.fs.readError?.(file) ?? null;
    if (failure === null) return true;
    this.exitNotices.push(`Error reading ${file}: ${failure}`);
    this.startupProblem ??= STARTUP_PROBLEM;
    giveUp();
    return false;
  }

  private positionFile(): string {
    return `${this.stateDirectory}${POSITION_HISTORY_FILE}`;
  }

  private restoreLoggedPosition(typedName: string): void {
    if (!this.live.positionlog || this.stateDirectory === null) return;
    const fullPath = fullPathOf(typedName, this.fs);
    if (fullPath === null) return;
    const entry = findPosition(parsePositionHistory(this.fs.readFile(this.positionFile()) ?? ''), fullPath);
    if (entry === null) return;
    this.gotoLineNumbers(entry.line, entry.column);
    this.startPlacement = 'hugfloor';
  }

  private recordLoggedPosition(): void {
    if (!this.live.positionlog || this.stateDirectory === null || this.titleName === '') return;
    const fullPath = fullPathOf(this.titleName, this.fs);
    if (fullPath === null) return;
    const file = this.positionFile();
    const entries = parsePositionHistory(this.fs.readFile(file) ?? '');
    const atDefault = this._cursorLine === 0 && this._cursorCol === 0;
    const column = this.window.columnOf(this._cursorLine, this._cursorCol) + 1;
    const updated = withPositionRecorded(entries, fullPath, this._cursorLine + 1, column, atDefault);
    if (updated !== null) this.writeStateFile(file, serializePositionHistory(updated));
  }

  private saveHistoryLists(): void {
    if (!this.live.historylog || !this.historyChanged || this.stateDirectory === null) return;
    this.writeStateFile(`${this.stateDirectory}${SEARCH_HISTORY_FILE}`, serializeHistoryLists({
      search: this.searchHistory, replace: this.replaceHistory, execute: this.executeHistory,
    }));
  }

  private writeStateFile(path: string, content: string): void {
    if (this.fs.writeFile(path, content)) this.fs.changeMode?.(path, 0o600);
    else this.exitNotices.push(`Error writing ${path}: ${this.writeFailureReason(path, path)}`);
  }
}
