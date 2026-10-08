import { simulationNowMs } from '@/network/core/SystemClock';

import type { EditorFsContext } from './EditorFsContext';
import type { EditorKeyInput } from './EditorKeyInput';
import { dotSwapPathFor } from './editorPaths';
import { renderListLine, type ListChars } from './editorRender';
import { MAXCOL, cursorVcol, firstNonBlank, runMotion, type FindState } from './vim/VimMotions';
import { textObject } from './vim/VimTextObjects';
import { joinText, removeChars, shiftLine, sliceChars, swapCase } from './vim/VimEditing';

export type VimMode = 'normal' | 'insert' | 'command' | 'search' | 'confirm-substitute' | 'visual' | 'visual-line' | 'visual-block' | 'swap-recovery' | 'binary-warning';
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

export interface PendingSubstMatch {
  line: number;
  start: number;
  end: number;
  matchText: string;
  replacementPreview: string;
}

/**
 * Translate a vim "magic mode" pattern (the default: `( ) + ? { } |` are
 * literal unless backslash-escaped, the opposite of JS/PCRE) into an
 * equivalent JS RegExp source.
 */
function compileVimPattern(pattern: string, ignoreCase: boolean): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      // \%xHH — a specific byte value (2 hex digits), e.g. \%x00 for NUL.
      if (pattern[i + 1] === '%' && pattern[i + 2] === 'x' && /^[0-9a-fA-F]{2}$/.test(pattern.slice(i + 3, i + 5))) {
        out += `\\x${pattern.slice(i + 3, i + 5)}`;
        i += 4;
        continue;
      }
      // \%uHHHH — a specific Unicode codepoint (4 hex digits), e.g. \%ufeff for a BOM.
      if (pattern[i + 1] === '%' && pattern[i + 2] === 'u' && /^[0-9a-fA-F]{4}$/.test(pattern.slice(i + 3, i + 7))) {
        out += `\\u${pattern.slice(i + 3, i + 7)}`;
        i += 6;
        continue;
      }
      const next = pattern[i + 1];
      i++;
      switch (next) {
        case '(': out += '('; break;
        case ')': out += ')'; break;
        case '+': out += '+'; break;
        case '?': out += '?'; break;
        case '|': out += '|'; break;
        case '{': out += '{'; break;
        case '}': out += '}'; break;
        case '<': out += '\\b(?=\\w)'; break;
        case '>': out += '(?<=\\w)\\b'; break;
        case '.': out += '\\.'; break;
        case '\\': out += '\\\\'; break;
        case '/': out += '/'; break;
        case 'r': out += '\\r'; break; // carriage return
        default: out += next !== undefined ? (/[a-zA-Z0-9]/.test(next) ? next : '\\' + next) : '\\\\';
      }
      continue;
    }
    if (c === '(' || c === ')' || c === '{' || c === '}' || c === '+' || c === '?' || c === '|') {
      out += '\\' + c; // literal in vim's default magic mode
      continue;
    }
    out += c; // . * ^ $ [ ] pass through — same meaning in both dialects
  }
  return new RegExp(out, ignoreCase ? 'i' : undefined);
}

/** Search `line` for the next match of `regex` at or after column `fromCol`. */
function execFrom(line: string, regex: RegExp, fromCol: number): RegExpExecArray | null {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  re.lastIndex = fromCol;
  return re.exec(line);
}

/** Apply a vim-style replacement template (`\1`.._`\9`, `&`, `\&`, `\\`) against a JS match array. */
function applyVimReplacement(template: string, m: RegExpExecArray): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === '\\') {
      const n = template[i + 1];
      if (n !== undefined && n >= '0' && n <= '9') { out += m[parseInt(n, 10)] ?? ''; i++; continue; }
      if (n === '&') { out += '&'; i++; continue; }
      if (n === '\\') { out += '\\'; i++; continue; }
      out += n !== undefined ? n : '\\';
      if (n !== undefined) i++;
      continue;
    }
    if (c === '&') { out += m[0]; continue; }
    out += c;
  }
  return out;
}

type CharClass = 0 | 1 | 2; // 0 = blank, 1 = word, 2 = punctuation

function charClass(ch: string | undefined, big = false): CharClass {
  if (ch === undefined || /\s/.test(ch)) return 0;
  if (big) return 1; // WORD (W/B/E): any non-blank run is one class
  if (/[A-Za-z0-9_]/.test(ch)) return 1;
  return 2;
}

/** End (exclusive) of the word/punct run starting at col, skipping leading blanks. Used by cw/dw/ce (and dW/cW/eW with big=true). */
function wordRunEnd(line: string, col: number, big = false): number {
  const n = line.length;
  let i = col;
  if (i >= n) return n;
  if (charClass(line[i], big) === 0) {
    while (i < n && charClass(line[i], big) === 0) i++;
    if (i >= n) return n;
  }
  const cls = charClass(line[i], big);
  while (i < n && charClass(line[i], big) === cls) i++;
  return i;
}

/** Column of the start of the next word on this line, or null if motion must cross a line boundary. */
function nextWordStart(line: string, col: number, big = false): number | null {
  const n = line.length;
  let i = col;
  if (i >= n) return null;
  const cls = charClass(line[i], big);
  if (cls !== 0) { while (i < n && charClass(line[i], big) === cls) i++; }
  while (i < n && charClass(line[i], big) === 0) i++;
  return i < n ? i : null;
}

/** Column of the start of the previous word on this line, or null if motion must cross a line boundary. */
function prevWordStart(line: string, col: number, big = false): number | null {
  let i = col - 1;
  while (i >= 0 && charClass(line[i], big) === 0) i--;
  if (i < 0) return null;
  const cls = charClass(line[i], big);
  while (i > 0 && charClass(line[i - 1], big) === cls) i--;
  return i;
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

type Operator = 'd' | 'y' | 'c' | '<' | '>' | 'g~' | 'gu' | 'gU';

interface OperatorRange {
  start: { line: number; col: number };
  end: { line: number; col: number };
  type: 'char' | 'line';
  inclusive: boolean;
  noAdjustEnd?: boolean;
}

function colAtVcolInsert(text: string, want: number, tabstop: number): number {
  let vcol = 0;
  for (let i = 0; i < text.length; i++) {
    const width = text[i] === '\t' ? tabstop - (vcol % tabstop) : 1;
    if (want < vcol + width) return i;
    vcol += width;
  }
  return text.length;
}

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
const VIM_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  'number', 'nu', 'relativenumber', 'rnu', 'list', 'showmatch', 'sm',
  'incsearch', 'hlsearch', 'ignorecase', 'autoindent', 'ai',
]);

const VIM_NUMERIC_OPTIONS: ReadonlySet<string> = new Set(['colorcolumn']);

const VIM_STRING_OPTIONS: ReadonlySet<string> = new Set([
  'listchars', 'filetype', 'ft', 'fileformat', 'ff', 'fileencoding', 'fenc',
]);

function vimSetRefusal(argument: string): string {
  const name = argument.split('=')[0].replace(/^no/, '');
  const bare = argument.split('=')[0];
  const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : null;
  const known = VIM_BOOLEAN_OPTIONS.has(name) || VIM_NUMERIC_OPTIONS.has(name)
    || VIM_STRING_OPTIONS.has(name);
  if (!known) return `E518: Unknown option: ${argument}`;
  if (value === null) return `E518: Unknown option: ${argument}`;
  if (VIM_NUMERIC_OPTIONS.has(bare) && !/^\d+$/.test(value)) {
    return `E521: Number required after =: ${argument}`;
  }
  if (VIM_BOOLEAN_OPTIONS.has(bare)) return `E474: Invalid argument: ${argument}`;
  return `E518: Unknown option: ${argument}`;
}

interface ExRange {
  start: number | null;
  end: number | null;
  rest: string;
  literal: string;
}

export class VimEngine {
  private linesArr: string[];
  private _mode: VimMode = 'normal';
  private _cursorLine = 0;
  private _cursorCol = 0;
  private _modified = false;
  private _message: string;
  private _exited = false;
  private _savedOnExit = false;
  private commandBuffer = '';
  private searchBuffer = '';

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
  private readonly shiftwidth = 8;
  private joinSpaces = true;
  private cmdKeys: EditorKeyInput[] = [];
  private commandChanged = false;
  private commandBlocked = false;
  private mlEmpty = false;
  private replaceMode = false;
  private lineUndoLine = -1;
  private lineUndoText = '';
  private lineUndoRunning = false;
  private replacedOriginals: (string | null)[] = [];
  private pendingCountStr = '';
  private pendingG = false;
  private awaitingFindChar: 'f' | 'F' | 't' | 'T' | null = null;
  private lastFind: FindState | null = null;
  private want = -1;
  private explicitWant: number | null = null;
  private keepWantThisKey = false;
  private readonly tabstop = 8;
  private swapPath: string;
  private orphanSwapPath: string | null = null;
  private _pendingSwapRecovery: PendingSwapRecovery | null = null;
  private recoveredLinesFromSwap: string[] = [];
  private originalDiskLines: string[] = [];
  private _readOnly = false;
  private readonly owner: string;
  private substState: { rangeEnd: number; regex: RegExp; replacementTemplate: string; global: boolean; currentLine: number; currentCol: number; totalReplaced: number; linesTouched: Set<number> } | null = null;
  private _pendingMatch: PendingSubstMatch | null = null;

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

  // `:set` toggles. Real vim ships with `number`/`relativenumber` both off
  // by default — the user opts in explicitly (e.g. via ~/.vimrc).
  private showLineNumbers = false;
  private showRelativeNumbers = false;
  private hlsearchEnabled = false;
  private ignoreCaseSearch = false;
  private _shellOutput = '';
  private listModeEnabled = false;
  private listCharsCfg: { tab: string; trail: string; eol: string } = { tab: '^I', trail: '', eol: '$' };
  private showMatchEnabled = false;
  private incSearchEnabled = false;
  private colorColumnCfg: number | null = null;
  private autoindentEnabled = false;

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

  // `fileformat` — autodetected from the presence of any \r\n pair in the
  // file as loaded (real vim's heuristic). A CRLF-terminated line has its
  // trailing \r stripped from the in-memory buffer, same as real vim; a
  // *stray* \r not immediately followed by \n (corruption from a botched
  // conversion) is left in place, exactly where `\r` search/substitution
  // is meant to find and clean it up. Only affects how lines are rejoined
  // on save — never auto-strips existing buffer content.
  private _fileFormat: 'unix' | 'dos' = 'unix';

  constructor(
    private readonly fs: EditorFsContext,
    public readonly filePath: string,
    initialContent: string,
    isNewFile: boolean,
    public readonly variant: VimVariant = 'vim',
    owner = 'user',
    /** `vim +LINE file` — 1-indexed, clamped to the buffer. */
    initialCursor?: { line: number },
  ) {
    this._fileFormat = initialContent.includes('\r\n') ? 'dos' : 'unix';
    const body = initialContent.endsWith('\n') ? initialContent.slice(0, -1) : initialContent;
    const rawLines = body.length === 0 && initialContent.length === 0 ? [''] : body.split('\n');
    this.linesArr = this._fileFormat === 'dos'
      ? rawLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
      : rawLines;
    this.originalDiskLines = [...this.linesArr];
    this.owner = owner;
    this._message = filePath === ''
      ? ''
      : isNewFile
        ? `"${filePath}" [New File]`
        : `"${filePath}" ${this.linesArr.length}L, ${initialContent.length}C`;

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
  get lines(): readonly string[] { return this.linesArr; }
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
    return this._mode === 'binary-warning' ? `"${this.filePath}" may be a binary file, see it anyway?` : null;
  }
  /** Set once a recovery/edit-anyway choice leaves the original .swp behind — real vim never auto-deletes it. */
  get orphanSwapFilePath(): string | null { return this.orphanSwapPath; }
  get isReadOnly(): boolean { return this._readOnly; }
  /** True while in insert mode AND the variant shows a mode indicator (vim, not strict vi). */
  get showsInsertIndicator(): boolean { return this._mode === 'insert' && this.variant === 'vim'; }
  get pendingSubstMatch(): PendingSubstMatch | null { return this._pendingMatch; }
  get visualAnchor(): { line: number; col: number } { return { line: this.visualAnchorLine, col: this.visualAnchorCol }; }
  get lineNumbersShown(): boolean { return this.showLineNumbers; }
  get relativeNumbersShown(): boolean { return this.showRelativeNumbers; }
  get hlsearch(): boolean { return this.hlsearchEnabled; }
  get shellOutput(): string { return this._shellOutput; }
  get fileFormat(): 'unix' | 'dos' { return this._fileFormat; }
  get listMode(): boolean { return this.listModeEnabled; }
  get showMatch(): boolean { return this.showMatchEnabled; }
  get incSearch(): boolean { return this.incSearchEnabled; }
  get colorColumn(): number | null { return this.colorColumnCfg; }
  get autoindent(): boolean { return this.autoindentEnabled; }
  /** Real vim's `:set list` rendering: `$` at end of line, `^I` (or the
   *  configured `listchars` symbol) for tabs, a literal `^M` for a stray
   *  embedded CR (real CRLF pairs are already stripped from the buffer at
   *  load time, so any \r left here is genuine corruption to surface). */
  renderListLine(line: string): string {
    if (!this.listModeEnabled) return line;
    return renderListLine(line, this.listCharsCfg);
  }

  /** `:set listchars` as it stands — carried in the view for a remote renderer. */
  get listChars(): ListChars { return { ...this.listCharsCfg }; }
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
    this.explicitWant = null;
    this.keepWantThisKey = false;
    this.applyKeyInner(k);
    this.updateWant();
  }

  private awaitingArgument(): boolean {
    return this.awaitingFindChar !== null || this.awaitingReplaceChar || this.awaitingRegisterName
      || this.awaitingMacroName || this.awaitingMacroPlayback || this.awaitingMarkSet
      || this.awaitingMarkJumpExact || this.awaitingMarkJumpLine;
  }

  private hasPendingCommand(): boolean {
    return this.pendingOperator !== null || this.pendingCountStr !== '' || this.pendingG
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
    this.want = cursorVcol(this.line(this._cursorLine), this._cursorCol, this.tabstop);
  }

  private isIdle(): boolean {
    return this._mode === 'normal' && !this.hasPendingCommand();
  }

  private applyKeyInner(k: EditorKeyInput): void {
    if (this._exited) return;

    if (this.isDotReplay || this.isMacroReplay) { this.dispatchByMode(k); this.syncSwapFile(); return; }

    const idle = this.isIdle() || (this._mode === 'normal' && this.pendingCountStr !== '' && !this.pendingOperator && !this.pendingG && !this.awaitingArgument());
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
      this.commandBlocked = false;
    }
    this.cmdKeys.push(k);

    this.dispatchByMode(k);
    this.syncSwapFile();

    if (this._mode !== 'normal' && this._mode !== 'insert') this.commandBlocked = true;
    if (this.isIdle()) {
      if (this.commandChanged && !this.lineUndoRunning) this.trackLineUndo();
      this.lineUndoRunning = false;
      if (!this.commandBlocked && this.commandChanged && this.cmdKeys.length > 0) this.dotRepeat = [...this.cmdKeys];
      this.cmdKeys = [];
      this.commandChanged = false;
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
      case 'visual': case 'visual-line': case 'visual-block': return this.applyVisualKey(k);
      case 'swap-recovery': return this.applySwapRecoveryKey(k);
      case 'binary-warning': return this.applyBinaryWarningKey(k);
    }
  }

  private applyBinaryWarningKey(k: EditorKeyInput): void {
    const key = k.key.toLowerCase();
    if (key === 'y' || k.key === 'Enter') {
      this._mode = 'normal';
      this._message = `"${this.filePath}" [noeol] ${this.linesArr.length}L, binary`;
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
      this.linesArr = this.recoveredLinesFromSwap.length > 0 ? [...this.recoveredLinesFromSwap] : [''];
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
      this.linesArr = [...this.originalDiskLines];
      this.orphanSwapPath = info.swapPath;
      this.swapPath = this.pickAvailableSwapPath();
      this.syncSwapFile();
      this._message = '';
      this._pendingSwapRecovery = null;
      this._mode = 'normal';
      return;
    }
    if (key === 'o') {
      this.linesArr = [...this.originalDiskLines];
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
    this.linesArr = [...target];
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
      if (/^[a-z]$/.test(key)) this.recordingMacro = { name: key, keys: [] };
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
      if (lower === 'f') { const n = this.takeCount() ?? 1; this._cursorLine = Math.min(this.linesArr.length - 1, this._cursorLine + 20 * n); this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol); return; }
      if (lower === 'b') { const n = this.takeCount() ?? 1; this._cursorLine = Math.max(0, this._cursorLine - 20 * n); this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol); return; }
      if (lower === 'v') { this.pendingCountStr = ''; this.enterVisual('visual-block'); return; }
      if (lower === 'a' || lower === 'x') { this.incrementNumber(lower === 'a' ? 1 : -1); return; }
    }

    if (/^[0-9]$/.test(key) && !(key === '0' && this.pendingCountStr === '') && !this.awaitingFindChar) {
      this.pendingCountStr += key;
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
        return;
      case '/':
        this.searchBuffer = '';
        this._mode = 'search';
        this.historyNavIndex = null;
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
    return this.tryGMotion(key);
  }

  private gotoLine(idx: number): void {
    this._cursorLine = Math.max(0, Math.min(idx, this.linesArr.length - 1));
    const l = this.line(this._cursorLine);
    const firstNonBlank = l.search(/\S/);
    this._cursorCol = firstNonBlank >= 0 ? firstNonBlank : 0;
  }

  private setLine(i: number, text: string): void { this.linesArr[i] = text; }

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

  private enterInsert(): void {
    this.mlEmpty = false;
    this._mode = 'insert';
    this._message = this.variant === 'vim' ? '-- INSERT --' : '';
  }

  private beginInsert(kind: 'i' | 'a' | 'A' | 'I' | 'o' | 'O' | 'gI'): void {
    const count = this.takeCount() ?? 1;
    const text = this.line(this._cursorLine);
    if (kind === 'o' || kind === 'O') {
      this.pushUndoSnapshot();
      const indent = this.autoindentEnabled ? text.match(/^[ \t]*/)?.[0] ?? '' : '';
      const at = kind === 'o' ? this._cursorLine + 1 : this._cursorLine;
      this.linesArr.splice(at, 0, indent);
      this._cursorLine = at;
      this._cursorCol = indent.length;
      this._modified = true;
    } else {
      if (kind === 'a') this._cursorCol = text.length > 0 ? Math.min(text.length, this._cursorCol + 1) : 0;
      else if (kind === 'A') this._cursorCol = text.length;
      else if (kind === 'I') this._cursorCol = firstNonWhite(text);
      else if (kind === 'gI') this._cursorCol = 0;
      this.pushUndoSnapshot();
    }
    this.insertRepeat = count;
    this.insertKind = kind === 'o' || kind === 'O' ? kind : 'i';
    this.insertedText = '';
    this.insertUndoDepth = this.undoStack.length;
    this.enterInsert();
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
    if (!range) { this.cancelOperator(); return; }
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
      const tail = this.line(end.line).slice(end.col + (inclusive ? 1 : 0));
      if (/^[ \t]*$/.test(tail) && this.insideIndent(start)) type = 'line';
    }
    const endExclusive = { line: end.line, col: end.col + (inclusive ? 1 : 0) };
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
    if (type === 'line') {
      const removed = this.linesArr.slice(start.line, end.line + 1);
      this.setRegister({ linewise: true, lines: removed });
      const indent = this.autoindentEnabled ? this.line(start.line).match(/^[ \t]*/)?.[0] ?? '' : '';
      this.linesArr.splice(start.line, end.line - start.line + 1, indent);
      this._cursorLine = start.line;
      this._cursorCol = indent.length;
    } else {
      const empty = start.line === endExclusive.line && start.col >= endExclusive.col;
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
    this.enterInsert();
  }

  private shiftRange(startLine: number, endLine: number, amount: number): void {
    this.pushUndoSnapshot();
    for (let i = startLine; i <= endLine; i++) {
      this.linesArr[i] = shiftLine(this.line(i), this.tabstop, this.shiftwidth, amount);
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
    this.pushUndoSnapshot();
    if (key === 'Enter') {
      const before = text.slice(0, this._cursorCol);
      const after = text.slice(this._cursorCol + count);
      const indent = this.autoindentEnabled ? text.match(/^[ \t]*/)?.[0] ?? '' : '';
      this.linesArr.splice(this._cursorLine, 1, before, indent + after);
      this._cursorLine++;
      this._cursorCol = indent.length;
    } else {
      this.setLine(this._cursorLine, text.slice(0, this._cursorCol) + key.repeat(count) + text.slice(this._cursorCol + count));
      this._cursorCol += count - 1;
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
    this.pushUndoSnapshot();
    const reg = this.activeRegister();
    if (!reg || reg.lines.length === 0) return;
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
  ]);

  private currentWant(): number {
    return this.want >= 0 ? this.want : cursorVcol(this.line(this._cursorLine), this._cursorCol, this.tabstop);
  }

  private motionBuffer(): { lines: readonly string[]; tabstop: number } {
    return { lines: this.linesArr, tabstop: this.tabstop };
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
    this._cursorCol = this.clampCol(result.pos.line, result.pos.col);
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
    if (key === 'j' || key === 'k') { this.runCursorMotion(`g${key}`); return true; }
    return false;
  }

  // ── VISUAL / VISUAL LINE / VISUAL BLOCK ─────────────────────────────

  private enterVisual(mode: 'visual' | 'visual-line' | 'visual-block'): void {
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
      if (this.pendingCountStr !== '' || this.pendingG || this.awaitingFindChar || this.visualObjectKind) {
        this.pendingCountStr = '';
        this.pendingG = false;
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

    if (this.pendingG) {
      this.pendingG = false;
      this.applyVisualGKey(key);
      return;
    }

    if (k.ctrl) {
      const lower = key.toLowerCase();
      if (lower === 'v') { this.switchVisualMode('visual-block'); return; }
      return;
    }

    switch (key) {
      case 'g': this.pendingG = true; return;
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
        this.lastVisualStart = Math.min(this.visualAnchorLine, this._cursorLine);
        this.lastVisualEnd = Math.max(this.visualAnchorLine, this._cursorLine);
        this.commandBuffer = "'<,'>";
        this._mode = 'command';
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
    this.visualAnchorLine = range.start.line;
    this.visualAnchorCol = range.start.col;
    let endLine = range.end.line;
    let endCol = range.end.col;
    if (range.type === 'line') {
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
        start: { line: bounds.startLine, col: 0 },
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
    this.exitVisual();
    const count = Math.max(2, bounds.endLine - bounds.startLine + 1);
    this._cursorLine = bounds.startLine;
    this.pendingCountStr = String(count);
    this.joinCommand(withSpaces);
  }

  private visualLineInsert(append: boolean): void {
    const bounds = this.visualBounds();
    const mode = this._mode;
    this.exitVisual();
    if (mode === 'visual-line') {
      this._cursorLine = append ? bounds.endLine : bounds.startLine;
      this.beginInsert(append ? 'A' : 'I');
      return;
    }
    if (append) {
      this._cursorLine = bounds.endLine;
      this._cursorCol = Math.min(bounds.endCol + 1, this.line(bounds.endLine).length);
      this.pushUndoSnapshot();
      this.insertRepeat = 1;
      this.insertKind = 'i';
      this.insertedText = '';
      this.insertUndoDepth = this.undoStack.length;
      this.enterInsert();
    } else {
      this._cursorLine = bounds.startLine;
      this._cursorCol = bounds.startCol;
      this.pushUndoSnapshot();
      this.insertRepeat = 1;
      this.insertKind = 'i';
      this.insertedText = '';
      this.insertUndoDepth = this.undoStack.length;
      this.enterInsert();
    }
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
    const a = cursorVcol(anchorText, this.visualAnchorCol, this.tabstop, false);
    const aEnd = this.charEndVcol(anchorText, this.visualAnchorCol);
    const c = cursorVcol(cursorText, this._cursorCol, this.tabstop, false);
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
    for (let i = 0; i < col && i < text.length; i++) vcol += text[i] === '\t' ? this.tabstop - (vcol % this.tabstop) : 1;
    if (col >= text.length) return vcol;
    const width = text[col] === '\t' ? this.tabstop - (vcol % this.tabstop) : 1;
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
      const width = text[i] === '\t' ? this.tabstop - (vcol % this.tabstop) : 1;
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
      const width = text[i] === '\t' ? this.tabstop - (vcol % this.tabstop) : 1;
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
    if (k.ctrl && k.key.toLowerCase() === 'h') { this.insertBackspace(); return; }
    if (k.ctrl && k.key.toLowerCase() === 'w') { this.insertDeleteWordBack(); return; }
    if (k.ctrl && k.key.toLowerCase() === 'u') { this.insertDeleteToLineStart(); return; }

    switch (k.key) {
      case 'Backspace': this.insertBackspace(); return;
      case 'Enter': this.insertNewline(); this.insertedText += '\n'; return;
      case 'Tab': this.insertCharacter('\t'); return;
      case 'ArrowLeft': this.insertCursorMove(() => { if (this._cursorCol > 0) this._cursorCol--; }); return;
      case 'ArrowRight': this.insertCursorMove(() => { this._cursorCol = Math.min(this.line(this._cursorLine).length, this._cursorCol + 1); }); return;
      case 'Home': this.insertCursorMove(() => { this._cursorCol = 0; }); return;
      case 'End': this.insertCursorMove(() => { this._cursorCol = this.line(this._cursorLine).length; }); return;
      case 'ArrowUp': case 'ArrowDown': this.insertVerticalMove(k.key === 'ArrowDown'); return;
      case 'Delete': this.insertDeleteForward(); return;
      default:
        if (k.key.length === 1 && !k.ctrl && !k.alt) this.insertCharacter(k.key);
        return;
    }
  }

  private insertCharacter(ch: string): void {
    const l = this.line(this._cursorLine);
    if (this.replaceMode) {
      const original = this._cursorCol < l.length ? l[this._cursorCol] : null;
      this.replacedOriginals.push(original);
      this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + ch + l.slice(this._cursorCol + (original === null ? 0 : 1)));
      this._cursorCol++;
      this._modified = true;
      this.insertedText += ch;
      return;
    }
    this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + ch + l.slice(this._cursorCol));
    this._cursorCol++;
    this._modified = true;
    this.insertedText += ch;
  }

  private insertNewline(): void {
    const l = this.line(this._cursorLine);
    const before = l.slice(0, this._cursorCol);
    let after = l.slice(this._cursorCol);
    let indent = '';
    if (this.autoindentEnabled) {
      indent = l.match(/^[ \t]*/)?.[0] ?? '';
      after = indent + after;
    }
    this.linesArr.splice(this._cursorLine, 1, before, after);
    this._cursorLine++;
    this._cursorCol = indent.length;
    this._modified = true;
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
    let col = colAtVcolInsert(text, want, this.tabstop);
    if (want >= MAXCOL) col = text.length;
    this.insertCursorMove(() => { this._cursorLine = target; this._cursorCol = col; });
  }

  private insertDeleteForward(): void {
    const l = this.line(this._cursorLine);
    if (this._cursorCol < l.length) {
      this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + l.slice(this._cursorCol + 1));
    } else if (this._cursorLine < this.linesArr.length - 1) {
      this.setLine(this._cursorLine, l + this.line(this._cursorLine + 1));
      this.linesArr.splice(this._cursorLine + 1, 1);
    }
    this._modified = true;
  }

  private leaveInsert(): void {
    if (this.blockInsertContext) this.finishBlockInsert();
    const text = this.insertedText;
    const repeat = this.insertRepeat;
    this.insertRepeat = 1;
    if (repeat > 1 && (text.length > 0 || this.insertKind !== 'i')) {
      for (let i = 1; i < repeat; i++) {
        if (this.insertKind !== 'i') this.insertNewline();
        for (const ch of text) {
          if (ch === '\n') this.insertNewline();
          else this.insertCharacter(ch);
        }
      }
    }
    if (this.insertUndoDepth >= 0 && this.undoStack.length === this.insertUndoDepth) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (top && top.lines.length === this.linesArr.length && top.lines.every((l, i) => l === this.linesArr[i])) {
        this.undoStack.pop();
      }
    }
    this.insertUndoDepth = -1;
    this.insertedText = '';
    this.replaceMode = false;
    this.replacedOriginals = [];
    this._cursorCol = Math.max(0, this._cursorCol - 1);
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
    if (this._cursorCol > 0) {
      const l = this.line(this._cursorLine);
      this.setLine(this._cursorLine, l.slice(0, this._cursorCol - 1) + l.slice(this._cursorCol));
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
  }

  private insertDeleteWordBack(): void {
    const l = this.line(this._cursorLine);
    const prv = prevWordStart(l, this._cursorCol) ?? 0;
    this.setLine(this._cursorLine, l.slice(0, prv) + l.slice(this._cursorCol));
    this._cursorCol = prv;
    this._modified = true;
  }

  private insertDeleteToLineStart(): void {
    const l = this.line(this._cursorLine);
    this.setLine(this._cursorLine, l.slice(this._cursorCol));
    this._cursorCol = 0;
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
      this.executeExCommand(this.commandBuffer);
      return;
    }
    if (k.key === 'Escape') {
      this._mode = 'normal';
      this.commandBuffer = '';
      this.historyNavIndex = null;
      return;
    }
    if (k.key === 'ArrowUp') {
      this.commandBuffer = this.recallHistory(this.commandHistoryList, this.commandBuffer);
      return;
    }
    if (k.key === 'ArrowDown') {
      this.commandBuffer = this.advanceHistory(this.commandHistoryList, this.commandBuffer);
      return;
    }
    if (k.key === 'Backspace') {
      this.commandBuffer = this.commandBuffer.slice(0, -1);
      return;
    }
    if (k.key.length === 1) {
      this.commandBuffer += k.key;
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
  private parseExRange(s: string): ExRange {
    if (s.startsWith('%')) {
      return { start: 0, end: this.linesArr.length - 1, rest: s.slice(1), literal: '%' };
    }
    const m = s.match(/^(\$|\.|'<|'>|\d+)(?:,(\$|\.|'<|'>|\d+))?/);
    if (!m) return { start: null, end: null, rest: s, literal: '' };
    const resolve = (tok: string) => {
      if (tok === '$') return this.linesArr.length - 1;
      if (tok === '.') return this._cursorLine;
      if (tok === "'<") return this.lastVisualStart;
      if (tok === "'>") return this.lastVisualEnd;
      return parseInt(tok, 10) - 1;
    };
    const start = resolve(m[1]);
    const end = m[2] !== undefined ? resolve(m[2]) : start;
    return { start, end, rest: s.slice(m[0].length), literal: m[0] };
  }

  private rangeRefusal(range: ExRange, typed: string): string | null {
    if (range.start === null || range.end === null || range.literal === '%') return null;
    const last = this.linesArr.length - 1;
    if (range.start > last || range.end > last) return `E16: Invalid range: ${typed}`;
    if (range.start > range.end) return `E493: Backwards range given: ${typed}`;
    return null;
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
    this.linesArr.splice(lo, hi - lo + 1);
    if (this.linesArr.length === 0) this.linesArr.push('');
    this._cursorLine = Math.min(lo, this.linesArr.length - 1);
    this._cursorCol = 0;
    this._modified = true;
    this._message = '';
  }

  private parseSubstituteCmd(s: string): { pattern: string; replacement: string; flags: string } | null {
    const m = s.match(/^s\/((?:\\.|[^/])*)\/((?:\\.|[^/])*)(?:\/([a-zA-Z]*))?$/);
    if (!m) return null;
    return { pattern: m[1], replacement: m[2], flags: m[3] ?? '' };
  }

  protected executeExCommand(raw: string): void {
    const trimmed = raw.trim();
    const range = this.parseExRange(trimmed);
    const { start: rangeStart, end: rangeEnd, rest } = range;

    const ligne = rest.trim();
    const parPlage = ligne.match(/^([dy]|j|[<>]|m|co?|t)\s*(\S*)$/);
    if (parPlage !== null && (parPlage[2] === '' || /^(m|co?|t)$/.test(parPlage[1]))) {
      const refus = this.rangeRefusal(range, trimmed);
      if (refus !== null) {
        this._message = refus;
        this._mode = 'normal';
        return;
      }
      const applique = this.applyRangeCommand(range, parPlage[1], parPlage[2]);
      if (applique) {
        this._mode = 'normal';
        return;
      }
    }

    const globalMatch = rest.match(/^g(!)?\/((?:\\.|[^/])*)\/(.*)$/);
    if (globalMatch) {
      const [, , pattern, cmd] = globalMatch;
      this.pushUndoSnapshot();
      this.executeGlobal(rangeStart ?? 0, rangeEnd ?? this.linesArr.length - 1, pattern, cmd);
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

    if (rest === 's' || rest.startsWith('s/')) {
      const parsed = this.parseSubstituteCmd(rest);
      if (!parsed) {
        this._message = 'E486: no previous substitute regular expression';
        this._mode = 'normal';
        return;
      }
      const s = rangeStart ?? this._cursorLine;
      const e = rangeEnd ?? this._cursorLine;
      if (parsed.flags.includes('c')) {
        this.startConfirmSubstitute(s, e, parsed.pattern, parsed.replacement, parsed.flags);
      } else {
        this.pushUndoSnapshot();
        const result = this.executeSubstitute(s, e, parsed.pattern, parsed.replacement, parsed.flags);
        if (result.count > 0) {
          this._modified = true;
          this._message = `${result.count} substitution${result.count === 1 ? '' : 's'} on ${result.lines} line${result.lines === 1 ? '' : 's'}`;
        } else {
          this.undoStack.pop(); // nothing actually changed
          this._message = `E486: Pattern not found: ${parsed.pattern}`;
        }
        this._mode = 'normal';
      }
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
    if (trimmed === 'set number' || trimmed === 'set nu') {
      this.showLineNumbers = true;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set nonumber' || trimmed === 'set nonu') {
      this.showLineNumbers = false;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set relativenumber' || trimmed === 'set rnu') {
      this.showRelativeNumbers = true;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set norelativenumber' || trimmed === 'set nornu') {
      this.showRelativeNumbers = false;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set list') {
      this.listModeEnabled = true;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set nolist') {
      this.listModeEnabled = false;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    const listcharsMatch = trimmed.match(/^set listchars=(.*)$/);
    if (listcharsMatch) {
      for (const part of listcharsMatch[1].split(',')) {
        const [key, ...rest] = part.split(':');
        const val = rest.join(':').replace(/\\ /g, ' ');
        if (key === 'tab') this.listCharsCfg.tab = val;
        else if (key === 'trail') this.listCharsCfg.trail = val;
        else if (key === 'eol') this.listCharsCfg.eol = val;
      }
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set showmatch' || trimmed === 'set sm') {
      this.showMatchEnabled = true;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set noshowmatch' || trimmed === 'set nosm') {
      this.showMatchEnabled = false;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set incsearch') {
      this.incSearchEnabled = true;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set noincsearch') {
      this.incSearchEnabled = false;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set fileencoding?' || trimmed === 'set fenc?') {
      this._message = 'fileencoding=utf-8';
      this._mode = 'normal';
      return;
    }
    const colorColumnMatch = trimmed.match(/^set colorcolumn=(\d+)$/);
    if (colorColumnMatch) {
      this.colorColumnCfg = parseInt(colorColumnMatch[1], 10);
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set colorcolumn=') {
      this.colorColumnCfg = null;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set hlsearch') {
      this.hlsearchEnabled = true;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set nohlsearch') {
      this.hlsearchEnabled = false;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set ignorecase') {
      this.ignoreCaseSearch = true;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set noignorecase') {
      this.ignoreCaseSearch = false;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set autoindent' || trimmed === 'set ai') {
      this.autoindentEnabled = true;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set noautoindent' || trimmed === 'set noai') {
      this.autoindentEnabled = false;
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'syntax on' || trimmed === 'syntax off') {
      this._message = '';
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set filetype?' || trimmed === 'set ft?') {
      this._message = `filetype=${this.detectFiletype()}`;
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'set fileformat?' || trimmed === 'set ff?') {
      this._message = `fileformat=${this._fileFormat}`;
      this._mode = 'normal';
      return;
    }
    const ffSet = trimmed.match(/^set (?:fileformat|ff)=(unix|dos)$/);
    if (ffSet) {
      // Only changes how the file is written on the next save — matches
      // real vim: existing buffer content (including any stray \r left
      // over from corruption) is untouched until explicitly edited out.
      this._fileFormat = ffSet[1] as 'unix' | 'dos';
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

    if (/^set\s+\S/.test(trimmed)) {
      this._message = vimSetRefusal(trimmed.replace(/^set\s+/, ''));
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
    const body = this._fileFormat === 'dos'
      ? `${this.linesArr.join('\r\n')}\r\n`
      : `${this.content}\n`;
    const ok = this.fs.writeFile(path, body);
    if (!ok) {
      this._message = `E212: Can't open file for writing`;
      return false;
    }
    this._modified = false;
    // Real vim reports the byte count actually written (UTF-8), not the
    // in-memory JS string length — they diverge for any multi-byte char.
    const byteLength = new TextEncoder().encode(body).length;
    this._message = `"${path}" ${this.linesArr.length}L, ${byteLength}B written`;
    return true;
  }

  // ── :s substitution (non-interactive) ──────────────────────────────

  private executeSubstitute(startLine: number, endLine: number, pattern: string, replacement: string, flags: string): { count: number; lines: number } {
    const regex = compileVimPattern(pattern, flags.includes('i'));
    let count = 0;
    let linesChanged = 0;
    const lo = Math.max(0, Math.min(startLine, endLine));
    const hi = Math.min(this.linesArr.length - 1, Math.max(startLine, endLine));
    for (let li = lo; li <= hi; li++) {
      let line = this.linesArr[li];
      let col = 0;
      let changed = false;
      for (;;) {
        const m = execFrom(line, regex, col);
        if (!m) break;
        const rep = applyVimReplacement(replacement, m);
        line = line.slice(0, m.index) + rep + line.slice(m.index + m[0].length);
        count++;
        changed = true;
        col = m.index + rep.length;
        if (m[0].length === 0) col++; // guard against infinite loop on empty matches
        if (!flags.includes('g')) break;
      }
      if (changed) { this.linesArr[li] = line; linesChanged++; }
    }
    return { count, lines: linesChanged };
  }

  // ── :g/pattern/cmd global command ───────────────────────────────────

  private executeGlobal(startLine: number, endLine: number, pattern: string, cmd: string): void {
    const regex = compileVimPattern(pattern, false);
    const lo = Math.max(0, Math.min(startLine, endLine));
    const hi = Math.min(this.linesArr.length - 1, Math.max(startLine, endLine));
    const matchingIndices: number[] = [];
    for (let i = lo; i <= hi; i++) {
      if (regex.test(this.linesArr[i])) matchingIndices.push(i);
    }
    let deleted = 0;
    const trimmedCmd = cmd.trim();
    for (const origIdx of matchingIndices) {
      const idx = origIdx - deleted;
      if (trimmedCmd === 'd' || trimmedCmd === 'delete') {
        this.linesArr.splice(idx, 1);
        deleted++;
      } else {
        const parsed = this.parseSubstituteCmd(trimmedCmd);
        if (parsed) this.executeSubstitute(idx, idx, parsed.pattern, parsed.replacement, parsed.flags);
      }
    }
    if (this.linesArr.length === 0) this.linesArr.push('');
    this._cursorLine = Math.min(this._cursorLine, this.linesArr.length - 1);
    if (matchingIndices.length > 0) this._modified = true;
  }

  // ── :s///c interactive confirm ──────────────────────────────────────

  private startConfirmSubstitute(startLine: number, endLine: number, pattern: string, replacement: string, flags: string): void {
    this.pushUndoSnapshot();
    this.substState = {
      rangeEnd: Math.min(this.linesArr.length - 1, Math.max(startLine, endLine)),
      regex: compileVimPattern(pattern, flags.includes('i')),
      replacementTemplate: replacement,
      global: flags.includes('g'),
      currentLine: Math.max(0, Math.min(startLine, endLine)),
      currentCol: 0,
      totalReplaced: 0,
      linesTouched: new Set<number>(),
    };
    if (!this.advanceToNextMatch()) this.finishConfirmSubstitute();
  }

  private advanceToNextMatch(): boolean {
    const st = this.substState;
    if (!st) return false;
    while (st.currentLine <= st.rangeEnd) {
      const line = this.linesArr[st.currentLine];
      const m = execFrom(line, st.regex, st.currentCol);
      if (m) {
        this._pendingMatch = {
          line: st.currentLine,
          start: m.index,
          end: m.index + m[0].length,
          matchText: m[0],
          replacementPreview: applyVimReplacement(st.replacementTemplate, m),
        };
        this._mode = 'confirm-substitute';
        return true;
      }
      st.currentLine++;
      st.currentCol = 0;
    }
    return false;
  }

  private applyPendingMatch(): void {
    const st = this.substState!;
    const pm = this._pendingMatch!;
    const line = this.linesArr[pm.line];
    this.linesArr[pm.line] = line.slice(0, pm.start) + pm.replacementPreview + line.slice(pm.end);
    st.totalReplaced++;
    st.linesTouched.add(pm.line);
    this._modified = true;
    const delta = pm.replacementPreview.length - (pm.end - pm.start);
    if (st.global) { st.currentCol = pm.end + delta; } else { st.currentLine++; st.currentCol = 0; }
  }

  private skipPendingMatch(): void {
    const st = this.substState!;
    const pm = this._pendingMatch!;
    if (st.global) { st.currentCol = pm.end; } else { st.currentLine++; st.currentCol = 0; }
  }

  private applyConfirmSubstKey(k: EditorKeyInput): void {
    const key = k.key.toLowerCase();
    if (k.key === 'Escape' || key === 'q') { this.finishConfirmSubstitute(); return; }
    if (key === 'y') {
      this.applyPendingMatch();
      this._pendingMatch = null;
      if (!this.advanceToNextMatch()) this.finishConfirmSubstitute();
      return;
    }
    if (key === 'n') {
      this.skipPendingMatch();
      this._pendingMatch = null;
      if (!this.advanceToNextMatch()) this.finishConfirmSubstitute();
      return;
    }
    if (key === 'l') {
      this.applyPendingMatch();
      this.finishConfirmSubstitute();
      return;
    }
    if (key === 'a') {
      this.applyPendingMatch();
      this._pendingMatch = null;
      while (this.advanceToNextMatch()) this.applyPendingMatch();
      this._pendingMatch = null;
      this.finishConfirmSubstitute();
      return;
    }
  }

  private finishConfirmSubstitute(): void {
    const st = this.substState;
    this._mode = 'normal';
    this._pendingMatch = null;
    this.substState = null;
    if (st && st.totalReplaced > 0) {
      const n = st.linesTouched.size;
      this._message = `${st.totalReplaced} substitution${st.totalReplaced === 1 ? '' : 's'} on ${n} line${n === 1 ? '' : 's'}`;
    } else {
      this.undoStack.pop(); // nothing was actually confirmed
    }
  }

  // ── SEARCH (/) mode ──────────────────────────────────────────────

  private applySearchKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      if (this.searchBuffer) {
        this.searchHistoryList.push(this.searchBuffer);
        this.performSearch(this.searchBuffer);
      }
      this._mode = 'normal';
      this.historyNavIndex = null;
      return;
    }
    if (k.key === 'Escape') {
      this._mode = 'normal';
      this.historyNavIndex = null;
      return;
    }
    if (k.key === 'ArrowUp') {
      this.searchBuffer = this.recallHistory(this.searchHistoryList, this.searchBuffer);
      return;
    }
    if (k.key === 'ArrowDown') {
      this.searchBuffer = this.advanceHistory(this.searchHistoryList, this.searchBuffer);
      return;
    }
    if (k.key === 'Backspace') {
      this.searchBuffer = this.searchBuffer.slice(0, -1);
      return;
    }
    if (k.key.length === 1) {
      this.searchBuffer += k.key;
    }
  }

  private performSearch(query: string): void {
    this.registers.set('/', { linewise: false, lines: [query] });
    const flatOffset = this.linesArr.slice(0, this._cursorLine).join('\n').length
      + (this._cursorLine > 0 ? 1 : 0) + this._cursorCol;
    const text = this.content;
    const base = compileVimPattern(query, this.ignoreCaseSearch);
    // `m` (multiline) so `^`/`$` anchor to each line's boundaries — matching
    // real vim — rather than only the start/end of the whole buffer. Search
    // the full, unsliced text (not text.slice(flatOffset)) so a `^`-anchored
    // pattern can't spuriously match mid-line at the slice point.
    const regex = new RegExp(base.source, `gm${base.flags}`);
    let idx = -1;
    let wrapped = false;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > flatOffset) { idx = match.index; break; }
      if (match[0].length === 0) regex.lastIndex++;
    }
    if (idx < 0) {
      regex.lastIndex = 0;
      match = regex.exec(text);
      idx = match ? match.index : -1;
      wrapped = true;
    }
    if (idx < 0) {
      this._message = `E486: Pattern not found: ${query}`;
      return;
    }
    const before = text.slice(0, idx).split('\n');
    this._cursorLine = before.length - 1;
    this._cursorCol = before[before.length - 1].length;
    this._message = wrapped ? 'search hit BOTTOM, continuing at TOP' : '';
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
