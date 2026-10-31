import { VimLineStore } from './vim/VimLineStore';
import { simulationNowMs } from '@/network/core/SystemClock';

import type { EditorFsContext } from './EditorFsContext';
import type { EditorKeyInput } from './EditorKeyInput';
import { dotSwapPathFor } from './editorPaths';
import { MAXCOL, byteOffset, charCells, charLengthAt, charStartBefore, colAtByte, colAtVcol, cursorVcol, firstNonBlank, isWhite, type FindState, type MotionBuffer } from './vim/VimCursor';
import { findMatchingBracket, parseMatchPairs, runMotion } from './vim/VimMotions';
import { parseListChars, type ListSpec } from './vim/VimCells';
import { VimWindow, type WindowSettings } from './vim/VimWindow';
import { buildScreen } from './vim/VimScreen';
import type { ViewState } from './vim/VimWindow';
import type { EditorScreen, ScreenStyle } from './screen/EditorScreen';
import { textObject } from './vim/VimTextObjects';
import { BufferText, compileVimPattern, type MultiMatch } from './vim/VimPattern';
import {
  expandTilde, freshSubstituteMemory, joinedCursorColumn, parseSubstitute, runSubstitution, substitutionMessage,
  type AskAnswer, type AskStep, type LineTracker, type SubstituteMemory, type SubstituteRun,
} from './vim/VimSubstitute';
import { patternHasUppercase, skipRegexp, type PatternContext } from './vim/VimRegex';
import {
  NO_OFFSET, findCurrentMatch, findMatch, highlightSpans, identUnderCursor, matchesEverything, parseSearchInput, patternForIdent, resolveTarget, searchPatternError, stepBack, stepForward,
  type HighlightSpan, type LastSearch,
} from './vim/VimSearch';
import { DEFAULT_WORD_CLASSES, wordClasses, type WordClasses } from './vim/VimCharClass';
import { backspaceTarget, indentString, indentWidth, insertTab, joinText, reindentLine, removeChars, roundedIndent, shiftLine, sliceChars, softBackspace, swapCase, tabSpaces } from './vim/VimEditing';
import { VimOptions } from './vim/VimOptions';
import { parseRange, type RangeEnvironment } from './vim/VimExRange';
import { evaluateReplacementExpression, executeLetCommand, type ExpressionHost, executeUnletCommand, VimVariables } from './vim/VimExpression';

function normalKeyOf(character: string): EditorKeyInput {
  const code = character.charCodeAt(0);
  if (character === '\x1b') return { key: 'Escape' };
  if (character === '\r') return { key: 'Enter' };
  if (code < 32) return { key: String.fromCharCode(code + 96), ctrl: true };
  return { key: character };
}

export type VimMode = 'normal' | 'insert' | 'command' | 'search' | 'confirm-substitute' | 'ask-swap-range' | 'visual' | 'visual-line' | 'visual-block' | 'swap-recovery' | 'binary-warning';
export type VimVariant = 'vim' | 'vi';

interface UndoSnapshot {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

export interface PendingSwapRecovery {
  swapPath: string;
  filePath: string;
  ownedBySameUser: boolean;
  swapOwner: string;
}

interface SwapMeta {
  owner: string;
  filePath: string;
  lines: string[];
}

function serializeSwapMeta(meta: SwapMeta): string {
  return JSON.stringify(meta);
}

function parseSwapMeta(raw: string): SwapMeta | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.owner === 'string' && Array.isArray(parsed.lines)) return parsed as SwapMeta;
    return null;
  } catch {
    return null;
  }
}

interface SubstitutionState {
  readonly generator: Generator<AskStep, void, AskAnswer>;
  readonly run: SubstituteRun;
  readonly startSubstitutions: number;
  readonly oldCursor: { line: number; col: number };
  readonly usedPattern: string;
  readonly nextCommand: string | null;
  readonly savedAll: boolean;
  readonly savedAsk: boolean;
  readonly keptCursorColumn: boolean;
}

interface GlobalRun {
  marks: number[];
  readonly command: string;
  readonly oldLineCount: number;
  needBeginline: boolean;
  readonly tracker: LineTracker;
}

export interface PendingSubstMatch {
  line: number;
  start: number;
  end: number;
  matchText: string;
  replacementPreview: string;
}

/** Find the quote pair (same open/close char) a text object should act on: the pair enclosing `col`, or the next one forward on the line. */
function findQuotePair(line: string, col: number, quoteChar: string): { start: number; end: number } | null {
  const positions: number[] = [];
  for (let i = 0; i < line.length; i++) if (line[i] === quoteChar) positions.push(i);
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const start = positions[i];
    const end = positions[i + 1];
    if (col <= end) return { start, end };
  }
  return null;
}

/** Find the innermost matched bracket pair enclosing `col` on this line (nesting-aware). */
function findEnclosingBracketPair(line: string, col: number, open: string, close: string): { start: number; end: number } | null {
  const stack: number[] = [];
  let best: { start: number; end: number } | null = null;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === open && open !== close) {
      stack.push(i);
    } else if (line[i] === close) {
      const start = stack.pop();
      if (start === undefined) continue;
      if (start <= col && col <= i && (!best || i - start < best.end - best.start)) {
        best = { start, end: i };
      }
    }
  }
  return best;
}

function barOutsideExpression(text: string): number {
  let quote = '';
  for (let at = 0; at < text.length; at++) {
    const character = text[at];
    if (quote !== '') {
      if (character === quote) quote = '';
      else if (character === '\\' && quote === '"') at++;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '|') {
      if (text[at + 1] === '|') at++;
      else return at;
    }
  }
  return -1;
}

type Operator = 'd' | 'y' | 'c' | '<' | '>' | 'g~' | 'gu' | 'gU';

interface OperatorRange {
  start: { line: number; col: number };
  end: { line: number; col: number };
  type: 'char' | 'line';
  inclusive: boolean;
  noAdjustEnd?: boolean;
}

function isAbbreviation(word: string, full: string, shortest: number): boolean {
  return word.length >= shortest && full.startsWith(word);
}

const INC_COMMAND = /^(s(?:u(?:b(?:s(?:t(?:i(?:t(?:u(?:t(?:e)?)?)?)?)?)?)?)?)?|sm(?:a(?:g(?:i(?:c)?)?)?)?|sno(?:m(?:a(?:g(?:i(?:c)?)?)?)?)?|g(?:l(?:o(?:b(?:a(?:l)?)?)?)?)?|v(?:g(?:l(?:o(?:b(?:a(?:l)?)?)?)?)?)?)!?\s*([^\w\s"|\\])(.*)$/;

const SET_COMMAND = /^(se|set|setl|setlo|setloc|setloca|setlocal|setg|setgl|setglo|setglob|setgloba|setglobal)(?:\s+(.*))?$/;

function firstNonWhite(text: string): number {
  let col = 0;
  while (col < text.length && (text[col] === ' ' || text[col] === '\t')) col++;
  return col;
}

interface UnnamedRegister {
  linewise: boolean;
  lines: string[];
}

/**
 * Headless vim/vi engine. Owns the line buffer, cursor, mode state
 * machine (NORMAL / INSERT / COMMAND-LINE / SEARCH), and drives all
 * filesystem/shell side effects (main file, swap file, `:!cmd`) through
 * an injected EditorFsContext. No DOM/React dependency.
 *
 * `variant: 'vi'` enables POSIX-strict behaviour: no `gg` (a vim-only
 * extension — plain vi addresses lines with `NG`/`:N`), and no
 * `-- INSERT --` mode indicator (classic vi shows no mode line at all).
 */
interface ExRange {
  start: number | null;
  end: number | null;
  rest: string;
  literal: string;
  error?: string;
}

const LAYOUT_OPTIONS: ReadonlySet<string> = new Set([
  'number', 'relativenumber', 'numberwidth', 'list', 'listchars', 'hlsearch', 'colorcolumn', 'wrap', 'tabstop', 'scrolloff', 'sidescrolloff', 'display',
]);

interface IncSearchState {
  view: ViewState;
  readonly origin: { line: number; col: number };
  searchStart: { line: number; col: number };
  matchStart: { line: number; col: number };
  matchEnd: { line: number; col: number } | null;
  match: { start: { line: number; col: number }; end: { line: number; col: number } } | null;
  pattern: string | null;
  range: { first: number; last: number } | null;
  active: boolean;
}

const LITERAL_INSERT_CONTROLS: ReadonlySet<string> = new Set(['b', 'f', 'l', 's', 'z']);

export class VimEngine {
  private linesArr: VimLineStore;
  private _mode: VimMode = 'normal';
  private _cursorLine = 0;
  private _cursorCol = 0;
  private _modified = false;
  private _message: string;
  private _exited = false;
  private _savedOnExit = false;
  private commandBuffer = '';
  private searchBuffer = '';
  private searchDraftForward = true;
  private lastSearch: LastSearch | null = null;
  private noHlsearch = false;
  private jumpOrigin: { line: number; col: number } | null = null;
  private cmdlineColumn: { line: number; col: number } | null = null;
  private matchJump: { line: number; col: number } | null = null;
  private liveSearch: IncSearchState | null = null;
  private searchContext: { operator: Operator | null; count: number | undefined; returnMode: VimMode } | null = null;

  // Command-line history recall (Up/Down in `:` and `/`), scoped to this
  // editing session (no persistence across sessions, no viminfo). Both
  // prompts share the nav-index/stash fields since only one prompt is
  // ever open at a time.
  private commandHistoryList: string[] = [];
  private searchHistoryList: string[] = [];
  private historyNavIndex: number | null = null;
  private historyNavStash = '';
  private pendingOperator: Operator | null = null;
  private opCount: number | undefined;
  private replaceCount = 1;
  private insertRepeat = 1;
  private insertKind: 'i' | 'o' | 'O' = 'i';
  private insertedText = '';
  private insertUndoDepth = -1;
  private joinSpaces = true;
  private cmdKeys: EditorKeyInput[] = [];
  private commandChanged = false;
  private commandRepeatable = false;
  private commandBlocked = false;
  private mlEmpty = false;
  private replaceMode = false;
  private typedSpace = false;
  private lastInsertedChar = '';
  private autoIndentPending = false;
  private insertTouched = false;
  private insertStart = { line: 0, col: 0 };
  private lineUndoLine = -1;
  private lineUndoText = '';
  private lineUndoRunning = false;
  private replacedOriginals: (string | null)[] = [];
  private pendingCountStr = '';
  private pendingG = false;
  private pendingZ = false;
  private awaitingFindChar: 'f' | 'F' | 't' | 'T' | null = null;
  private lastFind: FindState | null = null;
  private want = -1;
  private explicitWant: number | null = null;
  private keepWantThisKey = false;
  readonly options: VimOptions;
  private readonly window: VimWindow;
  private listSpecCache: { spec: string; parsed: ListSpec } | null = null;
  private showcmdKeys = '';
  private swapPath: string;
  private orphanSwapPath: string | null = null;
  private _pendingSwapRecovery: PendingSwapRecovery | null = null;
  private recoveredLinesFromSwap: string[] = [];
  private originalDiskLines: string[] = [];
  private _readOnly = false;
  private readonly owner: string;
  private substituteMemory: SubstituteMemory = freshSubstituteMemory();
  private substitutePattern: string | null = null;
  private searchSlotPattern: string | null = null;
  private substitution: SubstitutionState | null = null;
  private globalRun: GlobalRun | null = null;
  private substitutionCount = 0;
  private substitutionLines = 0;
  private expressionError: string | null = null;
  private readonly lambdaCounter = { next: 1 };
  private readonly variables = new VimVariables();
  private wordClassesCache: WordClasses = DEFAULT_WORD_CLASSES;
  private _pendingMatch: PendingSubstMatch | null = null;
  private pendingBackwardsRange: string | null = null;

  // Undo/redo — one snapshot per logical change (an entire insert session
  // counts as one step, matching real vim).
  private undoStack: UndoSnapshot[] = [];
  private redoStack: UndoSnapshot[] = [];

  // `.` (repeat last change) — records the raw key sequence of the last
  // completed normal-mode change (including any insert session it opened)
  // and replays it verbatim, the same way real vim's dot-register works.
  private dotRecording: EditorKeyInput[] | null = null;
  private dotRepeat: EditorKeyInput[] = [];
  private isDotReplay = false;

  // VISUAL / VISUAL LINE / VISUAL BLOCK selection state.
  private visualAnchorLine = 0;
  private visualAnchorCol = 0;
  private lastVisualStart = 0;
  private lastVisualEnd = 0;
  private blockInsertContext: { lines: number[]; col: number; suffixLenAtStart: number; toEol?: boolean; appendPad?: boolean } | null = null;
  private visualObjectKind: 'i' | 'a' | null = null;
  private lastVisual: { anchor: { line: number; col: number }; cursor: { line: number; col: number }; mode: 'visual' | 'visual-line' | 'visual-block' } | null = null;

  private _shellOutput = '';

  // Named registers ("a-"z, "*, "+) plus the unnamed register kept at
  // key '"'. Macros live in a separate namespace (recorded key sequences,
  // not text) — real vim actually unifies the two, which we simplify.
  private registers: Map<string, UnnamedRegister> = new Map();
  private pendingRegister: string | null = null;
  private awaitingRegisterName = false;
  private awaitingReplaceChar = false;
  private macroRegisters: Map<string, EditorKeyInput[]> = new Map();
  private recordingMacro: { name: string; keys: EditorKeyInput[] } | null = null;
  private awaitingMacroName = false;
  private awaitingMacroPlayback = false;
  private lastMacroName: string | null = null;
  private isMacroReplay = false;
  private _registersOutput = '';

  // Marks (`m{a-z}`, `` `{mark} ``, `'{mark}`) and a minimal jumplist
  // scoped to mark-jumps only (not the full G/gg/search jumplist real vim
  // maintains) — see the scenario's test file docstring for the exact,
  // disclosed scope. Marks are NOT re-adjusted when lines are inserted or
  // removed elsewhere in the buffer (no jumplist/mark renumbering).
  private marks: Map<string, { line: number; col: number }> = new Map();
  private awaitingMarkSet = false;
  private awaitingMarkJumpExact = false;
  private awaitingMarkJumpLine = false;
  private lastJumpPosition: { line: number; col: number } | null = null;
  private operatorPendingMarkMode: 'exact' | 'line' | null = null;
  private _marksOutput = '';

  // Text objects (`iw`/`aw`, `i"`/`a(`/...) — only meaningful as an
  // operator's motion (real vim also allows them in VISUAL mode, e.g.
  // `viw`; not implemented here, a disclosed scope cut). Resolution is
  // single-line only, consistent with the rest of this engine's charwise
  // operator machinery (dw/d$/mark motions).
  private operatorPendingTextObjectKind: 'i' | 'a' | null = null;

  constructor(
    private readonly fs: EditorFsContext,
    public readonly filePath: string,
    initialContent: string,
    isNewFile: boolean,
    public readonly variant: VimVariant = 'vim',
    owner = 'user',
    /** `vim +LINE file` — 1-indexed, clamped to the buffer. */
    initialCursor?: { line: number },
      private readonly displayName: string = filePath,
  ) {
    this.options = new VimOptions(variant);
    this.options.onChange((name) => {
      if (LAYOUT_OPTIONS.has(name)) this.window.invalidateTop();
      if (name === 'hlsearch') this.noHlsearch = false;
    });
    this.window = new VimWindow({ lineCount: () => this.linesArr.length, lineAt: (i) => this.linesArr[i] ?? '' }, () => this.windowSettings());
    const detectedFormat = initialContent.includes('\r\n') ? 'dos' : 'unix';
    this.options.assign('fileformat', detectedFormat);
    this.options.assign('fileencoding', 'utf-8');
    this.options.assign('filetype', this.detectFiletype());
    this.options.assign('scroll', 11);
    const body = initialContent.endsWith('\n') ? initialContent.slice(0, -1) : initialContent;
    const rawLines = body.length === 0 && initialContent.length === 0 ? [''] : body.split('\n');
    this.linesArr = VimLineStore.of_lines(detectedFormat === 'dos'
      ? rawLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
      : rawLines);
    this.originalDiskLines = [...this.linesArr];
    this.owner = owner;
    this._message = filePath === ''
      ? ''
      : isNewFile
        ? `"${this.shownName}" [New]`
        : `"${this.shownName}" ${this.linesArr.length}L, ${new TextEncoder().encode(initialContent).length}B`;

    // A genuinely unnamed buffer (filePath === '', real vim's `vim` with
    // no argument) has no real file yet — resolving '' would collapse to
    // the cwd's own directory path — so no swap file is created until a
    // real name exists via `:w <name>`.
    if (filePath === '') {
      this.swapPath = '';
      if (initialCursor) this.gotoLine(initialCursor.line - 1);
      return;
    }
    const primarySwap = dotSwapPathFor(fs.resolvePath(filePath));
    if (this.fs.exists(primarySwap)) {
      const meta = parseSwapMeta(this.fs.readFile(primarySwap) ?? '');
      this._pendingSwapRecovery = {
        swapPath: primarySwap,
        filePath,
        ownedBySameUser: meta?.owner === owner,
        swapOwner: meta?.owner ?? 'unknown',
      };
      this.recoveredLinesFromSwap = meta?.lines ?? [];
      this._mode = 'swap-recovery';
      this.swapPath = '';
    } else {
      this.swapPath = primarySwap;
      this.fs.writeFile(this.swapPath, serializeSwapMeta({ owner, filePath, lines: this.linesArr }));
      // Real vim detects a NUL byte anywhere in the file and asks before
      // rendering it as text — takes priority over the swap check having
      // already been resolved (no competing swap, this is the next gate).
      if (!isNewFile && initialContent.includes('\0')) {
        this._mode = 'binary-warning';
      }
    }
    if (initialCursor) this.gotoLine(initialCursor.line - 1);
  }

  // ── Public state ─────────────────────────────────────────────────

  get content(): string { return this.linesArr.join('\n'); }
  get lines(): readonly string[] { return Array.from(this.linesArr); }
  get mode(): VimMode { return this._mode; }
  get cursorLine(): number { return this._cursorLine; }
  get cursorCol(): number { return this._cursorCol; }
  get modified(): boolean { return this._modified; }
  get message(): string { return this._message; }
  get exited(): boolean { return this._exited; }
  get savedOnExit(): boolean { return this._savedOnExit; }
  get commandLineText(): string { return this.commandBuffer; }
  get searchText(): string { return this.searchBuffer; }
  get swapFilePath(): string { return this.swapPath; }
  get swapFileExists(): boolean { return this.swapPath !== '' && this.fs.exists(this.swapPath); }
  get pendingSwapRecovery(): PendingSwapRecovery | null { return this._pendingSwapRecovery; }
  /** Real vim's binary-file gate: a NUL byte anywhere triggers a confirm
   *  before rendering the file as text, exactly like a real terminal would
   *  refuse to treat arbitrary binary data as a stream of characters. */
  get pendingBinaryWarning(): string | null {
    return this._mode === 'binary-warning' ? `"${this.shownName}" may be a binary file, see it anyway?` : null;
  }
  /** Set once a recovery/edit-anyway choice leaves the original .swp behind — real vim never auto-deletes it. */
  get orphanSwapFilePath(): string | null { return this.orphanSwapPath; }
  get isReadOnly(): boolean { return this._readOnly; }
  /** True while in insert mode AND the variant shows a mode indicator (vim, not strict vi). */
  get showsInsertIndicator(): boolean { return this._mode === 'insert' && this.variant === 'vim'; }
  get pendingSubstMatch(): PendingSubstMatch | null { return this._pendingMatch; }
  get isReplacing(): boolean { return this._mode === 'insert' && this.replaceMode; }
  get visualAnchor(): { line: number; col: number } { return { line: this.visualAnchorLine, col: this.visualAnchorCol }; }
  get lineNumbersShown(): boolean { return this.options.bool('number'); }
  get relativeNumbersShown(): boolean { return this.options.bool('relativenumber'); }
  get hlsearch(): boolean { return this.options.bool('hlsearch'); }
  get shellOutput(): string { return this._shellOutput; }
  get fileFormat(): 'unix' | 'dos' | 'mac' { return this.options.string('fileformat') as 'unix' | 'dos' | 'mac'; }
  get listMode(): boolean { return this.options.bool('list'); }
  get showMatch(): boolean { return this.options.bool('showmatch'); }
  get incSearch(): boolean { return this.options.bool('incsearch'); }
  get colorColumn(): number | null {
    const first = /^\d+/.exec(this.options.string('colorcolumn'));
    return first ? parseInt(first[0], 10) : null;
  }
  get autoindent(): boolean { return this.options.bool('autoindent'); }
  private get tabstop(): number { return this.options.tabstop; }
  private get shiftwidth(): number { return this.options.shiftwidth; }
  private get ctrlTab(): boolean {
    return this.options.bool('list') && parseListChars(this.options.string('listchars')).tab === null;
  }
  private vcolAt(text: string, col: number, normalMode = true): number {
    return cursorVcol(text, col, this.tabstop, normalMode && !this.options.bool('list'), this.ctrlTab);
  }
  private tabSettings(): { tabstop: number; softtabstop: number; expandtab: boolean; ctrlTab: boolean } {
    return { tabstop: this.tabstop, softtabstop: this.options.softtabstop, expandtab: this.options.expandtab, ctrlTab: this.ctrlTab };
  }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  /** Text register content, `null` if empty/unset. Named registers, the unnamed register ("), and "/. */
  registerText(name: string): string | null {
    const reg = this.registers.get(name);
    if (!reg || reg.lines.length === 0) return null;
    return reg.lines.join('\n');
  }
  get registerNames(): string[] { return [...this.registers.keys()]; }
  get isRecordingMacro(): boolean { return this.recordingMacro !== null; }
  get recordingMacroName(): string | null { return this.recordingMacro?.name ?? null; }
  macroKeyCount(name: string): number { return this.macroRegisters.get(name)?.length ?? 0; }
  get registersOutput(): string { return this._registersOutput; }
  get marksOutput(): string { return this._marksOutput; }

  private line(i: number): string { return this.linesArr[i] ?? ''; }
  private clampCol(lineIdx: number, col: number, insertEdge = false): number {
    const max = Math.max(0, this.line(lineIdx).length - (insertEdge ? 0 : 1));
    return Math.max(0, Math.min(col, max));
  }

  // ── Key dispatch ─────────────────────────────────────────────────

  applyKey(k: EditorKeyInput): void {
    this.matchJump = null;
    this.explicitWant = null;
    this.keepWantThisKey = false;
    this.applyKeyInner(k);
    this.followCursor();
    if (this.cmdlineColumn !== null && (this.cmdlineColumn.line !== this._cursorLine || this.cmdlineColumn.col !== this._cursorCol)) this.cmdlineColumn = null;
    this.updateWant();
    this.trackShowcmd(k);
  }

  private awaitingArgument(): boolean {
    return this.awaitingFindChar !== null || this.awaitingReplaceChar || this.awaitingRegisterName
      || this.awaitingMacroName || this.awaitingMacroPlayback || this.awaitingMarkSet
      || this.awaitingMarkJumpExact || this.awaitingMarkJumpLine;
  }

  private hasPendingCommand(): boolean {
    return this.pendingOperator !== null || this.pendingCountStr !== '' || this.pendingG || this.pendingZ
      || this.awaitingFindChar !== null || this.awaitingReplaceChar || this.awaitingRegisterName
      || this.awaitingMacroName || this.awaitingMacroPlayback || this.awaitingMarkSet
      || this.awaitingMarkJumpExact || this.awaitingMarkJumpLine
      || this.operatorPendingTextObjectKind !== null || this.operatorPendingMarkMode !== null;
  }

  private updateWant(): void {
    if (this.hasPendingCommand()) return;
    if (this._mode === 'insert' || this._mode === 'command' || this._mode === 'search') return;
    if (this.explicitWant !== null) { this.want = this.explicitWant; return; }
    if (this.keepWantThisKey) return;
    this.want = this.vcolAt(this.line(this._cursorLine), this._cursorCol);
  }

  private isIdle(): boolean {
    return this._mode === 'normal' && !this.hasPendingCommand();
  }

  private applyKeyInner(k: EditorKeyInput): void {
    if (this._exited) return;

    if (this.isDotReplay || this.isMacroReplay) { this.dispatchByMode(k); this.syncSwapFile(); return; }

    const idle = this.isIdle() || (this._mode === 'normal' && this.pendingCountStr !== '' && !this.pendingOperator && !this.pendingG && !this.pendingZ && !this.awaitingArgument());
    if (this._mode === 'normal' && k.key === '.' && !k.ctrl && idle) {
      this.replayDotRepeat();
      return;
    }

    if (this.recordingMacro !== null) {
      const closesRecording = this._mode === 'normal' && k.key === 'q' && !this.awaitingMacroName;
      if (!closesRecording) this.recordingMacro.keys.push(k);
    }

    if (this.isIdle()) {
      this.cmdKeys = [];
      this.commandChanged = false;
      this.commandRepeatable = false;
      this.commandBlocked = false;
    }
    this.cmdKeys.push(k);

    this.dispatchByMode(k);
    this.syncSwapFile();

    if (this._mode !== 'normal' && this._mode !== 'insert') this.commandBlocked = true;
    if (this.isIdle()) {
      if (this.commandChanged && !this.lineUndoRunning) this.trackLineUndo();
      this.lineUndoRunning = false;
      if (!this.commandBlocked && (this.commandChanged || this.commandRepeatable) && this.cmdKeys.length > 0) this.dotRepeat = [...this.cmdKeys];
      this.cmdKeys = [];
      this.commandChanged = false;
      this.commandRepeatable = false;
      this.commandBlocked = false;
    }
  }

  private dispatchByMode(k: EditorKeyInput): void {
    switch (this._mode) {
      case 'normal': return this.applyNormalKey(k);
      case 'insert': return this.applyInsertKey(k);
      case 'command': return this.applyCommandKey(k);
      case 'search': return this.applySearchKey(k);
      case 'confirm-substitute': return this.applyConfirmSubstKey(k);
      case 'ask-swap-range': return this.applySwapRangeKey(k);
      case 'visual': case 'visual-line': case 'visual-block': return this.applyVisualKey(k);
      case 'swap-recovery': return this.applySwapRecoveryKey(k);
      case 'binary-warning': return this.applyBinaryWarningKey(k);
    }
  }

  private applyBinaryWarningKey(k: EditorKeyInput): void {
    const key = k.key.toLowerCase();
    if (key === 'y' || k.key === 'Enter') {
      this._mode = 'normal';
      this._message = `"${this.shownName}" [noeol] ${this.linesArr.length}L, binary`;
      return;
    }
    if (key === 'n' || k.key === 'Escape') {
      if (this.swapPath !== '') { this.fs.deleteFile(this.swapPath); this.swapPath = ''; }
      this._exited = true;
      this._savedOnExit = false;
      return;
    }
  }

  /** Keep the swap file's recorded content live so an abrupt kill can be recovered from. */
  private syncSwapFile(): void {
    if (this._exited || this.swapPath === '') return;
    this.fs.writeFile(this.swapPath, serializeSwapMeta({ owner: this.owner, filePath: this.filePath, lines: this.linesArr }));
  }

  private applySwapRecoveryKey(k: EditorKeyInput): void {
    const key = k.key.toLowerCase();
    const info = this._pendingSwapRecovery;
    if (!info) return;

    if (key === 'r' && info.ownedBySameUser) {
      this.linesArr = VimLineStore.of_lines(this.recoveredLinesFromSwap.length > 0 ? this.recoveredLinesFromSwap : ['']);
      this._modified = true;
      this.orphanSwapPath = info.swapPath;
      this.swapPath = this.pickAvailableSwapPath();
      this.syncSwapFile();
      this._message = `"${info.swapPath}" E325: recovered — check the buffer, then delete the swap file when you're done`;
      this._pendingSwapRecovery = null;
      this._mode = 'normal';
      return;
    }
    if (key === 'e') {
      this.linesArr = VimLineStore.of_lines(this.originalDiskLines);
      this.orphanSwapPath = info.swapPath;
      this.swapPath = this.pickAvailableSwapPath();
      this.syncSwapFile();
      this._message = '';
      this._pendingSwapRecovery = null;
      this._mode = 'normal';
      return;
    }
    if (key === 'o') {
      this.linesArr = VimLineStore.of_lines(this.originalDiskLines);
      this._readOnly = true;
      this.swapPath = ''; // read-only sessions don't lock the file
      this._message = '';
      this._pendingSwapRecovery = null;
      this._mode = 'normal';
      return;
    }
    if (key === 'q' || key === 'a') {
      this._pendingSwapRecovery = null;
      this._exited = true;
      this._savedOnExit = false;
      // No swap was created by this (aborted) session, and the existing
      // one — belonging to whichever session is still using the file —
      // is left completely untouched.
      return;
    }
  }

  /** Real vim's actual suffix sequence when `.swp` is taken: .swo, .swn, .swm, ... .swa. */
  private pickAvailableSwapPath(): string {
    const abs = this.fs.resolvePath(this.filePath);
    const idx = abs.lastIndexOf('/');
    const dir = idx >= 0 ? abs.slice(0, idx) : '';
    const base = idx >= 0 ? abs.slice(idx + 1) : abs;
    for (const letter of 'ponmlkjihgfedcba') {
      const candidate = `${dir}/.${base}.sw${letter}`;
      if (!this.fs.exists(candidate)) return candidate;
    }
    return `${dir}/.${base}.sw${simulationNowMs()}`;
  }

  private replayDotRepeat(): void {
    if (this.dotRepeat.length === 0) { this.pendingCountStr = ''; return; }
    let keys = this.dotRepeat;
    if (this.pendingCountStr !== '') {
      let skip = 0;
      while (skip < keys.length && /^[0-9]$/.test(keys[skip].key) && !(keys[skip].key === '0' && skip === 0)) skip++;
      const digits = [...this.pendingCountStr].map((d) => ({ key: d, ctrl: false, shift: false, alt: false }));
      keys = [...digits, ...keys.slice(skip)];
      this.pendingCountStr = '';
    }
    this.isDotReplay = true;
    for (const key of keys) this.applyKey(key);
    this.isDotReplay = false;
  }

  private replayMacro(name: string, count: number): void {
    const keys = this.macroRegisters.get(name);
    if (!keys || keys.length === 0) return;
    this.isMacroReplay = true;
    for (let i = 0; i < count; i++) {
      for (const k of keys) this.applyKey(k);
    }
    this.isMacroReplay = false;
  }

  private setRegister(reg: UnnamedRegister): void {
    const name = this.pendingRegister;
    this.pendingRegister = null;
    if (name) {
      this.registers.set(name, reg);
    } else {
      this.registers.set('"', reg);
    }
  }

  private activeRegister(): UnnamedRegister | undefined {
    const name = this.pendingRegister;
    this.pendingRegister = null;
    return name ? this.registers.get(name) : this.registers.get('"');
  }

  // ── Undo/redo ────────────────────────────────────────────────────

  private pushUndoSnapshot(): void {
    this.undoStack.push({ lines: [...this.linesArr], cursorLine: this._cursorLine, cursorCol: this._cursorCol });
    this.redoStack = [];
    this.commandChanged = true;
  }

  private restoreSnapshot(snap: UndoSnapshot): void {
    const current = this.linesArr;
    const target = snap.lines;
    let prefix = 0;
    while (prefix < current.length && prefix < target.length && current[prefix] === target[prefix]) prefix++;
    let suffix = 0;
    while (suffix < current.length - prefix && suffix < target.length - prefix
      && current[current.length - 1 - suffix] === target[target.length - 1 - suffix]) suffix++;
    const newSize = target.length - prefix - suffix;
    this.linesArr = VimLineStore.of_lines(target);
    const saved = snap.cursorLine;
    let line: number;
    let col: number;
    const unchanged = prefix === current.length && prefix === target.length;
    if (unchanged || (saved >= prefix - 1 && saved <= prefix + newSize)) {
      line = saved;
      col = snap.cursorCol;
    } else {
      line = prefix;
      col = -1;
    }
    if (line >= this.linesArr.length) { line = this.linesArr.length - 1; col = 0; }
    this._cursorLine = Math.max(0, line);
    this._cursorCol = col < 0 ? firstNonBlank(this.line(this._cursorLine)) : this.clampCol(this._cursorLine, col);
    this._modified = true;
    this._message = '';
  }

  private trackLineUndo(): void {
    const before = this.undoStack[this.undoStack.length - 1]?.lines;
    if (!before) return;
    if (before.length !== this.linesArr.length) { this.lineUndoLine = -1; return; }
    let changed = -1;
    for (let i = 0; i < before.length; i++) {
      if (before[i] === this.linesArr[i]) continue;
      if (changed >= 0) { this.lineUndoLine = -1; return; }
      changed = i;
    }
    if (changed >= 0 && changed !== this.lineUndoLine) {
      this.lineUndoLine = changed;
      this.lineUndoText = before[changed];
    }
  }

  private undoLine(): void {
    if (this.lineUndoLine < 0 || this.lineUndoLine >= this.linesArr.length) return;
    this.pushUndoSnapshot();
    const current = this.line(this.lineUndoLine);
    this.setLine(this.lineUndoLine, this.lineUndoText);
    this.lineUndoText = current;
    this._cursorLine = this.lineUndoLine;
    this._cursorCol = 0;
    this._modified = true;
    this.lineUndoRunning = true;
  }

  private performUndo(): void {
    const snap = this.undoStack.pop();
    if (!snap) { this._message = 'Already at oldest change'; return; }
    this.redoStack.push({ lines: [...this.linesArr], cursorLine: snap.cursorLine, cursorCol: snap.cursorCol });
    this.restoreSnapshot(snap);
  }

  private performRedo(): void {
    const snap = this.redoStack.pop();
    if (!snap) { this._message = 'Already at newest change'; return; }
    this.undoStack.push({ lines: [...this.linesArr], cursorLine: snap.cursorLine, cursorCol: snap.cursorCol });
    this.restoreSnapshot(snap);
  }

  // ── NORMAL mode ──────────────────────────────────────────────────

  private takeCount(): number | undefined {
    const has = this.pendingCountStr !== '';
    const n = has ? parseInt(this.pendingCountStr, 10) : undefined;
    this.pendingCountStr = '';
    return n;
  }

  private effectiveCount(): number | undefined {
    const motion = this.takeCount();
    const before = this.opCount;
    if (before === undefined) return motion;
    if (motion === undefined) return before;
    return before * motion;
  }

  private applyNormalKey(k: EditorKeyInput): void {
    const key = k.key;

    if (this.awaitingRegisterName) {
      this.awaitingRegisterName = false;
      if (/^[a-zA-Z0-9"*+\-]$/.test(key)) this.pendingRegister = key;
      return;
    }
    if (key === '"' && !this.pendingOperator) { this.awaitingRegisterName = true; return; }

    if (this.awaitingReplaceChar) {
      this.awaitingReplaceChar = false;
      this.replaceCharacters(k);
      return;
    }
    if (key === 'r' && !k.ctrl && !this.pendingOperator) {
      this.replaceCount = this.takeCount() ?? 1;
      this.awaitingReplaceChar = true;
      return;
    }

    if (this.awaitingMacroName) {
      this.awaitingMacroName = false;
      if (/^[a-z]$/.test(key)) {
        this.recordingMacro = { name: key, keys: [] };
        this._message = '';
      }
      return;
    }
    if (this.awaitingMacroPlayback) {
      this.awaitingMacroPlayback = false;
      const name = key === '@' ? this.lastMacroName : (/^[a-z]$/.test(key) ? key : null);
      const count = this.takeCount() ?? 1;
      if (name) { this.lastMacroName = name; this.replayMacro(name, count); }
      return;
    }
    if (key === '@' && !this.pendingOperator) { this.awaitingMacroPlayback = true; return; }

    if (this.awaitingMarkSet) {
      this.awaitingMarkSet = false;
      if (/^[a-z]$/.test(key)) this.marks.set(key, { line: this._cursorLine, col: this._cursorCol });
      return;
    }
    if (this.awaitingMarkJumpExact) {
      this.awaitingMarkJumpExact = false;
      this.jumpToMark(key, false);
      return;
    }
    if (this.awaitingMarkJumpLine) {
      this.awaitingMarkJumpLine = false;
      this.jumpToMark(key, true);
      return;
    }
    if (key === 'q' && !this.pendingOperator) {
      if (this.recordingMacro) {
        this.macroRegisters.set(this.recordingMacro.name, this.recordingMacro.keys);
        this.recordingMacro = null;
      } else {
        this.awaitingMacroName = true;
      }
      return;
    }

    if (k.ctrl && !this.pendingOperator) {
      const lower = key.toLowerCase();
      if (lower === 'r') { const n = this.takeCount() ?? 1; for (let i = 0; i < n; i++) this.performRedo(); return; }
      if (lower === 'f') { this.pageScroll(true); return; }
      if (lower === 'b') { this.pageScroll(false); return; }
      if (lower === 'd') { this.halfPageScroll(true); return; }
      if (lower === 'u') { this.halfPageScroll(false); return; }
      if (lower === 'e') { this.lineScroll(true); return; }
      if (lower === 'y') { this.lineScroll(false); return; }
      if (lower === 'v') { this.pendingCountStr = ''; this.enterVisual('visual-block'); return; }
      if (lower === 'a' || lower === 'x') { this.incrementNumber(lower === 'a' ? 1 : -1); return; }
    }

    if (/^[0-9]$/.test(key) && !(key === '0' && this.pendingCountStr === '') && !this.awaitingFindChar) {
      this.pendingCountStr += key;
      return;
    }

    if ((key === 'PageDown' || key === 'PageUp') && !k.ctrl && !this.pendingOperator && !this.awaitingArgument()) {
      this.pageScroll(key === 'PageDown');
      return;
    }

    if (this.pendingZ) {
      this.pendingZ = false;
      this.runZCommand(key);
      return;
    }

    if (this.pendingG) {
      this.pendingG = false;
      if (this.pendingOperator) { this.applyOperatorGKey(key); return; }
      if (!this.tryGCommand(key)) this.pendingCountStr = '';
      return;
    }

    if (this.pendingOperator) { this.applyOperatorKey(k); return; }

    if (this.awaitingFindChar) { this.tryMotion(key, k); return; }

    if (!k.ctrl && this.tryMotion(key, k)) return;

    switch (key) {
      case 'g':
        this.pendingG = true;
        return;
      case 'z':
        this.pendingZ = true;
        return;
      case 'i': case 'a': case 'A': case 'I': case 'o': case 'O':
        this.beginInsert(key);
        return;
      case 'R':
        this.beginInsert('i');
        this.replaceMode = true;
        this.replacedOriginals = [];
        this._message = this.variant === 'vim' ? '-- REPLACE --' : '';
        return;
      case 'x': this.operatorShortcut('d', 'l'); return;
      case 'X': this.operatorShortcut('d', 'h'); return;
      case 'D': this.operatorShortcut('d', '$'); return;
      case 'C': this.operatorShortcut('c', '$'); return;
      case 's': this.operatorShortcut('c', 'l'); return;
      case 'S': this.operatorShortcut('c', 'c'); return;
      case 'Y': this.operatorShortcut('y', 'y'); return;
      case 'd': case 'y': case 'c': case '<': case '>':
        this.beginOperator(key);
        return;
      case 'p': this.paste(true); return;
      case 'P': this.paste(false); return;
      case 'J': this.joinCommand(true); return;
      case '~': this.tildeCommand(); return;
      case '&': this.repeatSubstituteKey('s'); return;
      case 'U': this.undoLine(); return;
      case 'u': {
        const n = this.takeCount() ?? 1;
        for (let i = 0; i < n; i++) this.performUndo();
        return;
      }
      case 'v': this.enterVisual('visual'); return;
      case 'V': this.enterVisual('visual-line'); return;
      case 'm': this.awaitingMarkSet = true; return;
      case '`': this.awaitingMarkJumpExact = true; return;
      case "'": this.awaitingMarkJumpLine = true; return;
      case ':':
        this.commandBuffer = '';
        this._mode = 'command';
        this.historyNavIndex = null;
        this.beginIncSearch();
        return;
      case 'Escape':
        this._message = '';
        this.pendingOperator = null;
        this.pendingCountStr = '';
        this.pendingG = false;
        return;
      default:
        this.pendingCountStr = '';
        return;
    }
  }

  private tryGCommand(key: string): boolean {
    if (key === '~' || key === 'u' || key === 'U') { this.beginOperator(`g${key}` as Operator); return true; }
    if (key === 'J') { this.joinCommand(false); return true; }
    if (key === 'I') { this.beginInsert('gI'); return true; }
    if (key === '&') { this.repeatSubstituteKey('%s//~/&'); return true; }
    return this.tryGMotion(key);
  }

  private gotoLine(idx: number): void {
    this._cursorLine = Math.max(0, Math.min(idx, this.linesArr.length - 1));
    const l = this.line(this._cursorLine);
    const firstNonBlank = l.search(/\S/);
    this._cursorCol = firstNonBlank >= 0 ? firstNonBlank : 0;
  }

  private setLine(i: number, text: string): void {
    this.linesArr[i] = text;
    this.insertTouched = true;
  }

  private jumpToMark(key: string, linewise: boolean): void {
    const isBackToggle = (!linewise && key === '`') || (linewise && key === "'");
    const target = isBackToggle ? this.lastJumpPosition : (this.marks.get(key) ?? null);
    if (!target) {
      this._message = 'E20: Mark not set';
      return;
    }
    this.performJump(target, linewise);
  }

  private performJump(target: { line: number; col: number }, linewise: boolean): void {
    const before = { line: this._cursorLine, col: this._cursorCol };
    this.lastJumpPosition = before;
    this._cursorLine = Math.max(0, Math.min(target.line, this.linesArr.length - 1));
    if (linewise) {
      const l = this.line(this._cursorLine);
      const firstNonBlank = l.search(/\S/);
      this._cursorCol = firstNonBlank >= 0 ? firstNonBlank : 0;
    } else {
      this._cursorCol = this.clampCol(this._cursorLine, target.col);
    }
    this._message = '';
  }

  private enterInsert(opened = false, startsAtLineStart = false, indentedByVim = opened): void {
    this.mlEmpty = false;
    this.typedSpace = false;
    this.insertTouched = opened;
    this.autoIndentPending = indentedByVim && this.options.bool('autoindent');
    this.insertStart = { line: this._cursorLine, col: startsAtLineStart ? 0 : this._cursorCol };
    this._mode = 'insert';
    this._message = this.variant === 'vim' ? '-- INSERT --' : '';
  }

  private beginInsert(kind: 'i' | 'a' | 'A' | 'I' | 'o' | 'O' | 'gI'): void {
    const count = this.takeCount() ?? 1;
    const text = this.line(this._cursorLine);
    if (kind === 'o' || kind === 'O') {
      this.pushUndoSnapshot();
      const indent = this.indentFor(text);
      const at = kind === 'o' ? this._cursorLine + 1 : this._cursorLine;
      this.linesArr.splice(at, 0, indent);
      this._cursorLine = at;
      this._cursorCol = indent.length;
      this._modified = true;
    } else {
      if (kind === 'a') this._cursorCol = text.length > 0 ? Math.min(text.length, this._cursorCol + charLengthAt(text, this._cursorCol)) : 0;
      else if (kind === 'A') this._cursorCol = text.length;
      else if (kind === 'I') this._cursorCol = firstNonWhite(text);
      else if (kind === 'gI') this._cursorCol = 0;
      this.pushUndoSnapshot();
    }
    this.insertRepeat = count;
    this.insertKind = kind === 'o' || kind === 'O' ? kind : 'i';
    this.insertedText = '';
    this.insertUndoDepth = this.undoStack.length;
    this.enterInsert(kind === 'o' || kind === 'O', kind === 'o' || kind === 'O');
  }

  private operatorShortcut(op: Operator, motion: string): void {
    this.pendingOperator = op;
    this.opCount = undefined;
    if (motion === op || (op === 'c' && motion === 'c') || (op === 'y' && motion === 'y')) {
      this.runDoubledOperator(op);
      return;
    }
    this.runOperatorMotion(op, motion);
  }

  private beginOperator(op: Operator): void {
    this.pendingOperator = op;
    this.opCount = this.takeCount();
  }

  private cancelOperator(): void {
    this.pendingOperator = null;
    this.opCount = undefined;
    this.pendingCountStr = '';
    this.pendingG = false;
    this.awaitingFindChar = null;
    this.operatorPendingMarkMode = null;
    this.operatorPendingTextObjectKind = null;
  }

  private applyOperatorGKey(key: string): void {
    const op = this.pendingOperator!;
    if (op.length === 2 && key === op[1]) { this.runDoubledOperator(op); return; }
    if (key === 'g' || key === 'e' || key === 'E' || key === '_' || key === 'j' || key === 'k') {
      if (key === 'g' && this.variant === 'vi') { this.cancelOperator(); return; }
      this.runOperatorMotion(op, key === 'j' || key === 'k' ? `g${key}` : `g${key}`);
      return;
    }
    if (this.trySearchKey(`g${key}`, op)) return;
    this.cancelOperator();
  }

  private applyOperatorKey(k: EditorKeyInput): void {
    const key = k.key;
    const op = this.pendingOperator!;

    if (key === 'Escape') { this.cancelOperator(); return; }

    if (this.awaitingFindChar) {
      const kind = this.awaitingFindChar;
      this.awaitingFindChar = null;
      if (key.length !== 1 || k.ctrl) { this.cancelOperator(); return; }
      this.lastFind = { char: key, forward: kind === 'f' || kind === 't', until: kind === 't' || kind === 'T' };
      this.runOperatorMotion(op, kind, key);
      return;
    }
    if (this.operatorPendingMarkMode) {
      const linewise = this.operatorPendingMarkMode === 'line';
      this.operatorPendingMarkMode = null;
      this.runMarkOperator(op, key, linewise);
      return;
    }
    if (this.operatorPendingTextObjectKind) {
      const kind = this.operatorPendingTextObjectKind;
      this.operatorPendingTextObjectKind = null;
      this.runTextObjectOperator(op, kind, key);
      return;
    }

    if (key === '`' || key === "'") {
      this.operatorPendingMarkMode = key === '`' ? 'exact' : 'line';
      return;
    }
    if (key === 'i' || key === 'a') {
      this.operatorPendingTextObjectKind = key;
      return;
    }
    if (key === 'g') { this.pendingG = true; return; }
    if (key === 'f' || key === 'F' || key === 't' || key === 'T') { this.awaitingFindChar = key; return; }

    const doubled = op.length === 1 ? key === op : key === op[1];
    if (doubled) { this.runDoubledOperator(op); return; }

    if (!k.ctrl && this.trySearchKey(key, op)) return;
    if (!k.ctrl && VimEngine.MOTION_KEYS.has(key)) { this.runOperatorMotion(op, key); return; }
    this.cancelOperator();
  }

  private runDoubledOperator(op: Operator): void {
    const count = this.effectiveCount();
    const last = this.linesArr.length - 1;
    const n = count ?? 1;
    if (n > 1 && this._cursorLine >= last) { this.cancelOperator(); return; }
    const endLine = Math.min(last, this._cursorLine + n - 1);
    const from = { line: this._cursorLine, col: this._cursorCol };
    const moved = op === 'y' ? from : { line: endLine, col: firstNonBlank(this.line(endLine)) };
    const fromFirst = from.line < moved.line || (from.line === moved.line && from.col <= moved.col);
    this.executeOperator(op, {
      start: fromFirst ? from : moved, end: { line: endLine, col: 0 }, type: 'line', inclusive: false,
    }, 1);
  }

  private runOperatorMotion(op: Operator, key: string, arg?: string): void {
    const count = this.effectiveCount();
    const want = this.currentWant();
    const from = { line: this._cursorLine, col: this._cursorCol };
    const result = runMotion(this.motionBuffer(), from, {
      key, count, arg, want, operator: true, change: op === 'c', visual: false, lastFind: this.lastFind,
    });
    if (!result || result.failed) { this.cancelOperator(); return; }
    const before = result.pos.line < from.line || (result.pos.line === from.line && result.pos.col < from.col);
    this.executeOperator(op, {
      start: before ? result.pos : from,
      end: before ? from : result.pos,
      type: result.type,
      inclusive: result.inclusive,
      noAdjustEnd: result.noAdjustEnd,
    }, 1);
  }

  private runMarkOperator(op: Operator, key: string, linewise: boolean): void {
    const isBackToggle = (!linewise && key === '`') || (linewise && key === "'");
    const target = isBackToggle ? this.lastJumpPosition : (this.marks.get(key) ?? null);
    if (!target) { this.cancelOperator(); return; }
    const from = { line: this._cursorLine, col: this._cursorCol };
    const to = { line: Math.min(target.line, this.linesArr.length - 1), col: target.col };
    const before = to.line < from.line || (to.line === from.line && to.col < from.col);
    this.executeOperator(op, {
      start: before ? to : from, end: before ? from : to, type: linewise ? 'line' : 'char', inclusive: false,
    }, 1);
  }

  private runTextObjectOperator(op: Operator, kind: 'i' | 'a', objectKey: string): void {
    const count = this.effectiveCount() ?? 1;
    const range = textObject(this.motionBuffer(), { line: this._cursorLine, col: this._cursorCol }, kind === 'i', objectKey, count);
    if (range?.partial) {
      this._cursorLine = range.end.line;
      this._cursorCol = this.clampCol(range.end.line, range.end.col);
    }
    if (!range || range.partial) { this.cancelOperator(); return; }
    const reversed = range.end.line < range.start.line || (range.end.line === range.start.line && range.end.col < range.start.col);
    this.executeOperator(op, {
      start: reversed ? range.end : range.start, end: reversed ? range.start : range.end,
      type: range.type, inclusive: range.inclusive,
    }, 1);
  }

  private insideIndent(pos: { line: number; col: number }): boolean {
    const text = this.line(pos.line);
    let white = 0;
    while (white < text.length && (text[white] === ' ' || text[white] === '\t')) white++;
    return white >= pos.col;
  }

  private executeOperator(op: Operator, range: OperatorRange, shiftAmount: number, visual = false): void {
    this.pendingOperator = null;
    this.opCount = undefined;
    let { start, end, type, inclusive } = range;
    if (type === 'char' && !inclusive && end.col === 0 && end.line > start.line && !range.noAdjustEnd && !visual) {
      end = { line: end.line - 1, col: 0 };
      if (this.insideIndent(start)) {
        type = 'line';
      } else {
        const length = this.line(end.line).length;
        if (length > 0) { end = { line: end.line, col: length - 1 }; inclusive = true; }
      }
    }
    if (type === 'char' && op === 'd' && !visual && end.line > start.line) {
      const tail = this.line(end.line).slice(end.col + (inclusive ? charLengthAt(this.line(end.line), end.col) : 0));
      if (/^[ \t]*$/.test(tail) && this.insideIndent(start)) type = 'line';
    }
    const endExclusive = { line: end.line, col: end.col + (inclusive ? charLengthAt(this.line(end.line), end.col) : 0) };
    this._cursorLine = start.line;
    this._cursorCol = start.col;

    if (op === 'y') { this.yankRange(start, endExclusive, end, type); return; }
    if (op === '<' || op === '>') { this.shiftRange(start.line, end.line, op === '>' ? shiftAmount : -shiftAmount); return; }
    if (op === 'g~' || op === 'gu' || op === 'gU') { this.caseRange(op, start, endExclusive, end, type); return; }
    if (op === 'd') { this.deleteRange(start, endExclusive, end, type); return; }
    this.changeRange(start, endExclusive, end, type);
  }

  private yankRange(start: { line: number; col: number }, endExclusive: { line: number; col: number }, end: { line: number; col: number }, type: 'char' | 'line'): void {
    if (type === 'line') {
      const lines = this.linesArr.slice(start.line, end.line + 1);
      this.setRegister({ linewise: true, lines });
      this._message = `${lines.length} line${lines.length === 1 ? '' : 's'} yanked`;
    } else {
      const pieces = sliceChars(this.linesArr, start, endExclusive);
      this.setRegister({ linewise: false, lines: pieces });
      this._message = '';
    }
    this._cursorLine = start.line;
    this._cursorCol = this.clampCol(start.line, type === 'line' ? this._cursorCol : start.col);
  }

  private deleteRange(start: { line: number; col: number }, endExclusive: { line: number; col: number }, end: { line: number; col: number }, type: 'char' | 'line'): void {
    if (this.mlEmpty && this.linesArr.length === 1 && this.linesArr[0] === '') return;
    this.pushUndoSnapshot();
    if (type === 'line') {
      const removed = this.linesArr.splice(start.line, end.line - start.line + 1);
      this.setRegister({ linewise: true, lines: removed });
      if (this.linesArr.length === 0) {
        this.linesArr.push('');
        this.mlEmpty = true;
      }
      this._cursorLine = Math.min(start.line, this.linesArr.length - 1);
      this._cursorCol = firstNonBlank(this.line(this._cursorLine));
    } else {
      const empty = start.line === endExclusive.line && start.col >= endExclusive.col;
      if (!empty) {
        const removed = removeChars(this.linesArr, start, endExclusive);
        this.setRegister({ linewise: false, lines: removed });
      }
      this._cursorLine = start.line;
      this._cursorCol = this.clampCol(start.line, start.col);
    }
    this._modified = true;
  }

  private changeRange(start: { line: number; col: number }, endExclusive: { line: number; col: number }, end: { line: number; col: number }, type: 'char' | 'line'): void {
    this.pushUndoSnapshot();
    let emptyChange = false;
    if (type === 'line') {
      const removed = this.linesArr.slice(start.line, end.line + 1);
      this.setRegister({ linewise: true, lines: removed });
      const indent = this.options.bool('autoindent') ? /^[ \t]*/.exec(this.line(start.line))![0] : '';
      this.linesArr.splice(start.line, end.line - start.line + 1, indent);
      this._cursorLine = start.line;
      this._cursorCol = indent.length;
    } else {
      const empty = start.line === endExclusive.line && start.col >= endExclusive.col;
      emptyChange = empty;
      if (!empty) {
        const removed = removeChars(this.linesArr, start, endExclusive);
        this.setRegister({ linewise: false, lines: removed });
      }
      this._cursorLine = start.line;
      this._cursorCol = start.col;
    }
    this._modified = true;
    this.insertRepeat = 1;
    this.insertKind = 'i';
    this.insertedText = '';
    this.insertUndoDepth = -1;
    this.enterInsert(type === 'line' || !emptyChange, false, type === 'line');
  }

  private shiftRange(startLine: number, endLine: number, amount: number): void {
    this.pushUndoSnapshot();
    for (let i = startLine; i <= endLine; i++) {
      this.linesArr[i] = shiftLine(this.line(i), this.tabstop, this.shiftwidth, amount, this.options.expandtab);
    }
    this._cursorLine = startLine;
    this._cursorCol = firstNonBlank(this.line(startLine));
    this._modified = true;
    const n = endLine - startLine + 1;
    if (n > 2) this._message = `${n} lines ${amount > 0 ? '>' : '<'}ed ${Math.abs(amount)} time${Math.abs(amount) === 1 ? '' : 's'}`;
  }

  private caseRange(op: 'g~' | 'gu' | 'gU', start: { line: number; col: number }, endExclusive: { line: number; col: number }, end: { line: number; col: number }, type: 'char' | 'line'): void {
    this.pushUndoSnapshot();
    const convert = (text: string): string => {
      if (op === 'gu') return text.toLowerCase();
      if (op === 'gU') return text.toUpperCase();
      let out = '';
      for (const ch of text) out += swapCase(ch);
      return out;
    };
    for (let i = start.line; i <= end.line; i++) {
      const text = this.line(i);
      const from = type === 'line' || i > start.line ? 0 : start.col;
      const to = type === 'line' || i < end.line ? text.length : endExclusive.col;
      this.linesArr[i] = text.slice(0, from) + convert(text.slice(from, to)) + text.slice(to);
    }
    this._cursorLine = start.line;
    this._cursorCol = this.clampCol(start.line, this._cursorCol);
    this._modified = true;
  }

  private replaceCharacters(k: EditorKeyInput): void {
    const count = this.replaceCount;
    const key = k.key === 'Tab' ? '\t' : k.key;
    if (key === 'Escape' || (key.length !== 1 && key !== 'Enter')) return;
    const text = this.line(this._cursorLine);
    if (text.length - this._cursorCol < count) return;
    if (key === '\t' && this.options.expandtab) {
      this.pendingCountStr = String(count);
      for (const replayed of ['R', 'Tab', 'Escape']) this.applyKeyInner({ key: replayed });
      return;
    }
    this.pushUndoSnapshot();
    if (key === 'Enter') {
      const before = text.slice(0, this._cursorCol);
      const after = text.slice(this._cursorCol + count);
      const indent = this.indentFor(text);
      this.linesArr.splice(this._cursorLine, 1, before, indent + after);
      this._cursorLine++;
      this._cursorCol = indent.length;
    } else {
      this.setLine(this._cursorLine, text.slice(0, this._cursorCol) + key.repeat(count) + text.slice(this._cursorCol + count));
      this._cursorCol += count - 1;
      this.armShowMatch(key, this._cursorCol);
    }
    this._modified = true;
  }

  private tildeCommand(): void {
    const count = this.takeCount() ?? 1;
    const text = this.line(this._cursorLine);
    if (text.length === 0) return;
    this.pushUndoSnapshot();
    const to = Math.min(text.length, this._cursorCol + count);
    let converted = '';
    for (const ch of text.slice(this._cursorCol, to)) converted += swapCase(ch);
    this.setLine(this._cursorLine, text.slice(0, this._cursorCol) + converted + text.slice(to));
    this._cursorCol = Math.min(to, text.length - 1);
    this._modified = true;
  }

  private joinCommand(withSpaces: boolean): void {
    let count = this.takeCount() ?? 2;
    if (count < 2) count = 2;
    const last = this.linesArr.length - 1;
    if (this._cursorLine + count - 1 > last) {
      if (count <= 2) return;
      count = last - this._cursorLine + 1;
    }
    this.pushUndoSnapshot();
    const parts = this.linesArr.slice(this._cursorLine, this._cursorLine + count);
    const joined = joinText(parts, withSpaces, this.joinSpaces);
    this.linesArr.splice(this._cursorLine, count, joined.line);
    this._cursorCol = this.clampCol(this._cursorLine, joined.col);
    this._modified = true;
  }

  private incrementNumber(direction: 1 | -1): void {
    const count = this.takeCount() ?? 1;
    const text = this.line(this._cursorLine);
    const pattern = /-?\d+/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const end = match.index + match[0].length;
      if (end > this._cursorCol) {
        const value = parseInt(match[0], 10) + direction * count;
        this.pushUndoSnapshot();
        const next = String(value);
        this.setLine(this._cursorLine, text.slice(0, match.index) + next + text.slice(end));
        this._cursorCol = match.index + next.length - 1;
        this._modified = true;
        return;
      }
    }
  }

  private paste(after: boolean): void {
    const count = this.takeCount() ?? 1;
    const name = this.pendingRegister ?? '"';
    const reg = this.activeRegister();
    if (!reg || reg.lines.length === 0) {
      this._message = `E353: Nothing in register ${name}`;
      this.commandRepeatable = true;
      return;
    }
    this.pushUndoSnapshot();
    this.putText(reg, after, count);
  }

  private putText(reg: UnnamedRegister, after: boolean, count: number): void {
    if (reg.linewise) {
      const block: string[] = [];
      for (let i = 0; i < count; i++) block.push(...reg.lines);
      const at = after ? this._cursorLine + 1 : this._cursorLine;
      this.linesArr.splice(at, 0, ...block);
      this._cursorLine = at;
      this._cursorCol = firstNonBlank(this.line(at));
      this._message = `${reg.lines.length} line${reg.lines.length === 1 ? '' : 's'} pasted`;
    } else if (reg.lines.length === 1) {
      const text = this.line(this._cursorLine);
      const at = after && text.length > 0 ? Math.min(this._cursorCol + 1, text.length) : this._cursorCol;
      const inserted = reg.lines[0].repeat(count);
      this.setLine(this._cursorLine, text.slice(0, at) + inserted + text.slice(at));
      this._cursorCol = at + Math.max(0, inserted.length - 1);
    } else {
      const text = this.line(this._cursorLine);
      const at = after && text.length > 0 ? Math.min(this._cursorCol + 1, text.length) : this._cursorCol;
      const head = text.slice(0, at);
      const tail = text.slice(at);
      let pieces = [...reg.lines];
      for (let i = 1; i < count; i++) {
        pieces = [...pieces.slice(0, -1), pieces[pieces.length - 1] + reg.lines[0], ...reg.lines.slice(1)];
      }
      pieces[0] = head + pieces[0];
      pieces[pieces.length - 1] += tail;
      this.linesArr.splice(this._cursorLine, 1, ...pieces);
      this._cursorCol = at;
    }
    this._modified = true;
  }

  // ── Shared cursor motions (used by NORMAL fallback-free callers and VISUAL) ──

  private static readonly MOTION_KEYS: ReadonlySet<string> = new Set([
    'h', 'l', 'j', 'k', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', ' ', 'Enter', '+', '-', '_',
    '0', '^', '$', 'Home', 'End', '|', 'G', 'w', 'W', 'e', 'E', 'b', 'B', ';', ',', '{', '}', '%',
    '(', ')', 'H', 'M', 'L',
  ]);

  private currentWant(): number {
    return this.want >= 0 ? this.want : this.vcolAt(this.line(this._cursorLine), this._cursorCol);
  }

  private get words(): WordClasses {
    const spec = this.options.string('iskeyword');
    if (this.wordClassesCache.spec !== spec) this.wordClassesCache = wordClasses(spec) ?? DEFAULT_WORD_CLASSES;
    return this.wordClassesCache;
  }

  private motionBuffer(): MotionBuffer {
    return {
      lines: this.linesArr, tabstop: this.tabstop, list: this.listMode, ctrlTab: this.ctrlTab, window: this.window,
      pairs: parseMatchPairs(this.options.string('matchpairs')), words: this.words,
    };
  }

  private windowSettings(): WindowSettings {
    const o = this.options;
    const spec = o.string('listchars');
    if (this.listSpecCache === null || this.listSpecCache.spec !== spec) this.listSpecCache = { spec, parsed: parseListChars(spec) };
    return {
      tabstop: o.tabstop, wrap: o.wrap, number: o.bool('number'), relativenumber: o.bool('relativenumber'),
      numberwidth: o.number('numberwidth'), list: o.bool('list'), listchars: this.listSpecCache.parsed,
      scrolloff: o.scrolloff, sidescroll: o.sidescroll, sidescrolloff: o.sidescrolloff,
    };
  }

  private get shownName(): string {
    return this.displayName === '' ? this.filePath : this.displayName;
  }

  resize(rows: number, cols: number): void {
    if (Math.max(2, rows) === this.window.rows && Math.max(1, cols) === this.window.cols) return;
    this.window.resize(rows, cols, this._cursorLine, this._cursorCol, this.cursorOnTabEnd());
    this.window.invalidateTop();
    this.options.assign('scroll', this.window.defaultScroll);
    this.followCursor();
  }

  get windowRows(): number { return this.window.rows; }
  get windowCols(): number { return this.window.cols; }

  private cursorOnTabEnd(): boolean {
    if (this._mode === 'insert') return false;
    if (this._mode === 'visual' || this._mode === 'visual-line' || this._mode === 'visual-block') {
      return this._cursorLine > this.visualAnchorLine || (this._cursorLine === this.visualAnchorLine && this._cursorCol >= this.visualAnchorCol);
    }
    return true;
  }

  private followCursor(): void {
    if (this._mode === 'command' || this._mode === 'search') return;
    this.window.follow(this._cursorLine, this._cursorCol);
    this.window.followColumn(this._cursorLine, this._cursorCol, this.cursorOnTabEnd());
  }

  private pageScroll(forward: boolean): void {
    const inserting = this._mode === 'insert';
    const count = inserting ? 1 : this.takeCount() ?? 1;
    if (this.want < 0) this.want = this.currentWant();
    const result = this.window.onePage(forward, count, this._cursorLine);
    if (result.failed) this.keepWantThisKey = true;
    const bytes = byteOffset(this.line(this._cursorLine), this._cursorCol);
    this._cursorLine = result.cursor;
    this._cursorCol = this.clampCol(this._cursorLine, colAtByte(this.line(this._cursorLine), bytes), inserting);
    if (!result.failed) this._cursorCol = firstNonBlank(this.line(this._cursorLine));
    if (inserting && !result.failed) {
      this.insertRepeat = 1;
      this.insertedText = '';
      this.insertUndoDepth = -1;
    }
  }

  private halfPageScroll(down: boolean): void {
    const count = this.takeCount();
    if ((down && this._cursorLine === this.linesArr.length - 1) || (!down && this._cursorLine === 0)) {
      if (this.want < 0) this.want = this.currentWant();
      this.keepWantThisKey = true;
      return;
    }
    if (count !== undefined && count > 0) this.options.assign('scroll', Math.min(count, this.window.height));
    const configured = this.options.number('scroll');
    this._cursorLine = this.window.halfPage(down, configured > 0 ? configured : this.window.defaultScroll, this._cursorLine);
    this._cursorCol = firstNonBlank(this.line(this._cursorLine));
  }

  private lineScroll(up: boolean): void {
    const count = this.takeCount() ?? 1;
    const previous = this._cursorLine;
    if (this.want < 0) this.want = this.currentWant();
    this.keepWantThisKey = true;
    this._cursorLine = this.window.scrollLines(up, count, this._cursorLine);
    if (this._cursorLine !== previous) this._cursorCol = colAtVcol(this.line(this._cursorLine), this.currentWant(), this.tabstop, this._mode !== 'normal', this.ctrlTab);
  }

  private mouseReaches(): boolean {
    const flags = this.options.string('mouse');
    if (flags.includes('a')) return true;
    if (this._mode === 'normal') return flags.includes('n');
    if (this._mode === 'insert') return flags.includes('i');
    if (this._mode === 'visual' || this._mode === 'visual-line' || this._mode === 'visual-block') return flags.includes('v');
    return false;
  }

  clickAt(row: number, col: number): void {
    if (this.visualObjectKind !== null) {
      this.visualObjectKind = null;
      return;
    }
    if (!this.mouseReaches()) return;
    const hit = this.window.cellAt(row, col);
    if (hit === null) return;
    if (this._mode === 'visual' || this._mode === 'visual-line' || this._mode === 'visual-block') this.exitVisual();
    this._cursorLine = hit.line;
    this._cursorCol = this.window.colAtCell(hit.line, hit.cell, this._mode === 'insert');
    this.want = hit.cell;
    this.followCursor();
  }

  scrollView(up: boolean, count: number): void {
    const previous = this._cursorLine;
    this._cursorLine = this.window.scrollLines(up, count, this._cursorLine);
    if (this._cursorLine !== previous) this._cursorCol = colAtVcol(this.line(this._cursorLine), this.currentWant(), this.tabstop, this._mode !== 'normal', this.ctrlTab);
    this.followCursor();
    this.updateWant();
  }

  private runZCommand(key: string): void {
    const count = this.takeCount();
    const horizontal = ['h', 'l', 'H', 'L', 's', 'e'].includes(key);
    if (count !== undefined && !horizontal && count !== this._cursorLine + 1) {
      this._cursorLine = Math.min(this.linesArr.length - 1, Math.max(0, count - 1));
      this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol);
    }
    switch (key) {
      case 'Enter': this._cursorCol = firstNonBlank(this.line(this._cursorLine)); this.window.scrollTop(this._cursorLine, true); return;
      case 't': this.window.scrollTop(this._cursorLine, true); return;
      case '.': this._cursorCol = firstNonBlank(this.line(this._cursorLine)); this.window.scrollMiddle(this._cursorLine); return;
      case 'z': this.window.scrollMiddle(this._cursorLine); return;
      case '-': this._cursorCol = firstNonBlank(this.line(this._cursorLine)); this.window.scrollBottom(this._cursorLine); return;
      case 'b': this.window.scrollBottom(this._cursorLine); return;
      default: this.runHorizontalScroll(key, count ?? 1);
    }
  }

  private runHorizontalScroll(key: string, count: number): void {
    if (this.options.wrap) {
      this.keepWantThisKey = true;
      return;
    }
    const width = this.window.textWidth;
    const siso = this.options.sidescrolloff;
    const half = Math.floor(this.window.cols / 2);
    const span = this.window.cursorSpan(this._cursorLine, this._cursorCol, this.cursorOnTabEnd());
    if (key === 'H' || key === 'h') {
      const amount = key === 'H' ? count * half : count;
      this.setLeftcol(amount > this.window.leftCol ? 0 : this.window.leftCol - amount);
    } else if (key === 'L' || key === 'l') {
      this.setLeftcol(this.window.leftCol + (key === 'L' ? count * half : count));
    } else if (key === 's') {
      this.window.setLeftCol(span.start > siso ? span.start - siso : 0);
    } else if (key === 'e') {
      this.window.setLeftCol(span.end + siso < width ? 0 : span.end + siso - width + 1);
    }
  }

  private coladvance(cell: number): boolean {
    const target = Math.max(0, cell);
    const cells = this.window.cellCount(this._cursorLine);
    this._cursorCol = this.window.colAtCell(this._cursorLine, target, false);
    return target < cells || cells === 0;
  }

  private setLeftcol(leftcol: number): void {
    if (this.window.leftCol === leftcol) {
      this.keepWantThisKey = true;
      return;
    }
    this.window.setLeftCol(leftcol);
    const lastcol = leftcol + this.window.textWidth - 1;
    const siso = this.options.sidescrolloff;
    let moved = false;
    const virt = this.window.virtColumn(this._cursorLine, this._cursorCol, this.cursorOnTabEnd());
    if (virt > lastcol - siso) {
      moved = true;
      this.coladvance(lastcol - siso);
    } else if (virt < leftcol + siso) {
      moved = true;
      this.coladvance(leftcol + siso);
    }
    const span = this.window.cursorSpan(this._cursorLine, this._cursorCol, false);
    if (span.end > lastcol) {
      moved = true;
      this.coladvance(span.start - 1);
    } else if (span.start < leftcol) {
      moved = true;
      if (!this.coladvance(span.end + 1)) this.window.setLeftCol(span.start);
    }
    if (!moved) this.keepWantThisKey = true;
  }

  private trackShowcmd(k: EditorKeyInput): void {
    if (this._mode !== 'normal' || !this.hasPendingCommand()) {
      this.showcmdKeys = '';
      return;
    }
    if (k.key.length === 1) this.showcmdKeys += k.ctrl ? `^${k.key.toUpperCase()}` : k.key;
  }

  private visualSizeText(): string {
    if (this._mode === 'visual-line') return String(Math.abs(this._cursorLine - this.visualAnchorLine) + 1);
    if (this._mode === 'visual-block') {
      const corners = this.blockCorners();
      return `${corners.bottom - corners.top + 1}x${corners.right - corners.left + 1}`;
    }
    if (this._cursorLine !== this.visualAnchorLine) return String(Math.abs(this._cursorLine - this.visualAnchorLine) + 1);
    const text = this.line(this._cursorLine);
    const from = Math.min(this._cursorCol, this.visualAnchorCol);
    const to = Math.min(text.length - 1, Math.max(this._cursorCol, this.visualAnchorCol));
    const selected = text.slice(from, to + 1);
    const chars = [...selected].length;
    const bytes = new TextEncoder().encode(selected).length;
    return chars === bytes ? String(chars) : `${chars}-${bytes}`;
  }

  private rulerPosition(at = this._cursorLine, col = this._cursorCol, tabEnd = this.cursorOnTabEnd()): string {
    const text = this.line(at);
    const line = this.mlEmpty ? 0 : at + 1;
    if (text.length === 0) return `${line},0-1`;
    const bytes = new TextEncoder().encode(text.slice(0, col)).length + 1;
    const virtual = this.window.cursorSpan(at, col, tabEnd).virt + 1;
    return `${line},${bytes === virtual ? bytes : `${bytes}-${virtual}`}`;
  }

  private bottomMessage(): { text: string; style: ScreenStyle | null } {
    const recording = this.recordingMacro ? `recording @${this.recordingMacro.name}` : '';
    if (this._mode === 'confirm-substitute' && this._pendingMatch) {
      return { text: `replace with ${this._pendingMatch.replacementPreview} (y/n/a/q/l/^E/^Y)?`, style: null };
    }
    if (this._mode === 'ask-swap-range') return { text: 'Backwards range given, OK to swap (y/n)?', style: null };
    const showmode = this.options.bool('showmode');
    const label = ({ visual: '-- VISUAL --', 'visual-line': '-- VISUAL LINE --', 'visual-block': '-- VISUAL BLOCK --' } as Record<string, string>)[this._mode];
    if (label !== undefined) return { text: showmode ? label + recording : recording, style: 'modemsg' };
    if (this._message === '' && recording !== '') return { text: recording, style: null };
    if (this._message.startsWith('--')) return { text: this._message + recording, style: 'modemsg' };
    return { text: this._message, style: /^E\d+:/.test(this._message) ? 'error' : null };
  }

  private searchHighlight(): ReadonlyMap<number, readonly HighlightSpan[]> | null {
    if (this.liveSearch !== null && this.liveSearch.active) {
      const typed = this.liveSearch.pattern;
      if (!this.options.bool('hlsearch') || typed === null || matchesEverything(typed)) return null;
      const range = this.liveSearch.range;
      return highlightSpans(
        this.linesArr, typed, this.searchIgnoresCase(typed),
        Math.max(this.window.top, range?.first ?? 0), Math.min(this.window.top + this.window.height, range?.last ?? Number.MAX_SAFE_INTEGER),
        this.patternContext(),
      );
    }
    if (!this.options.bool('hlsearch') || this.noHlsearch || this.lastSearch === null) return null;
    return highlightSpans(this.linesArr, this.lastSearch.pattern, this.searchIgnoresCase(this.lastSearch.pattern, this.lastSearch.noSmartcase), this.window.top, this.window.top + this.window.height, this.patternContext());
  }

  get screen(): EditorScreen {
    const settled = this.buildEditorScreen(null);
    const millis = this.options.number('matchtime') * 100;
    if (this.matchJump === null || millis <= 0) return settled;
    return { ...this.buildEditorScreen(this.matchJump), hold: { millis, then: settled } };
  }

  private buildEditorScreen(jump: { line: number; col: number } | null): EditorScreen {
    const o = this.options;
    const mode = this._mode;
    const visual = mode === 'visual' || mode === 'visual-line' || mode === 'visual-block'
      ? { mode, anchor: { line: this.visualAnchorLine, col: this.visualAnchorCol } }
      : null;
    const commandLine = mode === 'command'
      ? { prompt: ':', text: this.commandBuffer }
      : mode === 'search' ? { prompt: this.searchPromptChar, text: [...this.searchBuffer].map((c) => (c.charCodeAt(0) < 32 ? `^${String.fromCharCode(c.charCodeAt(0) + 64)}` : c)).join('') } : null;
    const bottom = this.bottomMessage();
    return buildScreen(this.window, {
      lines: this.linesArr,
      cursor: { line: this._cursorLine, col: this._cursorCol },
      tabEnd: this.cursorOnTabEnd() && !(this.cmdlineColumn !== null && this.cmdlineColumn.line === this._cursorLine && this.cmdlineColumn.col === this._cursorCol),
      visual,
      searchSpans: this.searchHighlight(),
      incSearchSpans: this.incSearchSpans(),
      colorcolumn: o.string('colorcolumn'),
      textwidth: 0,
      list: o.bool('list'),
      listchars: o.string('listchars'),
      number: o.bool('number'),
      relativenumber: o.bool('relativenumber'),
      display: o.string('display'),
      commandLine,
      message: bottom.text,
      messageStyle: bottom.style,
      ruler: o.bool('ruler'),
      showcmd: o.bool('showcmd') ? (visual ? this.visualSizeText() : this.showcmdKeys) : null,
      rulerPosition: jump === null ? this.rulerPosition() : this.rulerPosition(jump.line, jump.col, false),
      cursorAt: jump,
    });
  }

  private runCursorMotion(key: string, arg?: string): void {
    const count = this.takeCount();
    const want = this.currentWant();
    const result = runMotion(this.motionBuffer(), { line: this._cursorLine, col: this._cursorCol }, {
      key, count, arg, want, operator: false, change: false,
      visual: this._mode !== 'normal', lastFind: this.lastFind,
    });
    if (!result) return;
    this._cursorLine = result.pos.line;
    this._cursorCol = this.clampCol(result.pos.line, result.pos.col, this._mode !== 'normal');
    if (result.want !== undefined) this.explicitWant = result.want;
    if (result.keepWant) {
      this.keepWantThisKey = true;
      if (this.want < 0) this.want = want;
    }
  }

  private tryMotion(key: string, k?: EditorKeyInput): boolean {
    if (this.awaitingFindChar) {
      const kind = this.awaitingFindChar;
      this.awaitingFindChar = null;
      if (key.length !== 1 || (k?.ctrl ?? false)) { this.pendingCountStr = ''; return true; }
      this.lastFind = { char: key, forward: kind === 'f' || kind === 't', until: kind === 't' || kind === 'T' };
      this.runCursorMotion(kind, key);
      return true;
    }
    if (k?.ctrl || k?.alt) return false;
    if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
      this.awaitingFindChar = key;
      return true;
    }
    if (this.trySearchKey(key, null)) return true;
    if (!VimEngine.MOTION_KEYS.has(key)) return false;
    this.runCursorMotion(key);
    return true;
  }

  private tryGMotion(key: string): boolean {
    if (key === 'g') {
      if (this.variant === 'vi') { this.pendingCountStr = ''; return true; }
      this.runCursorMotion('gg');
      return true;
    }
    if (key === '_' || key === 'e' || key === 'E') { this.runCursorMotion(`g${key}`); return true; }
    if (key === 'j' || key === 'k' || key === '0' || key === '^' || key === 'm' || key === '$') { this.runCursorMotion(`g${key}`); return true; }
    return this.trySearchKey(`g${key}`, null);
  }

  // ── VISUAL / VISUAL LINE / VISUAL BLOCK ─────────────────────────────

  private keepStickyColumn(): void {
    if (this.want < 0) this.want = this.vcolAt(this.line(this._cursorLine), this._cursorCol);
    this.keepWantThisKey = true;
  }

  private enterVisual(mode: 'visual' | 'visual-line' | 'visual-block'): void {
    this.keepStickyColumn();
    this.visualAnchorLine = this._cursorLine;
    this.visualAnchorCol = this._cursorCol;
    this._mode = mode;
    this.pendingCountStr = '';
  }

  private exitVisual(): void {
    this.lastVisualStart = Math.min(this.visualAnchorLine, this._cursorLine);
    this.lastVisualEnd = Math.max(this.visualAnchorLine, this._cursorLine);
    this.lastVisual = {
      anchor: { line: this.visualAnchorLine, col: this.visualAnchorCol },
      cursor: { line: this._cursorLine, col: this._cursorCol },
      mode: this._mode as 'visual' | 'visual-line' | 'visual-block',
    };
    this._mode = 'normal';
    this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol);
  }

  private visualBounds(): { startLine: number; startCol: number; endLine: number; endCol: number } {
    let sl = this.visualAnchorLine, sc = this.visualAnchorCol, el = this._cursorLine, ec = this._cursorCol;
    if (sl > el || (sl === el && sc > ec)) { [sl, el] = [el, sl]; [sc, ec] = [ec, sc]; }
    return { startLine: sl, startCol: sc, endLine: el, endCol: ec };
  }

  private applyVisualKey(k: EditorKeyInput): void {
    const key = k.key;

    if (this.awaitingReplaceChar) {
      this.awaitingReplaceChar = false;
      this.visualReplace(k);
      return;
    }
    if (this.awaitingRegisterName) {
      this.awaitingRegisterName = false;
      if (/^[a-zA-Z0-9"*+\-]$/.test(key)) this.pendingRegister = key;
      return;
    }
    if (key === '"') { this.awaitingRegisterName = true; return; }

    if (key === 'Escape' || (k.ctrl && key === '[')) {
      if (this.pendingCountStr !== '' || this.pendingG || this.pendingZ || this.awaitingFindChar || this.visualObjectKind) {
        this.pendingCountStr = '';
        this.pendingG = false;
        this.pendingZ = false;
        this.awaitingFindChar = null;
        this.visualObjectKind = null;
        return;
      }
      this.exitVisual();
      return;
    }

    if (/^[0-9]$/.test(key) && !(key === '0' && this.pendingCountStr === '') && !this.awaitingFindChar && !k.ctrl) {
      this.pendingCountStr += key;
      return;
    }

    if (this.awaitingFindChar) { this.tryMotion(key, k); return; }

    if (this.visualObjectKind) {
      const kind = this.visualObjectKind;
      this.visualObjectKind = null;
      this.selectVisualObject(kind, key);
      return;
    }

    if (this.pendingZ) {
      this.pendingZ = false;
      this.runZCommand(key);
      return;
    }

    if (this.pendingG) {
      this.pendingG = false;
      this.applyVisualGKey(key);
      return;
    }

    if (k.ctrl) {
      const lower = key.toLowerCase();
      if (lower === 'v') { this.switchVisualMode('visual-block'); return; }
      if (lower === 'f') { this.pageScroll(true); return; }
      if (lower === 'b') { this.pageScroll(false); return; }
      if (lower === 'd') { this.halfPageScroll(true); return; }
      if (lower === 'u') { this.halfPageScroll(false); return; }
      if (lower === 'e') { this.lineScroll(true); return; }
      if (lower === 'y') { this.lineScroll(false); return; }
      return;
    }

    if (key === 'PageDown' || key === 'PageUp') { this.pageScroll(key === 'PageDown'); return; }

    switch (key) {
      case 'g': this.pendingG = true; return;
      case 'z': this.pendingZ = true; return;
      case 'v': this.switchVisualMode('visual'); return;
      case 'V': this.switchVisualMode('visual-line'); return;
      case 'i': case 'a':
        if (this._mode !== 'visual-block' || true) { this.visualObjectKind = key; return; }
        return;
      case 'o': case 'O': {
        const line = this._cursorLine;
        const col = this._cursorCol;
        if (key === 'O' && this._mode === 'visual-block') {
          this._cursorCol = this.visualAnchorCol;
          this.visualAnchorCol = col;
          return;
        }
        this._cursorLine = this.visualAnchorLine;
        this._cursorCol = this.visualAnchorCol;
        this.visualAnchorLine = line;
        this.visualAnchorCol = col;
        return;
      }
      case ':':
        this.exitVisual();
        this.commandBuffer = "'<,'>";
        this._mode = 'command';
        this.beginIncSearch();
        return;
      case 'd': case 'x': case 'Delete': this.visualOperate('d'); return;
      case 'X': case 'D': this.visualOperate('d', true); return;
      case 'y': this.visualOperate('y'); return;
      case 'Y': this.visualOperate('y', true); return;
      case 'c': case 's': this.visualOperate('c'); return;
      case 'C': case 'S': case 'R': this.visualOperate('c', true); return;
      case '>': this.visualOperate('>'); return;
      case '<': this.visualOperate('<'); return;
      case '~': this.visualOperate('g~'); return;
      case 'u': this.visualOperate('gu'); return;
      case 'U': this.visualOperate('gU'); return;
      case 'J': this.visualJoin(true); return;
      case 'r': this.replaceCount = 1; this.awaitingReplaceChar = true; return;
      case 'p': case 'P': this.visualPut(key === 'P'); return;
      case 'I': case 'A':
        if (this._mode === 'visual-block') { this.beginBlockInsert(key === 'A'); return; }
        this.visualLineInsert(key === 'A');
        return;
      default:
        if (this.tryMotion(key, k)) return;
        this.pendingCountStr = '';
    }
  }

  private applyVisualGKey(key: string): void {
    if (key === 'v') {
      if (!this.lastVisual) return;
      const previous = { anchor: { line: this.visualAnchorLine, col: this.visualAnchorCol }, cursor: { line: this._cursorLine, col: this._cursorCol }, mode: this._mode as 'visual' | 'visual-line' | 'visual-block' };
      this.restoreVisual(this.lastVisual);
      this.lastVisual = previous;
      return;
    }
    if (key === '~') { this.visualOperate('g~'); return; }
    if (key === 'u') { this.visualOperate('gu'); return; }
    if (key === 'U') { this.visualOperate('gU'); return; }
    if (key === 'J') { this.visualJoin(false); return; }
    if (!this.tryGMotion(key)) this.pendingCountStr = '';
  }

  private restoreVisual(v: { anchor: { line: number; col: number }; cursor: { line: number; col: number }; mode: 'visual' | 'visual-line' | 'visual-block' }): void {
    const last = this.linesArr.length - 1;
    this.visualAnchorLine = Math.min(v.anchor.line, last);
    this.visualAnchorCol = v.anchor.col;
    this._cursorLine = Math.min(v.cursor.line, last);
    this._cursorCol = v.cursor.col;
    this._mode = v.mode;
  }

  private switchVisualMode(target: 'visual' | 'visual-line' | 'visual-block'): void {
    this.keepStickyColumn();
    if (this._mode === target) { this.exitVisual(); return; }
    this._mode = target;
  }

  private selectVisualObject(kind: 'i' | 'a', objectKey: string): void {
    const count = this.takeCount() ?? 1;
    const buf = this.motionBuffer();
    const cursor = { line: this._cursorLine, col: this._cursorCol };
    const sameAsAnchor = cursor.line === this.visualAnchorLine && cursor.col === this.visualAnchorCol;
    if (!sameAsAnchor && (objectKey === 'w' || objectKey === 'W')) {
      const forward = this.visualAnchorLine < cursor.line || (this.visualAnchorLine === cursor.line && this.visualAnchorCol <= cursor.col);
      if (forward) {
        const next = { line: cursor.line, col: cursor.col + 1 };
        const range = textObject(buf, next, kind === 'i', objectKey, count);
        if (range) {
          this._cursorLine = range.end.line;
          this._cursorCol = range.inclusive ? range.end.col : Math.max(0, range.end.col - 1);
        }
      }
      return;
    }
    const range = textObject(buf, cursor, kind === 'i', objectKey, count);
    if (!range) return;
    if (range.partial) {
      if (range.partial.anchor !== null) {
        this.visualAnchorLine = range.partial.anchor.line;
        this.visualAnchorCol = range.partial.anchor.col;
      }
      this._cursorLine = range.end.line;
      this._cursorCol = this.clampCol(range.end.line, range.end.col);
      return;
    }
    this.visualAnchorLine = range.start.line;
    this.visualAnchorCol = range.start.col;
    let endLine = range.end.line;
    let endCol = range.end.col;
    if (range.visualEnd) {
      endLine = range.visualEnd.line;
      endCol = range.visualEnd.col;
    } else if (range.type === 'line') {
      if (this._mode !== 'visual-line') this._mode = 'visual-line';
    } else if (!range.inclusive) {
      if (endCol > 0) endCol--;
      else if (endLine > range.start.line) { endLine--; endCol = Math.max(0, this.line(endLine).length - 1); }
    }
    this._cursorLine = endLine;
    this._cursorCol = endCol;
  }

  private visualRange(op: Operator, lineWise: boolean): OperatorRange {
    const bounds = this.visualBounds();
    const mode = this._mode;
    if (mode === 'visual-line' || lineWise) {
      return {
        start: { line: bounds.startLine, col: this._cursorLine < this.visualAnchorLine ? this.clampCol(bounds.startLine, this._cursorCol) : 0 },
        end: { line: bounds.endLine, col: 0 },
        type: 'line', inclusive: false,
      };
    }
    let end = { line: bounds.endLine, col: bounds.endCol };
    let inclusive = true;
    const text = this.line(end.line);
    if (end.col >= text.length) {
      inclusive = false;
      end = { line: end.line, col: text.length };
      const onLines = op === '<' || op === '>';
      if (!onLines && end.line < this.linesArr.length - 1) end = { line: end.line + 1, col: 0 };
    }
    return { start: { line: bounds.startLine, col: bounds.startCol }, end, type: 'char', inclusive };
  }

  private visualOperate(op: Operator, whole = false): void {
    const count = this.takeCount() ?? 1;
    if (this._mode === 'visual-block') { this.blockOperate(op, whole); return; }
    const range = this.visualRange(op, whole);
    this.exitVisual();
    this.executeOperator(op, range, count, true);
  }

  private visualJoin(withSpaces: boolean): void {
    const bounds = this.visualBounds();
    const startCol = this._mode === 'visual-line' ? 0 : bounds.startCol;
    this.exitVisual();
    const count = Math.max(2, bounds.endLine - bounds.startLine + 1);
    this._cursorLine = bounds.startLine;
    this._cursorCol = this.clampCol(bounds.startLine, startCol);
    this.pendingCountStr = String(count);
    this.joinCommand(withSpaces);
  }

  private visualLineInsert(append: boolean): void {
    const anchorLine = this.visualAnchorLine;
    const cursorLine = this._cursorLine;
    const cursorCol = this._cursorCol;
    this.exitVisual();
    const backwards = cursorLine < anchorLine;
    let line: number;
    let col: number;
    if (append) {
      line = backwards ? anchorLine : cursorLine;
      const text = this.line(line);
      const step = text.codePointAt(cursorCol) !== undefined && text.codePointAt(cursorCol)! > 0xffff ? 2 : 1;
      col = backwards || cursorCol === 0 ? 0 : Math.min(cursorCol + step, text.length);
    } else {
      line = backwards ? cursorLine : anchorLine;
      col = backwards ? Math.min(cursorCol, this.line(line).length) : 0;
    }
    this._cursorLine = line;
    this._cursorCol = col;
    this.pushUndoSnapshot();
    this.insertRepeat = 1;
    this.insertKind = 'i';
    this.insertedText = '';
    this.insertUndoDepth = this.undoStack.length;
    this.enterInsert();
  }

  private visualReplace(k: EditorKeyInput): void {
    const key = k.key === 'Tab' ? '\t' : k.key;
    if (key.length !== 1) { this.exitVisual(); return; }
    const bounds = this.visualBounds();
    const mode = this._mode;
    this.exitVisual();
    this.pushUndoSnapshot();
    for (let i = bounds.startLine; i <= bounds.endLine; i++) {
      const text = this.line(i);
      let from = 0;
      let to = text.length;
      if (mode === 'visual') {
        from = i === bounds.startLine ? bounds.startCol : 0;
        to = i === bounds.endLine ? Math.min(text.length, bounds.endCol + 1) : text.length;
      } else if (mode === 'visual-block') {
        const cols = this.blockColumns(i);
        from = cols.from;
        to = cols.to;
      }
      if (to > from) this.setLine(i, text.slice(0, from) + key.repeat(to - from) + text.slice(to));
    }
    this._cursorLine = bounds.startLine;
    this._cursorCol = mode === 'visual-line' ? 0 : this.clampCol(bounds.startLine, mode === 'visual-block' ? this.blockColumns(bounds.startLine).from : bounds.startCol);
    this._modified = true;
  }

  private visualPut(keepRegister: boolean): void {
    const count = this.takeCount() ?? 1;
    const reg = this.activeRegister();
    const saved = reg ? { linewise: reg.linewise, lines: [...reg.lines] } : null;
    const mode = this._mode;
    const range = this.visualRange('d', false);
    this.exitVisual();
    const before = this.registers.get('"');
    this.executeOperator('d', range, 1, true);
    if (keepRegister && before) this.registers.set('"', before);
    if (!saved || saved.lines.length === 0) return;
    const startCol = range.start.col;
    const startLine = range.start.line;
    const forward = mode === 'visual-line'
      ? this._cursorLine < startLine
      : this._cursorLine === startLine && this._cursorCol < startCol;
    let text = saved;
    if (mode === 'visual-line' && !saved.linewise) text = { linewise: true, lines: saved.lines };
    if (mode === 'visual' && saved.linewise) {
      const current = this.line(this._cursorLine);
      const at = Math.min(current.length, forward ? this._cursorCol + 1 : this._cursorCol);
      const block: string[] = [];
      for (let i = 0; i < count; i++) block.push(...saved.lines);
      this.linesArr.splice(this._cursorLine, 1, current.slice(0, at), ...block, current.slice(at));
      this._cursorLine += 1;
      this._cursorCol = firstNonBlank(this.line(this._cursorLine));
      this._modified = true;
      return;
    }
    const emptied = this.mlEmpty && this.linesArr.length === 1 && this.linesArr[0] === '';
    this.putText(text, forward, count);
    if (emptied && text.linewise && this.linesArr.length > 1) {
      const leftover = forward ? 0 : this.linesArr.length - 1;
      this.linesArr.splice(leftover, 1);
      this._cursorLine = Math.max(0, this._cursorLine - (forward ? 1 : 0));
    }
  }

  private blockCorners(): { top: number; bottom: number; left: number; right: number; toEol: boolean } {
    const top = Math.min(this.visualAnchorLine, this._cursorLine);
    const bottom = Math.max(this.visualAnchorLine, this._cursorLine);
    const anchorText = this.line(this.visualAnchorLine);
    const cursorText = this.line(this._cursorLine);
    const a = cursorVcol(anchorText, this.visualAnchorCol, this.tabstop, false, this.ctrlTab);
    const aEnd = this.charEndVcol(anchorText, this.visualAnchorCol);
    const c = cursorVcol(cursorText, this._cursorCol, this.tabstop, false, this.ctrlTab);
    const cEnd = this.charEndVcol(cursorText, this._cursorCol);
    return {
      top, bottom,
      left: Math.min(a, c),
      right: Math.max(aEnd, cEnd),
      toEol: this.want >= MAXCOL,
    };
  }

  private charEndVcol(text: string, col: number): number {
    let vcol = 0;
    for (let i = 0; i < col && i < text.length; i++) vcol += charCells(text[i], vcol, this.tabstop, this.ctrlTab);
    if (col >= text.length) return vcol;
    const width = charCells(text[col], vcol, this.tabstop, this.ctrlTab);
    return vcol + width - 1;
  }

  private blockColumns(lineIndex: number): { from: number; to: number } {
    const corners = this.blockCorners();
    const text = this.line(lineIndex);
    let vcol = 0;
    let from = text.length;
    let to = text.length;
    let foundFrom = false;
    for (let i = 0; i < text.length; i++) {
      const width = charCells(text[i], vcol, this.tabstop, this.ctrlTab);
      const end = vcol + width - 1;
      if (!foundFrom && end >= corners.left) { from = i; foundFrom = true; }
      if (foundFrom && !corners.toEol && vcol > corners.right) { to = i; break; }
      vcol += width;
    }
    if (!foundFrom) return { from: text.length, to: text.length };
    return { from, to: Math.max(from, to) };
  }

  private blockOperate(op: Operator, whole: boolean): void {
    const corners = this.blockCorners();
    const toEol = whole && (op === 'd' || op === 'c');
    this.exitVisual();
    if (op === '<' || op === '>') { this.shiftRange(corners.top, corners.bottom, op === '>' ? 1 : -1); return; }
    const pieces: string[] = [];
    if (op !== 'y') this.pushUndoSnapshot();
    const startCols: number[] = [];
    for (let i = corners.top; i <= corners.bottom; i++) {
      const text = this.line(i);
      this._cursorLine = corners.top;
      const cols = this.blockColumnsFor(i, corners, toEol);
      pieces.push(text.slice(cols.from, cols.to));
      startCols.push(cols.from);
      if (op === 'y') continue;
      if (op === 'd' || op === 'c') this.setLine(i, text.slice(0, cols.from) + text.slice(cols.to));
      else {
        const segment = text.slice(cols.from, cols.to);
        let converted = segment;
        if (op === 'gu') converted = segment.toLowerCase();
        else if (op === 'gU') converted = segment.toUpperCase();
        else { converted = ''; for (const ch of segment) converted += swapCase(ch); }
        this.setLine(i, text.slice(0, cols.from) + converted + text.slice(cols.to));
      }
    }
    if (op === 'y' || op === 'd' || op === 'c') this.setRegister({ linewise: false, lines: pieces });
    const firstCol = startCols[0] ?? 0;
    this._cursorLine = corners.top;
    this._cursorCol = this.clampCol(corners.top, firstCol);
    if (op !== 'y') this._modified = true;
    if (op === 'c') {
      const lines: number[] = [];
      for (let i = corners.top + 1; i <= corners.bottom; i++) lines.push(i);
      this._cursorCol = firstCol;
      this.blockInsertContext = { lines, col: firstCol, suffixLenAtStart: this.line(corners.top).length - firstCol };
      this.insertRepeat = 1;
      this.insertKind = 'i';
      this.insertedText = '';
      this.insertUndoDepth = -1;
      this.enterInsert();
    }
  }

  private blockColumnsFor(lineIndex: number, corners: { left: number; right: number; toEol: boolean }, toEol: boolean): { from: number; to: number } {
    const text = this.line(lineIndex);
    let vcol = 0;
    let from = text.length;
    let to = text.length;
    let foundFrom = false;
    for (let i = 0; i < text.length; i++) {
      const width = charCells(text[i], vcol, this.tabstop, this.ctrlTab);
      const end = vcol + width - 1;
      if (!foundFrom && end >= corners.left) { from = i; foundFrom = true; }
      if (foundFrom && !(corners.toEol || toEol) && vcol > corners.right) { to = i; break; }
      vcol += width;
    }
    if (!foundFrom) return { from: text.length, to: text.length };
    return { from, to: Math.max(from, to) };
  }

  private beginBlockInsert(append: boolean): void {
    const corners = this.blockCorners();
    this.exitVisual();
    this.pushUndoSnapshot();
    const lines: number[] = [];
    for (let i = corners.top + 1; i <= corners.bottom; i++) lines.push(i);
    let col: number;
    if (append) {
      const cols = this.blockColumnsFor(corners.top, corners, false);
      col = corners.toEol ? this.line(corners.top).length : cols.to;
      if (corners.toEol) {
        this.blockInsertContext = { lines, col, suffixLenAtStart: 0, toEol: true };
      }
    } else {
      col = this.blockColumnsFor(corners.top, corners, false).from;
    }
    this._cursorLine = corners.top;
    this._cursorCol = col;
    this.blockInsertContext ??= { lines, col, suffixLenAtStart: this.line(corners.top).length - col };
    this.blockInsertContext.appendPad = append;
    this.insertRepeat = 1;
    this.insertKind = 'i';
    this.insertedText = '';
    this.insertUndoDepth = -1;
    this.enterInsert();
  }

  // ── INSERT mode ──────────────────────────────────────────────────

  private applyInsertKey(k: EditorKeyInput): void {
    if (k.key === 'Escape' || (k.ctrl && k.key === '[')) {
      this.leaveInsert();
      return;
    }
    const ctrlKey = k.ctrl ? k.key.toLowerCase() : '';
    const atBufferStart = this._cursorLine === 0 && this._cursorCol === 0;
    this.insertKey(k);
    if (k.key === 'Enter' || ctrlKey === 'e' || ctrlKey === 'y') return;
    if (k.key === 'Backspace' || ctrlKey === 'h' || ctrlKey === 'w' || ctrlKey === 'u') {
      if (!atBufferStart && this._cursorCol <= 1) this.autoIndentPending = false;
      return;
    }
    if (ctrlKey === 't' || ctrlKey === 'd') {
      if (/\S/.test(this.line(this._cursorLine))) this.autoIndentPending = false;
      return;
    }
    this.autoIndentPending = false;
  }

  private insertKey(k: EditorKeyInput): void {
    const previousChar = this.lastInsertedChar;
    this.lastInsertedChar = '';
    if (k.ctrl && k.key.toLowerCase() === 'h') { this.insertBackspace(); return; }
    if (k.ctrl && k.key.toLowerCase() === 'w') { this.insertDeleteBack(true); return; }
    if (k.ctrl && k.key.toLowerCase() === 'u') { this.insertDeleteBack(false); return; }
    if (k.ctrl && k.key.toLowerCase() === 't') { this.insertShiftIndent(false); return; }
    if (k.ctrl && k.key.toLowerCase() === 'd') { this.insertUnindent(previousChar); return; }
    if (k.ctrl && k.key.toLowerCase() === 'e') { this.insertCopyAdjacent(true); return; }
    if (k.ctrl && k.key.toLowerCase() === 'y') { this.insertCopyAdjacent(false); return; }
    if (k.ctrl && LITERAL_INSERT_CONTROLS.has(k.key.toLowerCase())) { this.insertCharacter(String.fromCharCode(k.key.toLowerCase().charCodeAt(0) - 96)); return; }

    switch (k.key) {
      case 'Backspace': this.insertBackspace(); return;
      case 'Enter': this.insertNewline(); this.insertedText += '\n'; return;
      case 'Tab': this.insertTabKey(); return;
      case 'ArrowLeft': this.insertCursorMove(() => { this._cursorCol = charStartBefore(this.line(this._cursorLine), this._cursorCol); }); return;
      case 'ArrowRight': this.insertCursorMove(() => { this._cursorCol = Math.min(this.line(this._cursorLine).length, this._cursorCol + charLengthAt(this.line(this._cursorLine), this._cursorCol)); }); return;
      case 'Home': this.insertCursorMove(() => { this._cursorCol = 0; }); return;
      case 'End': this.insertCursorMove(() => { this._cursorCol = this.line(this._cursorLine).length; }); return;
      case 'ArrowUp': case 'ArrowDown': this.insertVerticalMove(k.key === 'ArrowDown'); return;
      case 'PageUp': case 'PageDown': this.pageScroll(k.key === 'PageDown'); return;
      case 'Delete': this.insertDeleteForward(); return;
      default:
        if (k.key.length === 1 && !k.ctrl && !k.alt) this.insertCharacter(k.key);
        return;
    }
  }

  private insertShiftIndent(left: boolean): void {
    const text = this.line(this._cursorLine);
    const indent = roundedIndent(indentWidth(text, this.tabstop).width, this.options.shiftwidth, left);
    const edit = reindentLine(text, this._cursorCol, this.tabstop, indent, this.options.expandtab);
    this.setLine(this._cursorLine, edit.line);
    this._cursorCol = edit.col;
    this._modified = true;
  }

  private insertUnindent(previousChar: string): void {
    const text = this.line(this._cursorLine);
    const col = this._cursorCol;
    if ((previousChar === '0' || previousChar === '^') && col > 0 && text[col - 1] === previousChar) {
      const stripped = text.slice(0, col - 1) + text.slice(col);
      const edit = reindentLine(stripped, col - 1, this.tabstop, 0, this.options.expandtab);
      this.setLine(this._cursorLine, edit.line);
      this._cursorCol = edit.col;
      this._modified = true;
      return;
    }
    this.insertShiftIndent(true);
  }

  private insertCopyAdjacent(below: boolean): void {
    const neighbourLine = this._cursorLine + (below ? 1 : -1);
    if (neighbourLine < 0 || neighbourLine >= this.linesArr.length) return;
    const neighbour = this.line(neighbourLine);
    const target = this.vcolAt(this.line(this._cursorLine), this._cursorCol, false);
    if (target >= this.vcolAt(neighbour, neighbour.length, false)) return;
    const index = colAtVcol(neighbour, target, this.tabstop, false, this.ctrlTab);
    this.insertCharacter(String.fromCodePoint(neighbour.codePointAt(index)!));
  }

  private insertCharacter(ch: string): void {
    this.lastInsertedChar = ch;
    this.autoIndentPending = false;
    const l = this.line(this._cursorLine);
    if (this.replaceMode) {
      const original = this._cursorCol < l.length ? l[this._cursorCol] : null;
      this.replacedOriginals.push(original);
      this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + ch + l.slice(this._cursorCol + (original === null ? 0 : 1)));
      this._cursorCol++;
      this._modified = true;
      this.insertedText += ch;
      this.armShowMatch(ch, this._cursorCol - 1);
      return;
    }
    this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + ch + l.slice(this._cursorCol));
    this._cursorCol += ch.length;
    this._modified = true;
    this.insertedText += ch;
    if (ch === ' ') this.typedSpace = true;
    this.armShowMatch(ch, this._cursorCol - ch.length);
  }

  private armShowMatch(ch: string, col: number): void {
    if (!this.options.bool('showmatch')) return;
    const pairs = parseMatchPairs(this.options.string('matchpairs'));
    if (!Object.values(pairs).includes(ch)) return;
    const hit = findMatchingBracket(this.motionBuffer(), { line: this._cursorLine, col });
    if (hit === null || hit.line < this.window.top || hit.line >= this.window.botLine) return;
    if (!this.window.wraps) {
      const left = this.window.leftCol;
      const virt = this.window.virtColumn(hit.line, hit.col, false);
      if (virt < left || virt >= left + this.window.textWidth) return;
    }
    this.matchJump = hit;
  }

  private insertTabKey(): void {
    if (!this.options.expandtab && this.options.softtabstop === 0) { this.insertCharacter('\t'); return; }
    const before = this.line(this._cursorLine);
    const col = this._cursorCol;
    let replacing: { floor: number } | null = null;
    if (this.replaceMode) {
      replacing = { floor: this.insertStart.line === this._cursorLine ? this.insertStart.col : 0 };
      const spaces = tabSpaces(before, col, this.tabSettings());
      for (let i = 0; i < spaces; i++) this.replacedOriginals.push(i === 0 && col < before.length ? before[col] : null);
    }
    const edit = insertTab(before, col, this.tabSettings(), replacing);
    if (this.insertStart.line === this._cursorLine && edit.from < this.insertStart.col) this.insertStart = { line: this._cursorLine, col: edit.from };
    this.setLine(this._cursorLine, edit.line);
    this.insertedText += '\t';
    this.autoIndentPending = false;
    this._cursorCol = edit.col;
    this._modified = true;
    this.typedSpace = false;
  }

  private insertNewline(): void {
    const l = this.line(this._cursorLine);
    let before = l.slice(0, this._cursorCol);
    let after = l.slice(this._cursorCol);
    const indent = this.indentFor(before);
    if (this.options.bool('autoindent')) {
      after = after.replace(/^[ \t]+/, '');
      if (this.autoIndentPending) before = before.replace(/[ \t]+$/, '');
    }
    this.linesArr.splice(this._cursorLine, 1, before, indent + after);
    this._cursorLine++;
    this._cursorCol = indent.length;
    this._modified = true;
    this.insertTouched = true;
    this.autoIndentPending = this.options.bool('autoindent');
  }

  private indentFor(text: string): string {
    if (!this.options.bool('autoindent')) return '';
    return indentString(indentWidth(text, this.tabstop).width, this.tabstop, this.options.expandtab);
  }

  private insertCursorMove(move: () => void): void {
    move();
    this.insertRepeat = 1;
    this.insertedText = '';
    this.insertUndoDepth = -1;
  }

  private insertVerticalMove(down: boolean): void {
    const target = down ? Math.min(this.linesArr.length - 1, this._cursorLine + 1) : Math.max(0, this._cursorLine - 1);
    const want = this.currentWant();
    const text = this.line(target);
    let col = colAtVcol(text, want, this.tabstop, true, this.ctrlTab);
    if (want >= MAXCOL) col = text.length;
    this.insertCursorMove(() => { this._cursorLine = target; this._cursorCol = col; });
  }

  private insertDeleteForward(): void {
    const l = this.line(this._cursorLine);
    if (this._cursorCol < l.length) {
      this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + l.slice(this._cursorCol + charLengthAt(l, this._cursorCol)));
    } else if (this._cursorLine < this.linesArr.length - 1) {
      this.setLine(this._cursorLine, l + this.line(this._cursorLine + 1));
      this.linesArr.splice(this._cursorLine + 1, 1);
    }
    this._modified = true;
    this.insertTouched = true;
  }

  private trimAutoIndent(): void {
    const original = this.line(this._cursorLine);
    let text = original;
    let at = Math.min(this._cursorCol, text.length);
    for (;;) {
      if (at >= text.length && at > 0) at--;
      if (!isWhite(text[at])) break;
      text = text.slice(0, at) + text.slice(at + 1);
    }
    if (text !== original) this.explicitWant = cursorVcol(original, this._cursorCol, this.tabstop, false, this.ctrlTab);
    if (text[at] !== undefined && at + 1 >= text.length) at++;
    this.setLine(this._cursorLine, text);
    this._cursorCol = at;
  }

  private leaveInsert(): void {
    if (this.autoIndentPending) { this.trimAutoIndent(); this.autoIndentPending = false; }
    if (this.blockInsertContext) this.finishBlockInsert();
    const text = this.insertedText;
    const repeat = this.insertRepeat;
    this.insertRepeat = 1;
    if (repeat > 1 && (text.length > 0 || this.insertKind !== 'i')) {
      for (let i = 1; i < repeat; i++) {
        if (this.insertKind !== 'i') this.insertNewline();
        for (const ch of text) {
          if (ch === '\n') this.insertNewline();
          else if (ch === '\t') this.insertTabKey();
          else this.insertCharacter(ch);
        }
      }
    }
    if (this.insertUndoDepth >= 0 && this.undoStack.length === this.insertUndoDepth && !this.insertTouched) {
      this.undoStack.pop();
    }
    this.insertUndoDepth = -1;
    this.insertedText = '';
    this.replaceMode = false;
    this.replacedOriginals = [];
    this._cursorCol = charStartBefore(this.line(this._cursorLine), this._cursorCol);
    this._mode = 'normal';
    this._message = '';
  }

  private insertBackspace(): void {
    if (this.replaceMode) {
      if (this.replacedOriginals.length > 0 && this._cursorCol > 0) {
        const original = this.replacedOriginals.pop() ?? null;
        const l = this.line(this._cursorLine);
        this.setLine(this._cursorLine, l.slice(0, this._cursorCol - 1) + (original ?? '') + l.slice(this._cursorCol));
        this._cursorCol--;
        this.insertedText = this.insertedText.slice(0, -1);
      } else if (this._cursorCol > 0) {
        this._cursorCol--;
      } else if (this._cursorLine > 0) {
        this._cursorLine--;
        this._cursorCol = this.line(this._cursorLine).length;
      }
      return;
    }
    this.insertedText = this.insertedText.slice(0, -1);
    const soft = softBackspace(this.line(this._cursorLine), this._cursorCol, this.tabSettings(), this.typedSpace);
    if (soft) {
      this.typedSpace = false;
      this.setLine(this._cursorLine, soft.line);
      this._cursorCol = soft.col;
      this._modified = true;
    } else if (this._cursorCol > 0) {
      const l = this.line(this._cursorLine);
      const start = charStartBefore(l, this._cursorCol);
      this.setLine(this._cursorLine, l.slice(0, start) + l.slice(this._cursorCol));
      this._cursorCol = start;
      this._modified = true;
    } else if (this._cursorLine > 0) {
      const prevLen = this.line(this._cursorLine - 1).length;
      this.linesArr[this._cursorLine - 1] += this.line(this._cursorLine);
      this.linesArr.splice(this._cursorLine, 1);
      if (this.insertStart.line === this._cursorLine) this.insertStart = { line: this._cursorLine - 1, col: prevLen };
      this._cursorLine--;
      this._cursorCol = prevLen;
      this._modified = true;
      this.insertTouched = true;
      this.autoIndentPending = false;
    }
  }

  private insertDeleteBack(word: boolean): void {
    if (this._cursorCol === 0) {
      this.insertBackspace();
      return;
    }
    const text = this.line(this._cursorLine);
    const lead = indentWidth(text, this.tabstop).chars;
    const floor = !word && this.options.bool('autoindent') && this._cursorCol > lead ? lead : 0;
    const stopAt = this.insertStart.line === this._cursorLine ? this.insertStart.col : -1;
    const target = backspaceTarget(text, this._cursorCol, floor, stopAt, word, this.words);
    this.setLine(this._cursorLine, text.slice(0, target) + text.slice(this._cursorCol));
    this._cursorCol = target;
    if (this.insertStart.line === this._cursorLine && target < this.insertStart.col) this.insertStart = { line: this._cursorLine, col: target };
    this.typedSpace = false;
    this._modified = true;
  }

  private finishBlockInsert(): void {
    const ctx = this.blockInsertContext!;
    this.blockInsertContext = null;
    const topLine = this.line(this._cursorLine);
    const insertedEnd = topLine.length - ctx.suffixLenAtStart;
    const insertedText = topLine.slice(ctx.col, Math.max(ctx.col, insertedEnd));
    if (!insertedText) return;
    for (const lineIdx of ctx.lines) {
      const l = this.line(lineIdx);
      if (ctx.toEol) {
        this.setLine(lineIdx, l + insertedText);
      } else if (l.length < ctx.col) {
        if (!ctx.appendPad) continue;
        this.setLine(lineIdx, l + ' '.repeat(ctx.col - l.length) + insertedText);
      } else {
        this.setLine(lineIdx, l.slice(0, ctx.col) + insertedText + l.slice(ctx.col));
      }
    }
    this._modified = true;
  }

  // ── COMMAND-LINE (ex) mode ──────────────────────────────────────

  private applyCommandKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      if (this.commandBuffer) this.commandHistoryList.push(this.commandBuffer);
      this.historyNavIndex = null;
      this.finishIncSearch(false);
      this.window.noteWholeLineEdit();
      const before = this.linesArr.join('\n');
      const undoBase = this.undoStack.length;
      this.executeExCommand(this.commandBuffer);
      if (this.substitution === null && this.globalRun === null && this.undoStack.length > undoBase + 1) this.undoStack.splice(undoBase + 1);
      if (this.cmdlineColumn !== null && this.linesArr.join('\n') !== before) this.cmdlineColumn = null;
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && (k.key === 'c' || k.key === '[')) || (k.key === 'Backspace' && this.commandBuffer === '')) {
      this.finishIncSearch(true);
      this._mode = 'normal';
      this.commandBuffer = '';
      this.historyNavIndex = null;
      return;
    }
    if (k.key === 'ArrowUp') {
      this.commandBuffer = this.recallHistory(this.commandHistoryList, this.commandBuffer);
      this.refreshIncSearch();
      return;
    }
    if (k.key === 'ArrowDown') {
      this.commandBuffer = this.advanceHistory(this.commandHistoryList, this.commandBuffer);
      this.refreshIncSearch();
      return;
    }
    if (k.key === 'Backspace') {
      this.commandBuffer = this.commandBuffer.slice(0, -1);
      this.refreshIncSearch();
      return;
    }
    if (k.ctrl) return;
    if (k.key.length === 1) {
      this.commandBuffer += k.key;
      this.refreshIncSearch();
    }
  }

  /** Up in a `:`/`/` prompt: step back into `history`, stashing `current` (the in-progress line) the first time. Returns the buffer text to show. */
  private recallHistory(history: readonly string[], current: string): string {
    if (this.historyNavIndex === null) {
      if (history.length === 0) return current;
      this.historyNavStash = current;
      this.historyNavIndex = history.length - 1;
    } else if (this.historyNavIndex > 0) {
      this.historyNavIndex--;
    }
    return history[this.historyNavIndex];
  }

  /** Down in a `:`/`/` prompt: step forward through `history`, restoring the stashed in-progress line past the newest entry. */
  private advanceHistory(history: readonly string[], current: string): string {
    if (this.historyNavIndex === null) return current;
    if (this.historyNavIndex < history.length - 1) {
      this.historyNavIndex++;
      return history[this.historyNavIndex];
    }
    this.historyNavIndex = null;
    return this.historyNavStash;
  }

  /** Expand a bare `%` to the current file path in `:!cmd`/`:r !cmd`, like real vim. `\%` is a literal percent. */
  private expandPercent(cmd: string): string {
    return cmd.replace(/\\%|%/g, (m) => (m === '%' ? this.filePath : '%'));
  }

  /**
   * Real vim's `filetype` autodetection is driven by a large, pluggable
   * table (filetype.vim) keyed on path/extension patterns. This models
   * just the handful of system-config detections the standard
   * distribution ships with — anything vim itself would recognize
   * out of the box, no custom ftdetect required.
   */
  private detectFiletype(): string {
    const path = this.filePath;
    if (/(^|\/)fstab$/.test(path)) return 'fstab';
    if (/(^|\/)crontab$/.test(path) || /\/cron\.d\//.test(path) || /(^|\/)crontab\.\d+$/.test(path)) return 'crontab';
    if (/(^|\/)sshd_config(\.d\/.*\.conf)?$/.test(path)) return 'sshconfig';
    if (/(^|\/)ssh_config$/.test(path)) return 'sshconfig';
    if (/(^|\/)hosts$/.test(path)) return 'hostsfile';
    if (/\/network\/interfaces(\.d\/.*)?$/.test(path)) return 'interfaces';
    if (/(^|\/)resolv\.conf$/.test(path)) return 'resolv';
    if (/(^|\/)sudoers(\.d\/.*)?$/.test(path)) return 'sudoers';
    if (/(^|\/)passwd$/.test(path)) return 'passwd';
    if (/(^|\/)group$/.test(path)) return 'group';
    if (/\.sh$/.test(path)) return 'sh';
    if (/\.ya?ml$/.test(path)) return 'yaml';
    if (/\.conf$/.test(path)) return 'conf';
    return '';
  }

  /** Parse an optional leading ex range (`%`, `N`, `N,M`, `$`, `.`, `'<,'>`) off a command string. */
  private rangeEnvironment(preview: boolean): RangeEnvironment {
    return {
      lineCount: this.linesArr.length,
      cursorLine: this._cursorLine + 1,
      mark: (name) => {
        const position = this.patternMark(name);
        return position === null ? null : position.line + 1;
      },
      search: (pattern, forward, fromLine) => this.searchAddress(pattern, forward, fromLine, preview),
      repeatSearch: (source, forward, fromLine) => {
        const pattern = source === 'substitute' ? this.substitutePattern : this.searchSlotPattern;
        if (pattern === null) {
          return { error: source === 'substitute' ? 'E33: No previous substitute regular expression' : 'E35: No previous regular expression' };
        }
        return this.searchAddress(pattern, forward, fromLine, preview);
      },
    };
  }

  private searchAddress(pattern: string, forward: boolean, fromLine: number, preview: boolean): { line: number } | { error: string } {
    const remembered = pattern === '' ? this.lastSearch?.pattern ?? '' : pattern;
    if (remembered === '') return { error: 'E35: No previous regular expression' };
    if (!preview) this.rememberSearchPattern(remembered);
    const refusal = searchPatternError(remembered, this.searchIgnoresCase(remembered), this.patternContext());
    if (refusal !== null) return { error: refusal };
    const lineIndex = Math.max(fromLine - 1, 0);
    const origin = forward && fromLine > 0
      ? { line: lineIndex, col: (this.linesArr[lineIndex] ?? '').length }
      : { line: lineIndex, col: 0 };
    const found = findMatch(this.linesArr, fromLine <= 0 && forward ? { line: 0, col: -1 } : origin, remembered, {
      forward, count: 1, wrapscan: this.options.bool('wrapscan'), anchor: 'start',
      ignoreCase: this.searchIgnoresCase(remembered), context: this.patternContext(),
    });
    if (found === null) return { error: this.searchFailure(remembered, forward) };
    return { line: found.start.line + 1 };
  }

  private parseExRange(s: string, preview = false): ExRange {
    const parsed = parseRange(s, this.rangeEnvironment(preview));
    if (!preview && parsed.cursorAfter !== null) this._cursorLine = Math.max(0, Math.min(parsed.cursorAfter - 1, this.linesArr.length - 1));
    if (parsed.error !== null) return { start: null, end: null, rest: parsed.rest, literal: parsed.literal, error: parsed.error };
    if (parsed.addressCount === 0 || parsed.first === null || parsed.last === null) {
      return { start: null, end: null, rest: parsed.rest, literal: parsed.literal };
    }
    return { start: parsed.first - 1, end: parsed.last - 1, rest: parsed.rest, literal: parsed.literal };
  }

  private applyRangeCommand(range: ExRange, verbe: string, cible: string): boolean {
    const lo = Math.max(0, range.start ?? this._cursorLine);
    const hi = Math.max(0, range.end ?? range.start ?? this._cursorLine);

    if (verbe === 'd' || verbe === 'y') {
      this.deleteExRange(range, verbe === 'y');
      return true;
    }
    if (verbe === 'j') {
      const fin = range.start === null ? Math.min(lo + 1, this.linesArr.length - 1) : hi;
      if (fin <= lo) { this._message = ''; return true; }
      this.pushUndoSnapshot();
      const joint = this.linesArr.slice(lo, fin + 1)
        .map((l, i) => (i === 0 ? l : l.replace(/^\s+/, ''))).join(' ');
      this.linesArr.splice(lo, fin - lo + 1, joint);
      this._cursorLine = lo;
      this._cursorCol = 0;
      this._modified = true;
      this._message = '';
      return true;
    }
    if (verbe === '>' || verbe === '<') {
      this.pushUndoSnapshot();
      for (let i = lo; i <= hi && i < this.linesArr.length; i++) {
        this.linesArr[i] = verbe === '>'
          ? `\t${this.linesArr[i]}`
          : this.linesArr[i].replace(/^(\t| {1,8})/, '');
      }
      this._cursorLine = lo;
      this._modified = true;
      this._message = '';
      return true;
    }

    const destination = this.resolveExAddress(cible);
    if (destination === null) return false;
    const bloc = this.linesArr.slice(lo, hi + 1);
    this.pushUndoSnapshot();
    if (verbe === 'm') {
      this.linesArr.splice(lo, hi - lo + 1);
      const decale = destination > hi ? destination - bloc.length : destination;
      this.linesArr.splice(decale + 1, 0, ...bloc);
      this._cursorLine = Math.min(decale + bloc.length, this.linesArr.length - 1);
    } else {
      this.linesArr.splice(destination + 1, 0, ...bloc);
      this._cursorLine = Math.min(destination + bloc.length, this.linesArr.length - 1);
    }
    this._cursorCol = 0;
    this._modified = true;
    this._message = '';
    return true;
  }

  private resolveExAddress(token: string): number | null {
    if (token === '$') return this.linesArr.length - 1;
    if (token === '.') return this._cursorLine;
    if (/^\d+$/.test(token)) {
      const n = parseInt(token, 10) - 1;
      return n >= -1 && n <= this.linesArr.length - 1 ? n : null;
    }
    return null;
  }

  private deleteExRange(range: ExRange, yankOnly: boolean): void {
    const lo = Math.max(0, range.start ?? this._cursorLine);
    const hi = Math.max(0, range.end ?? range.start ?? this._cursorLine);
    const cut = this.linesArr.slice(lo, hi + 1);
    this.registers.set('"', { lines: [...cut], linewise: true });
    if (yankOnly) {
      this._message = '';
      return;
    }
    this.pushUndoSnapshot();
    const before = this.linesArr.length;
    this.linesArr.splice(lo, hi - lo + 1);
    if (this.linesArr.length === 0) this.linesArr.push('');
    this._cursorLine = Math.min(lo, this.linesArr.length - 1);
    this._cursorCol = this.beginLineColumn(this._cursorLine);
    this._modified = true;
    this._message = this.fewerLinesMessage(before - this.linesArr.length);
  }

  private fewerLinesMessage(removed: number): string {
    if (removed <= this.options.number('report')) return '';
    return removed === 1 ? '1 line less' : `${removed} fewer lines`;
  }

  private parseGlobalCmd(s: string): { inverse: boolean; pattern: string; command: string } | null {
    const head = /^(g(?:l(?:o(?:b(?:a(?:l)?)?)?)?)?|v(?:g(?:l(?:o(?:b(?:a(?:l)?)?)?)?)?)?)(!)?\s*([^\w\s"|\\])/.exec(s);
    if (head === null) return null;
    const delimiter = head[3];
    const start = head[0].length;
    const end = skipRegexp(s, start, delimiter);
    return {
      inverse: head[1].startsWith('v') || head[2] === '!',
      pattern: s.slice(start, end),
      command: end < s.length ? s.slice(end + 1) : '',
    };
  }

  protected executeExCommand(raw: string, swapped = false): void {
    const trimmed = raw.trim().replace(/^[:\s]+/, '');
    const range = this.parseExRange(trimmed);
    if (range.error !== undefined) {
      this._message = range.error;
      this._mode = 'normal';
      return;
    }
    if (range.start !== null && range.end !== null && range.rest.trim() !== '') {
      if (range.start > range.end && !swapped && this.globalRun === null) {
        this.pendingBackwardsRange = trimmed;
        this._message = '';
        this._mode = 'ask-swap-range';
        return;
      }
      if (swapped) [range.start, range.end] = [range.end, range.start];
      const lastLine = this.linesArr.length - 1;
      if (range.start < -1 || range.end < -1 || range.start > range.end || range.end > lastLine) {
        this._message = 'E16: Invalid range';
        this._mode = 'normal';
        return;
      }
    }
    const { start: rangeStart, end: rangeEnd, rest } = range;

    const ligne = rest.trim();
    if (ligne === '') {
      if (range.end !== null) {
        this.gotoLine(range.end);
        this._message = '';
      }
      this._mode = 'normal';
      return;
    }
    if (range.literal !== '' && (SET_COMMAND.test(ligne) || isAbbreviation(ligne, 'nohlsearch', 3))) {
      this._message = 'E481: No range allowed';
      this._mode = 'normal';
      return;
    }
    const parPlage = ligne.match(/^([dy]|j|[<>]|m|co?|t)\s*(\S*)$/);
    if (parPlage !== null && (parPlage[2] === '' || /^(m|co?|t)$/.test(parPlage[1]))) {
      const applique = this.applyRangeCommand(range, parPlage[1], parPlage[2]);
      if (applique) {
        this._mode = 'normal';
        return;
      }
    }

    const variableCommand = ligne.match(/^(let|unl(?:e(?:t)?)?)(!?)(?:\s+(.*))?$/s);
    if (variableCommand !== null) {
      this.runVariableCommand(variableCommand[1], variableCommand[2] === '!', variableCommand[3] ?? '');
      return;
    }

    const global = this.parseGlobalCmd(rest);
    if (global !== null) {
      if (global.pattern !== '') this.rememberSearchPattern(global.pattern);
      if (this.refusesPattern(global.pattern, this.searchIgnoresCase(global.pattern))) {
        this._mode = 'normal';
        return;
      }
      this.pushUndoSnapshot();
      this.executeGlobal(rangeStart ?? 0, rangeEnd ?? this.linesArr.length - 1, global.pattern, global.command, global.inverse);
      this._mode = 'normal';
      return;
    }

    // :!cmd (shell escape, no range) vs :%!cmd / :N,M!cmd (filter the range
    // through an external command, replacing its content with the output).
    if (rest.startsWith('!')) {
      const cmdStr = this.expandPercent(rest.slice(1).trim());
      if (rangeStart !== null) {
        this.pushUndoSnapshot();
        const lo = Math.max(0, Math.min(rangeStart, rangeEnd ?? rangeStart));
        const hi = Math.min(this.linesArr.length - 1, Math.max(rangeStart, rangeEnd ?? rangeStart));
        const input = this.linesArr.slice(lo, hi + 1).join('\n') + '\n';
        const output = this.fs.filterThroughShell(cmdStr, input);
        const body = output.endsWith('\n') ? output.slice(0, -1) : output;
        const outLines = body.length === 0 ? [''] : body.split('\n');
        this.linesArr.splice(lo, hi - lo + 1, ...outLines);
        this._cursorLine = Math.min(lo, this.linesArr.length - 1);
        this._cursorCol = 0;
        this._modified = true;
        this._message = '';
      } else {
        this._shellOutput = this.fs.runShellCommand(cmdStr);
        this._message = `!${cmdStr}`;
      }
      this._mode = 'normal';
      return;
    }

    // :r file / :r !cmd — read a file's (or a command's stdout's) content
    // into the buffer, inserted below the cursor line.
    if (rest.startsWith('r ') || rest === 'r') {
      const arg = rest.slice(1).trim();
      this.pushUndoSnapshot();
      let newLines: string[];
      if (arg.startsWith('!')) {
        const output = this.fs.runShellCommand(this.expandPercent(arg.slice(1).trim()));
        const body = output.endsWith('\n') ? output.slice(0, -1) : output;
        newLines = body.length === 0 ? [] : body.split('\n');
      } else {
        const content = this.fs.readFile(arg);
        if (content === null) {
          this.undoStack.pop(); // nothing actually changed
          this._message = `E484: Can't open file ${arg}`;
          this._mode = 'normal';
          return;
        }
        const body = content.endsWith('\n') ? content.slice(0, -1) : content;
        newLines = body.length === 0 ? [] : body.split('\n');
      }
      const at = rangeStart !== null ? rangeStart : this._cursorLine;
      this.linesArr.splice(at + 1, 0, ...newLines);
      this._modified = true;
      this._message = `${newLines.length} more line${newLines.length === 1 ? '' : 's'}`;
      this._mode = 'normal';
      return;
    }

    const normal = /^norm(?:a(?:l)?)?(!)?(?:\s+(.*))?$/.exec(rest.trimStart());
    if (normal !== null) {
      this.executeNormalCommand(normal[2] ?? '', rangeStart, rangeEnd);
      return;
    }

    const substitute = this.substituteCommandName(rest.trimStart());
    if (substitute !== null) {
      this.executeSubstitute(substitute.name, substitute.argument, range);
      return;
    }

    if (trimmed === 'w' || trimmed === 'write') {
      this.writeFile(this.filePath, false);
      this._mode = 'normal';
      return;
    }
    if (trimmed.startsWith('w ')) {
      this.writeFile(trimmed.slice(2).trim(), false);
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'w!') {
      this.writeFile(this.filePath, true);
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'q' || trimmed === 'quit') {
      if (this._modified) {
        this._message = 'E37: No write since last change (add ! to override)';
        this._mode = 'normal';
      } else {
        this.finishExit(true);
      }
      return;
    }
    if (trimmed === 'q!' || trimmed === 'quit!') {
      this.finishExit(false);
      return;
    }
    if (trimmed === 'wq' || trimmed === 'x' || trimmed === 'xit') {
      if (this.writeFile(this.filePath, false)) this.finishExit(true);
      else this._mode = 'normal';
      return;
    }
    if (trimmed === 'wq!') {
      if (this.writeFile(this.filePath, true)) this.finishExit(true);
      else this._mode = 'normal';
      return;
    }
    if (trimmed === 'registers' || trimmed === 'reg' || trimmed.startsWith('registers ') || trimmed.startsWith('reg ')) {
      const filterArg = trimmed.includes(' ') ? trimmed.slice(trimmed.indexOf(' ') + 1).trim() : '';
      const names = filterArg
        ? filterArg.split('')
        : [...this.registers.keys()].sort();
      const rows = names
        .map((n) => ({ n, text: this.registerText(n) }))
        .filter((r) => r.text !== null)
        .map((r) => `"${r.n}   ${(r.text as string).replace(/\n/g, '^J')}`);
      this._registersOutput = ['--- Registers ---', ...rows].join('\n');
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'marks') {
      const rows = [...this.marks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, pos]) => ` ${name}   ${pos.line + 1}   ${pos.col}  ${this.line(pos.line).trim()}`);
      this._marksOutput = ['mark line  col file/text', ...rows].join('\n');
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (isAbbreviation(trimmed, 'nohlsearch', 3)) {
      this.noHlsearch = true;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    const setCommand = SET_COMMAND.exec(trimmed);
    if (setCommand) {
      const name = setCommand[1];
      const scope = name.startsWith('setl') ? 'setlocal' : name.startsWith('setg') ? 'setglobal' : 'set';
      this._message = this.options.apply(setCommand[2] ?? '', scope).message;
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'syntax on' || trimmed === 'syntax off') {
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === '$') {
      this.gotoLine(this.linesArr.length - 1);
      this._message = '';
      this._mode = 'normal';
      return;
    }
    const lineNum = /^[0-9]+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
    if (!isNaN(lineNum) && lineNum > 0) {
      this.gotoLine(lineNum - 1);
      this._message = '';
      this._mode = 'normal';
      return;
    }

    this._message = `E492: Not an editor command: ${trimmed}`;
    this._mode = 'normal';
  }

  private writeFile(path: string, force: boolean): boolean {
    if (path === '') {
      this._message = 'E32: No file name';
      return false;
    }
    if (this._readOnly && !force) {
      this._message = "E45: 'readonly' option is set (add ! to override)";
      return false;
    }
    const terminator = ({ unix: '\n', dos: '\r\n', mac: '\r' } as const)[this.fileFormat] ?? '\n';
    const body = `${this.linesArr.join(terminator)}${terminator}`;
    const ok = this.fs.writeFile(path, body);
    if (!ok) {
      this._message = `E212: Can't open file for writing`;
      return false;
    }
    this._modified = false;
    // Real vim reports the byte count actually written (UTF-8), not the
    // in-memory JS string length — they diverge for any multi-byte char.
    const byteLength = new TextEncoder().encode(body).length;
    this._message = `"${path === this.filePath ? this.shownName : path}" ${this.linesArr.length}L, ${byteLength}B written`;
    return true;
  }

  // ── :s substitution (non-interactive) ──────────────────────────────

  private patternContext(): PatternContext {
    const live = this._mode === 'visual' || this._mode === 'visual-line' || this._mode === 'visual-block';
    return {
      lines: this.linesArr,
      tabstop: this.tabstop,
      cursor: { line: this._cursorLine, col: this._cursorCol },
      mark: (name) => this.patternMark(name),
      lastSubstitute: this.substituteMemory.previousExpansion,
      words: this.words,
      visual: live
        ? { mode: this._mode as 'visual' | 'visual-line' | 'visual-block', anchor: { line: this.visualAnchorLine, col: this.visualAnchorCol }, cursor: { line: this._cursorLine, col: this._cursorCol } }
        : this.lastVisual,
    };
  }

  private patternMark(name: string): { line: number; col: number } | null {
    if (name === "'" || name === '`') return this.lastJumpPosition;
    if (name === '<' || name === '>') {
      const area = this.lastVisual;
      if (area === null) return null;
      const forward = area.anchor.line < area.cursor.line || (area.anchor.line === area.cursor.line && area.anchor.col <= area.cursor.col);
      return (name === '<') === forward ? area.anchor : area.cursor;
    }
    return this.marks.get(name) ?? null;
  }

  private substituteIgnoresCase(override: '' | 'i' | 'I', pattern: string): boolean {
    if (override === 'i') return true;
    if (override === 'I') return false;
    return this.searchIgnoresCase(pattern);
  }

  private searchIgnoresCase(pattern: string, noSmartcase = false): boolean {
    const ignore = this.options.bool('ignorecase');
    if (ignore && !noSmartcase && this.options.bool('smartcase')) return !patternHasUppercase(pattern);
    return ignore;
  }

  private refusesPattern(pattern: string, ignoreCase: boolean): boolean {
    const error = searchPatternError(pattern, ignoreCase, this.patternContext());
    if (error === null) return false;
    this._message = error;
    return true;
  }

  private repeatSubstituteKey(command: string): void {
    this.pendingCountStr = '';
    this.executeExCommand(command);
  }

  private beginLineColumn(line: number): number {
    const text = this.linesArr[line] ?? '';
    const column = firstNonBlank(text);
    return column >= text.length && text.length > 0 ? text.length - 1 : column;
  }

  private substituteCommandName(rest: string): { name: 's' | '&' | '~'; argument: string } | null {
    if (rest.startsWith('&')) return { name: '&', argument: rest.slice(1) };
    if (rest.startsWith('~')) return { name: '~', argument: rest.slice(1) };
    const spelled = /^s(?:u(?:b(?:s(?:t(?:i(?:t(?:u(?:t(?:e)?)?)?)?)?)?)?)?)?(?![A-Za-z])/.exec(rest);
    if (spelled !== null) return { name: 's', argument: rest.slice(spelled[0].length) };
    if (/^s[cgiIr]/.test(rest) && !/^s(?:re|cr|cs|im|ig|il)/.test(rest)) return { name: 's', argument: rest.slice(1) };
    return null;
  }

  private executeSubstitute(name: 's' | '&' | '~', argument: string, range: ExRange): void {
    const outcome = parseSubstitute(name, argument.trimStart(), this.substituteMemory, this.options.bool('gdefault'));
    this._mode = 'normal';
    if ('error' in outcome) {
      this._message = outcome.error;
      return;
    }
    const parsed = outcome.parsed;
    const total = this.linesArr.length;
    let first = (range.start ?? this._cursorLine) + 1;
    let last = (range.end ?? this._cursorLine) + 1;
    if (first > total || last > total) {
      this._message = 'E16: Invalid range';
      return;
    }
    if (first > last) [first, last] = [last, first];
    if (first < 1) first = 1;
    if (last < 1) last = 1;
    const global = this.globalRun;
    if (!global) {
      this.substitutionCount = 0;
      this.substitutionLines = 0;
      this.expressionError = null;
    }

    if (parsed.join) {
      this.joinForSubstitute(first, last, parsed.joinFlag);
      return;
    }
    if (parsed.count !== null) {
      first = last;
      last = Math.min(last + parsed.count - 1, total);
    }

    const flags = this.substituteMemory.flags;
    let pattern: string;
    if (parsed.pattern === null || parsed.pattern === '') {
      const remembered = parsed.source === 'last' ? this.lastSearch?.pattern ?? null
        : parsed.source === 'substitute' ? this.substitutePattern : this.searchSlotPattern;
      if (remembered === null) {
        this._message = parsed.source === 'substitute'
          ? 'E33: No previous substitute regular expression' : 'E35: No previous regular expression';
        return;
      }
      pattern = remembered;
    } else {
      pattern = parsed.pattern;
    }
    if (parsed.source !== 'substitute') this.rememberSubstitutePattern(pattern);
    const ignoreCase = this.substituteIgnoresCase(flags.ignoreCase, pattern);
    if (this.refusesPattern(pattern, ignoreCase)) return;
    const regex = compileVimPattern(pattern, ignoreCase, this.patternContext());

    let template = parsed.replacement;
    if (!template.startsWith('\\=')) {
      template = expandTilde(template, this.substituteMemory.previousExpansion);
      this.substituteMemory.previousExpansion = template;
    }

    if (!flags.count && !global) this.pushUndoSnapshot();
    const run: SubstituteRun = {
      lines: this.linesArr, regex, template, flags, tracker: null, expression: null,
      line1: first, line2: last, cursorLine: this._cursorLine + 1, cursorColumn: this._cursorCol,
      substitutions: this.substitutionCount, linesChanged: this.substitutionLines,
      gotMatch: false, gotQuit: false, firstMatchFrom: null,
    };
    if (template.startsWith('\\=')) {
      run.expression = (match, lineNumber, column) => this.evaluateReplacement(template.slice(2), match, lineNumber, column);
    }
    const state: SubstitutionState = {
      generator: runSubstitution(run), run, startSubstitutions: this.substitutionCount,
      oldCursor: { line: this._cursorLine + 1, col: this._cursorCol }, usedPattern: pattern, nextCommand: parsed.nextCommand,
      savedAll: flags.all, savedAsk: flags.ask, keptCursorColumn: parsed.keptCursorColumn,
    };
    this.substitution = state;
    this.advanceSubstitution(undefined);
  }

  private advanceSubstitution(answer: AskAnswer | undefined): void {
    const state = this.substitution!;
    const step = state.generator.next(answer as AskAnswer);
    if (step.done !== true) {
      const ask = step.value;
      this._mode = 'confirm-substitute';
      this._cursorLine = ask.line - 1;
      this._cursorCol = ask.column;
      this._pendingMatch = {
        line: ask.line - 1, start: ask.column, end: ask.endColumn, matchText: ask.matchText, replacementPreview: ask.template,
      };
      return;
    }
    this.finishSubstitution(state);
  }

  private finishSubstitution(state: SubstitutionState): void {
    const { run } = state;
    const flags = run.flags;
    const global = this.globalRun;
    this.substitution = null;
    this._pendingMatch = null;
    this._mode = 'normal';
    this.substitutionCount = run.substitutions;
    this.substitutionLines = run.linesChanged;
    if (run.firstMatchFrom !== null) this.lastJumpPosition = { line: run.firstMatchFrom.line - 1, col: run.firstMatchFrom.column };
    const changed = run.substitutions > state.startSubstitutions;
    this._cursorLine = Math.max(0, Math.min(run.cursorLine - 1, this.linesArr.length - 1));
    this._cursorCol = run.gotMatch ? run.cursorColumn : state.oldCursor.col;
    if (flags.count) {
      this._cursorLine = state.oldCursor.line - 1;
      this._cursorCol = state.oldCursor.col;
    }
    this._message = '';
    if (changed) {
      if (!global) {
        if (!flags.ask) this._cursorCol = this.beginLineColumn(this._cursorLine);
        const report = this.options.number('report');
        if (run.substitutions > report || flags.count) {
          this._message = substitutionMessage(run.substitutions, run.linesChanged, flags.count);
        }
      } else {
        global.needBeginline = true;
      }
      if (flags.print) this._message = this.printedLine(this._cursorLine, flags.number, flags.list);
    } else if (!global && !run.gotMatch && flags.error) {
      this._message = `E486: Pattern not found: ${state.usedPattern}`;
    }
    flags.all = state.savedAll;
    flags.ask = state.savedAsk;
    if (!global && this.expressionError !== null) this._message = this.expressionError;
    if (changed && !flags.count) this._modified = true;
    else if (!global && !flags.count) this.undoStack.pop();
    if (global) {
      this.stepGlobal();
      return;
    }
    if (state.nextCommand !== null && state.nextCommand.trim() !== '' && !/^E\d+:/.test(this._message)) this.executeExCommand(state.nextCommand);
  }

  private runVariableCommand(word: string, bang: boolean, argument: string): void {
    const bar = barOutsideExpression(argument);
    const body = bar === -1 ? argument : argument.slice(0, bar);
    const next = bar === -1 ? '' : argument.slice(bar + 1);
    const host = this.expressionHost({ groups: [] } as unknown as MultiMatch, this._cursorLine + 1, this._cursorCol);
    const errors = word === 'let' ? executeLetCommand(body, host) : executeUnletCommand(body, bang, host);
    this._message = errors.length > 0 ? errors[0] : '';
    this._mode = 'normal';
    if (errors.length === 0 && next.trim() !== '') this.executeExCommand(next);
  }

  private expressionHost(match: MultiMatch, lineNumber: number, columnIndex: number): ExpressionHost {
    return {
      lines: this.linesArr,
      lineNumber,
      columnIndex,
      tabstop: this.tabstop,
      ignoreCase: this.options.bool('ignorecase'),
      searchForward: this.lastSearch?.forward ?? true,
      highlightSearch: this.options.bool('hlsearch') && !this.noHlsearch,
      windowTop: this.window.top + 1,
      windowBottom: this.window.top + this.window.height,
      lambdaCounter: this.lambdaCounter,
      variables: this.variables,
      submatch: (index) => match.groups[index],
      mark: (name) => this.patternMark(name),
      register: (name) => this.registerContent(name),
      option: (name, scope) => this.options.lookup(name, scope),
      environment: (name) => this.environmentVariable(name),
      shell: (command, input) => (input === null ? this.fs.runShellCommand(command) : this.fs.filterThroughShell(command, input)),
    };
  }

  private evaluateReplacement(source: string, match: MultiMatch, lineNumber: number, columnIndex: number): string {
    const outcome = evaluateReplacementExpression(source, this.expressionHost(match, lineNumber, columnIndex));
    if (outcome.errors.length > 0 && this.expressionError === null) this.expressionError = outcome.errors[0];
    return outcome.text;
  }

  private registerContent(name: string): string | null {
    const register = this.registers.get(name);
    if (register === undefined) return null;
    return register.lines.join('\n') + (register.linewise ? '\n' : '');
  }

  private environmentVariable(name: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? (this.fs.environmentVariable?.(name) ?? '') : '';
  }

  private printedLine(line: number, numbered: boolean, listed: boolean): string {
    let text = this.linesArr[line] ?? '';
    if (listed) text = `${text.replace(/\t/g, '^I')}$`;
    return numbered ? `${String(line + 1).padStart(Math.max(3, this.options.number('numberwidth') - 1))} ${text}` : text;
  }

  private joinForSubstitute(first: number, last: number, flag: string): void {
    const global = this.globalRun;
    this._cursorLine = first - 1;
    let count = last - first + 1;
    if (last < this.linesArr.length) count++;
    this._message = '';
    if (count > 1) {
      if (!global) this.pushUndoSnapshot();
      const column = joinedCursorColumn(this.linesArr, first - 1, count);
      const merged = this.linesArr.slice(first - 1, first - 1 + count).join('');
      this.linesArr.splice(first - 1, count, merged);
      this._cursorCol = Math.min(column, Math.max(merged.length - 1, 0));
      this._modified = true;
      this.substitutionCount = count - 1;
      this.substitutionLines = 1;
      if (this.substitutionCount > this.options.number('report')) {
        this._message = substitutionMessage(this.substitutionCount, 1, false);
      }
      if (flag === 'l' || flag === 'p' || flag === '#') this._message = this.printedLine(this._cursorLine, flag === '#', flag === 'l');
    }
    this.rememberSubstitutePattern('\\n');
    if (global) this.stepGlobal();
  }

  private rememberSubstitutePattern(pattern: string): void {
    this.substitutePattern = pattern;
    const previous = this.lastSearch;
    this.lastSearch = { pattern, forward: previous?.forward ?? true, offset: previous?.offset ?? NO_OFFSET };
    this.registers.set('/', { linewise: false, lines: [pattern] });
    this.noHlsearch = false;
  }

  // ── :g/pattern/cmd global command ───────────────────────────────────

  private executeGlobal(startLine: number, endLine: number, pattern: string, cmd: string, inverse: boolean): void {
    const regex = compileVimPattern(pattern, this.searchIgnoresCase(pattern), this.patternContext());
    const lo = Math.max(0, Math.min(startLine, endLine));
    const hi = Math.min(this.linesArr.length - 1, Math.max(startLine, endLine));
    const buffer = new BufferText(this.linesArr);
    const marks: number[] = [];
    for (let i = lo; i <= hi; i++) {
      if ((regex.execMulti(buffer, i, 0) !== null) !== inverse) marks.push(i);
    }
    if (marks.length === 0) {
      this._message = inverse ? `Pattern found in every line: ${pattern}` : `Pattern not found: ${pattern}`;
      this.undoStack.pop();
      return;
    }
    const run: GlobalRun = {
      marks, command: cmd, oldLineCount: this.linesArr.length, needBeginline: false,
      tracker: {
        inserted: (index, count) => {
          run.marks = run.marks.map((mark) => (mark >= index ? mark + count : mark));
        },
        deleted: (index, count) => {
          run.marks = run.marks.filter((mark) => mark < index || mark >= index + count).map((mark) => (mark >= index + count ? mark - count : mark));
        },
      },
    };
    this.globalRun = run;
    this.linesArr.observer = run.tracker;
    this.substitutionCount = 0;
    this.substitutionLines = 0;
    this.stepGlobal();
  }

  private stepGlobal(): void {
    const run = this.globalRun;
    if (run === null) return;
    while (run.marks.length > 0) {
      if (this.substitution !== null) return;
      const line = run.marks.shift()!;
      if (line >= this.linesArr.length) continue;
      this._cursorLine = line;
      this._cursorCol = 0;
      this.runGlobalCommand(run.command.trim());
      if (this.substitution !== null) return;
    }
    this.finishGlobal(run);
  }

  private runGlobalCommand(command: string): void {
    const global = this.globalRun!;
    const before = this.linesArr.length;
    this._mode = 'normal';
    this.executeExCommand(command === '' ? 'p' : command);
    if (this.linesArr.length !== before && this.substituteCommandName(command.trim()) === null) global.needBeginline = true;
  }

  private executeNormalCommand(keys: string, rangeStart: number | null, rangeEnd: number | null): void {
    this._mode = 'normal';
    if (keys === '') {
      this._message = 'E471: Argument required';
      return;
    }
    const lo = rangeStart === null ? this._cursorLine : Math.max(0, Math.min(rangeStart, rangeEnd ?? rangeStart));
    let hi = rangeStart === null ? this._cursorLine : Math.min(this.linesArr.length - 1, Math.max(rangeStart, rangeEnd ?? rangeStart));
    for (let line = lo; line <= hi && line < this.linesArr.length; line++) {
      const before = this.linesArr.length;
      this._cursorLine = line;
      this._cursorCol = 0;
      for (const character of keys) this.applyKey(normalKeyOf(character));
      if (this._mode !== 'normal' || this.hasPendingCommand()) this.applyKey({ key: 'Escape' });
      hi += this.linesArr.length - before;
    }
  }

  private finishGlobal(run: GlobalRun): void {
    this.globalRun = null;
    this.linesArr.observer = null;
    this.cmdlineColumn = null;
    const last = Math.min(this._cursorLine, this.linesArr.length - 1);
    this._cursorLine = last;
    this._cursorCol = run.needBeginline ? this.beginLineColumn(last) : Math.min(this._cursorCol, Math.max(this.linesArr[last].length - 1, 0));
    this._message = '';
    const report = this.options.number('report');
    const delta = this.linesArr.length - run.oldLineCount;
    const expressionError = this.expressionError;
    if (this.substitutionCount > 0 && this.substitutionCount > report) {
      this._message = substitutionMessage(this.substitutionCount, this.substitutionLines, false);
    } else if (Math.abs(delta) > report) {
      const size = Math.abs(delta);
      this._message = delta > 0 ? `${size} more line${size === 1 ? '' : 's'}` : `${size} ${size === 1 ? 'line less' : 'fewer lines'}`;
    }
    if (expressionError !== null) this._message = expressionError;
    this._modified = true;
  }

  // ── :s///c interactive confirm ──────────────────────────────────────

  private applySwapRangeKey(k: EditorKeyInput): void {
    const command = this.pendingBackwardsRange;
    const key = k.key.toLowerCase();
    if (command === null) {
      this._mode = 'normal';
      return;
    }
    if (key === 'y' && !k.ctrl) {
      this.pendingBackwardsRange = null;
      this._mode = 'normal';
      this.executeExCommand(command, true);
    } else if ((key === 'n' && !k.ctrl) || k.key === 'Escape' || (k.ctrl && key === 'c')) {
      this.pendingBackwardsRange = null;
      this._mode = 'normal';
      this._message = '';
    }
  }

  private applyConfirmSubstKey(k: EditorKeyInput): void {
    if (this.substitution === null) {
      this._mode = 'normal';
      return;
    }
    const key = k.key.toLowerCase();
    if (k.key === 'Escape' || (k.ctrl && key === 'c') || key === 'q') {
      this.advanceSubstitution('q');
    } else if (!k.ctrl && (key === 'y' || key === 'n' || key === 'a' || key === 'l')) {
      this.advanceSubstitution(key as AskAnswer);
    }
  }

  // ── SEARCH (/) mode ──────────────────────────────────────────────

  get searchPromptChar(): '/' | '?' { return this.searchDraftForward ? '/' : '?'; }

  private trySearchKey(key: string, op: Operator | null): boolean {
    switch (key) {
      case '/': case '?': this.beginSearch(key === '/', op); return true;
      case 'n': case 'N': this.repeatSearch(key === 'N', op); return true;
      case '*': case '#': case 'g*': case 'g#': this.searchIdentUnderCursor(key, op); return true;
      case 'gn': case 'gN': this.selectNextMatch(key === 'gN', op); return true;
      default: return false;
    }
  }

  private beginSearch(forward: boolean, op: Operator | null): void {
    const count = op ? this.effectiveCount() : this.takeCount();
    this.searchContext = { operator: op, count, returnMode: this._mode };
    this.searchDraftForward = forward;
    this.searchBuffer = '';
    this._mode = 'search';
    this.historyNavIndex = null;
    this.beginIncSearch();
  }

  private leaveSearch(cancelled: boolean): { operator: Operator | null; count: number | undefined } {
    const ctx = this.searchContext ?? { operator: null, count: undefined, returnMode: 'normal' as VimMode };
    this.searchContext = null;
    this._mode = ctx.returnMode;
    this.historyNavIndex = null;
    this.finishIncSearch(cancelled);
    if (cancelled && ctx.operator) this.cancelOperator();
    return { operator: ctx.operator, count: ctx.count };
  }

  private applySearchKey(k: EditorKeyInput): void {
    if (k.ctrl && k.key !== 'Enter') {
      if (k.key === 'c' || k.key === '[') this.leaveSearch(true);
      else if (k.key === 'g' || k.key === 't' || k.key === 'l') {
        if (this.liveSearch === null) {
          this.searchBuffer += String.fromCharCode(k.key.charCodeAt(0) - 96);
        } else if (k.key === 'l') {
          this.addMatchCharToSearch();
        } else {
          this.adjustIncSearch(k.key === 'g');
        }
      }
      else if (k.key === 'u') { this.searchBuffer = ''; this.refreshIncSearch(); }
      else if (k.key === 'w') { this.searchBuffer = this.searchBuffer.replace(/(\w+|[^\w\s]+)?\s*$/, ''); this.refreshIncSearch(); }
      return;
    }
    if (k.key === 'Enter') {
      const typed = this.searchBuffer;
      if (typed) this.searchHistoryList.push(typed);
      const { operator, count } = this.leaveSearch(false);
      this.executeTypedSearch(typed, this.searchDraftForward, operator, count);
      return;
    }
    if (k.key === 'Escape') {
      this.leaveSearch(true);
      return;
    }
    if (k.key === 'ArrowUp') {
      this.searchBuffer = this.recallHistory(this.searchHistoryList, this.searchBuffer);
      this.refreshIncSearch();
      return;
    }
    if (k.key === 'ArrowDown') {
      this.searchBuffer = this.advanceHistory(this.searchHistoryList, this.searchBuffer);
      this.refreshIncSearch();
      return;
    }
    if (k.key === 'Backspace') {
      if (this.searchBuffer === '') { this.leaveSearch(true); return; }
      this.searchBuffer = this.searchBuffer.slice(0, -1);
      this.refreshIncSearch();
      return;
    }
    if (k.key.length === 1) {
      this.searchBuffer += k.key;
      this.refreshIncSearch();
    }
  }

  private followAt(line: number, col: number): void {
    this.window.follow(line, col);
    this.window.followColumn(line, col, true);
  }

  private beginIncSearch(): void {
    this.liveSearch = this.options.bool('incsearch')
      ? {
        view: this.window.saveView(), origin: { line: this._cursorLine, col: this._cursorCol },
        searchStart: { line: this._cursorLine, col: this._cursorCol }, matchStart: { line: this._cursorLine, col: this._cursorCol },
        matchEnd: null, match: null, pattern: null, range: null, active: false,
      }
      : null;
  }

  private incSearchRequest(): { pattern: string; forward: boolean; range: { first: number; last: number } | null } | null {
    if (this._mode === 'search') {
      const forward = this.searchDraftForward;
      const typed = this.searchBuffer;
      const parsed = parseSearchInput(typed, forward ? '/' : '?');
      return { pattern: typed === '' ? '' : parsed.pattern === '' ? this.lastSearch?.pattern ?? '' : parsed.pattern, forward, range: null };
    }
    const range = this.parseExRange(this.commandBuffer.replace(/^[\s:]+/, ''), true);
    const command = INC_COMMAND.exec(range.rest.replace(/^\s+/, ''));
    if (command === null) return null;
    const delimiter = command[2];
    const parsed = parseSearchInput(command[3], delimiter);
    const closed = command[3].length > parsed.pattern.length;
    const pattern = parsed.pattern === '' && closed ? this.lastSearch?.pattern ?? '' : parsed.pattern;
    if (pattern === '' || matchesEverything(pattern)) return null;
    const global = command[1][0] === 'g' || command[1][0] === 'v';
    let first: number | null = null;
    let last: number | null = null;
    if (range.start !== null && range.end !== null) {
      first = Math.min(range.start, range.end);
      last = Math.max(range.start, range.end);
    } else if (!global) {
      first = this._cursorLine;
      last = this._cursorLine;
    }
    return { pattern, forward: true, range: first === null || last === null ? null : { first, last } };
  }

  private refreshIncSearch(): void {
    const state = this.liveSearch;
    if (state === null) return;
    const request = this.incSearchRequest();
    if (request !== null) state.active = true;
    state.range = request?.range ?? null;
    const start = state.range === null ? state.searchStart : state.range.first >= this.linesArr.length
      ? { line: this.linesArr.length - 1, col: Number.MAX_SAFE_INTEGER } : { line: state.range.first, col: 0 };
    let found: ReturnType<typeof findMatch> = null;
    let outside = false;
    if (request !== null && request.pattern !== '') {
      found = findMatch(this.linesArr, start, request.pattern, {
        forward: request.forward, count: this.searchContext?.count ?? 1, wrapscan: this.options.bool('wrapscan'),
        anchor: 'start', ignoreCase: this.searchIgnoresCase(request.pattern), acceptAtCursor: state.range !== null, context: this.patternContext(),
      });
      outside = found !== null && state.range !== null && (found.start.line < state.range.first || found.start.line > state.range.last);
      if (outside) found = null;
    }
    this.window.noteCursorLine(state.searchStart.line);
    state.pattern = request === null || request.pattern === '' ? null : request.pattern;
    state.match = found === null ? null : { start: found.start, end: found.end };
    if (found !== null) {
      state.matchStart = found.start;
      state.matchEnd = found.end;
    }
    this.window.restoreView(state.view);
    const at = found !== null ? found.start : state.range !== null && !outside && state.range.first < this.linesArr.length ? { line: state.range.first, col: 0 } : state.searchStart;
    this.window.follow(at.line, at.col);
    if (found === null) this.window.followColumn(at.line, at.col, true);
    if (found !== null) {
      const lastLine = this.linesArr.length - 1;
      const endLine = Math.min(found.end.line, lastLine);
      this.followAt(endLine, found.end.line > lastLine ? this.line(lastLine).length : found.end.col);
      this.followAt(found.start.line, found.start.col);
    }
  }

  private finishIncSearch(escaped: boolean): void {
    const state = this.liveSearch;
    if (state === null) return;
    this.liveSearch = null;
    if (!state.active) return;
    if (!escaped) {
      const moved = state.searchStart.line !== state.origin.line || state.searchStart.col !== state.origin.col;
      if (moved) this.jumpOrigin = state.origin;
      this._cursorLine = state.searchStart.line;
      this._cursorCol = state.searchStart.col;
    }
    this.window.restoreView(state.view);
    this.followAt(this._cursorLine, this._cursorCol);
    this.cmdlineColumn = { line: this._cursorLine, col: this._cursorCol };
    if (escaped && this.line(this._cursorLine)[this._cursorCol] === '\t') {
      this.explicitWant = cursorVcol(this.line(this._cursorLine), this._cursorCol, this.tabstop, false, this.ctrlTab);
    }
  }

  private adjustIncSearch(forward: boolean): void {
    const state = this.liveSearch;
    if (state === null || this.searchBuffer === '') return;
    const delimiter = this.searchDraftForward ? '/' : '?';
    const parsed = parseSearchInput(this.searchBuffer, delimiter);
    const pattern = parsed.pattern === '' ? this.lastSearch?.pattern ?? '' : parsed.pattern;
    if (pattern === '') return;
    let from = forward ? state.matchEnd ?? { line: 0, col: 0 } : state.matchStart;
    if (forward && state.matchEnd !== null && (state.matchStart.line < state.matchEnd.line || (state.matchStart.line === state.matchEnd.line && state.matchStart.col < state.matchEnd.col))) {
      from = stepBack(this.linesArr, from);
    }
    const found = findMatch(this.linesArr, from, pattern, {
      forward, count: this.searchContext?.count ?? 1, wrapscan: this.options.bool('wrapscan'),
      anchor: 'start', ignoreCase: this.searchIgnoresCase(pattern), context: this.patternContext(),
    });
    if (found === null) return;
    const questionMark = !this.searchDraftForward;
    state.searchStart = state.matchStart;
    state.matchStart = found.start;
    state.matchEnd = found.end;
    if (!forward && !questionMark) state.searchStart = stepBack(this.linesArr, found.start);
    else if (forward && questionMark) state.searchStart = stepForward(this.linesArr, found.start);
    const behind = found.start.line < state.searchStart.line || (found.start.line === state.searchStart.line && found.start.col < state.searchStart.col);
    if (behind && forward) state.searchStart = questionMark ? stepForward(this.linesArr, found.start) : stepBack(this.linesArr, found.start);
    state.match = { start: found.start, end: found.end };
    this.followAt(found.start.line, found.start.col);
    state.view = this.window.saveView();
  }

  private addMatchCharToSearch(): void {
    const state = this.liveSearch;
    if (state === null || state.matchEnd === null) return;
    const char = this.line(state.matchEnd.line)[state.matchEnd.col];
    if (char === undefined) return;
    const delimiter = this.searchDraftForward ? '/' : '?';
    this.searchBuffer += char === delimiter || '\\~^$.*['.includes(char) ? `\\${char}` : char;
    this.refreshIncSearch();
  }

  private incSearchSpans(): ReadonlyMap<number, readonly HighlightSpan[]> | null {
    const match = this.liveSearch?.match ?? null;
    if (match === null) return null;
    const spans = new Map<number, HighlightSpan[]>();
    const { start, end } = match;
    const empty = start.line === end.line && start.col === end.col;
    for (let line = start.line; line <= Math.min(end.line, this.linesArr.length - 1); line++) {
      const length = this.line(line).length;
      const from = line === start.line ? start.col : 0;
      let to = line === end.line ? end.col : (from === length || line > start.line ? length + 1 : length);
      if (empty) {
        if (end.col === 0) continue;
        to = from + 1;
      }
      spans.set(line, [{ from, to }]);
    }
    return spans;
  }

  private executeTypedSearch(typed: string, forward: boolean, op: Operator | null, count: number | undefined): void {
    this.noHlsearch = false;
    const delimiter = forward ? '/' : '?';
    let parsed = parseSearchInput(typed, delimiter);
    let origin = { line: this._cursorLine, col: this._cursorCol };
    let anchorOp = op;
    let chain = true;
    let searchForward = forward;
    let first = true;
    while (chain) {
      const reuseOffset = typed === '' && first;
      const pattern = parsed.pattern === '' ? this.lastSearch?.pattern ?? '' : parsed.pattern;
      if (pattern === '') { this._message = 'E35: No previous regular expression'; if (op) this.cancelOperator(); return; }
      const offset = reuseOffset && this.lastSearch ? this.lastSearch.offset : parsed.offset;
      const search: LastSearch = { pattern, forward: searchForward, offset };
      this.lastSearch = search;
      this.registers.set('/', { linewise: false, lines: [pattern] });
      const target = this.findSearchTarget(origin, search, first ? count ?? 1 : 1);
      if (!target) { if (op) this.cancelOperator(); return; }
      if (parsed.chained === null || parsed.chained === '') {
        this.applySearchTarget(target, anchorOp);
        return;
      }
      origin = target.pos;
      anchorOp = op;
      const next = parsed.chained;
      searchForward = next[0] !== '?';
      parsed = parseSearchInput(next.slice(1), searchForward ? '/' : '?');
      first = false;
      chain = true;
    }
  }

  private moveToFirstNonBlank(line: number): void {
    this._cursorLine = Math.max(0, Math.min(line, this.linesArr.length - 1));
    this._cursorCol = firstNonBlank(this.line(this._cursorLine));
  }

  private rememberSearchPattern(pattern: string): void {
    this.searchSlotPattern = pattern;
    const previous = this.lastSearch;
    this.lastSearch = { pattern, forward: previous?.forward ?? true, offset: previous?.offset ?? NO_OFFSET };
    this.registers.set('/', { linewise: false, lines: [pattern] });
    this.noHlsearch = false;
  }

  private searchFailure(pattern: string, forward: boolean): string {
    if (this.options.bool('wrapscan')) return `E486: Pattern not found: ${pattern}`;
    return forward
      ? `E385: Search hit BOTTOM without match for: ${pattern}`
      : `E384: Search hit TOP without match for: ${pattern}`;
  }

  private findSearchTarget(from: { line: number; col: number }, search: LastSearch, count: number): ReturnType<typeof resolveTarget> | null {
    if (this.refusesPattern(search.pattern, this.searchIgnoresCase(search.pattern, search.noSmartcase))) return null;
    const match = findMatch(this.linesArr, from, search.pattern, {
      forward: search.forward, count, wrapscan: this.options.bool('wrapscan'),
      anchor: search.offset.kind === 'end' ? 'end' : 'start',
      ignoreCase: this.searchIgnoresCase(search.pattern, search.noSmartcase), context: this.patternContext(),
    });
    if (!match) {
      this._message = this.searchFailure(search.pattern, search.forward);
      return null;
    }
    this._message = match.wrapped
      ? (search.forward ? 'search hit BOTTOM, continuing at TOP' : 'search hit TOP, continuing at BOTTOM')
      : '';
    return resolveTarget(this.linesArr, match, search.offset);
  }

  private applySearchTarget(target: ReturnType<typeof resolveTarget>, op: Operator | null): void {
    const from = { line: this._cursorLine, col: this._cursorCol };
    if (op) {
      const before = target.pos.line < from.line || (target.pos.line === from.line && target.pos.col < from.col);
      this.executeOperator(op, {
        start: before ? target.pos : from,
        end: before ? from : target.pos,
        type: target.linewise ? 'line' : 'char',
        inclusive: target.inclusive,
      }, 1);
      return;
    }
    this.lastJumpPosition = this.jumpOrigin ?? from;
    this.jumpOrigin = null;
    this._cursorLine = target.pos.line;
    const text = this.line(target.pos.line);
    this._cursorCol = this._mode === 'normal'
      ? Math.max(0, Math.min(target.pos.col, text.length - 1))
      : Math.min(target.pos.col, text.length);
  }

  private repeatSearch(reverse: boolean, op: Operator | null): void {
    this.noHlsearch = false;
    const count = op ? this.effectiveCount() : this.takeCount();
    if (!this.lastSearch) { this._message = 'E35: No previous regular expression'; if (op) this.cancelOperator(); return; }
    const search: LastSearch = { ...this.lastSearch, forward: reverse ? !this.lastSearch.forward : this.lastSearch.forward };
    const target = this.findSearchTarget({ line: this._cursorLine, col: this._cursorCol }, search, count ?? 1);
    if (!target) { if (op) this.cancelOperator(); return; }
    this.applySearchTarget(target, op);
  }

  private searchIdentUnderCursor(key: string, op: Operator | null): void {
    this.noHlsearch = false;
    const count = op ? this.effectiveCount() : this.takeCount();
    const ident = identUnderCursor(this.linesArr, { line: this._cursorLine, col: this._cursorCol }, this.words);
    if (!ident) { this._message = 'E348: No string under cursor'; if (op) this.cancelOperator(); return; }
    const wholeWord = !key.startsWith('g');
    const forward = key.endsWith('*');
    const pattern = patternForIdent(ident, wholeWord);
    const search: LastSearch = { pattern, forward, offset: NO_OFFSET, noSmartcase: true };
    this.lastSearch = search;
    this.registers.set('/', { linewise: false, lines: [pattern] });
    const here = { line: this._cursorLine, col: this._cursorCol };
    const target = this.findSearchTarget(ident.start, search, count ?? 1);
    if (!target) { if (op) this.cancelOperator(); return; }
    if (op) {
      this._cursorLine = here.line;
      this._cursorCol = here.col;
    }
    this.applySearchTarget(target, op);
  }

  private selectNextMatch(backward: boolean, op: Operator | null): void {
    if (op) this.takeCount();
    if (!this.lastSearch) { this._message = 'E35: No previous regular expression'; if (op) this.cancelOperator(); return; }
    const pattern = this.lastSearch.pattern;
    const ignoreCase = this.searchIgnoresCase(pattern, this.lastSearch.noSmartcase);
    if (this.refusesPattern(pattern, ignoreCase)) { if (op) this.cancelOperator(); return; }
    const here = { line: this._cursorLine, col: this._cursorCol };
    const count = op === null ? 1 : 1;
    const match = findCurrentMatch(this.linesArr, here, pattern, {
      forward: !backward, count, wrapscan: this.options.bool('wrapscan'), ignoreCase, context: this.patternContext(),
    });
    if (!match) { this._message = this.searchFailure(pattern, !backward); if (op) this.cancelOperator(); return; }
    const startLineLength = this.line(match.start.line).length;
    const last = match.zeroWidth
      ? { line: match.start.line, col: Math.min(match.start.col, Math.max(0, startLineLength - 1)) }
      : match.end.col > 0
        ? { line: match.end.line, col: match.end.col - 1 }
        : { line: Math.max(0, match.end.line - 1), col: Math.max(0, this.line(Math.max(0, match.end.line - 1)).length) };
    const start = match.zeroWidth ? last : match.start;
    if (op) {
      this.executeOperator(op, { start, end: last, type: 'char', inclusive: true }, 1);
      return;
    }
    this.keepWantThisKey = true;
    this.visualAnchorLine = backward ? last.line : start.line;
    this.visualAnchorCol = backward ? last.col : start.col;
    this._cursorLine = backward ? start.line : last.line;
    this._cursorCol = backward ? start.col : last.col;
    this._mode = 'visual';
  }

  // ── Exit bookkeeping ─────────────────────────────────────────────

  private finishExit(saved: boolean): void {
    this._exited = true;
    this._savedOnExit = saved;
    if (this.swapPath !== '') {
      this.fs.deleteFile(this.swapPath);
      this.swapPath = '';
    }
    // orphanSwapPath (if any) is deliberately left behind — matches real
    // vim, which never auto-deletes the swap file a recovery was read
    // from, requiring an explicit manual `rm`.
  }
}
