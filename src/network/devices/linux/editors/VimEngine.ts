import type { EditorFsContext } from './EditorFsContext';
import type { EditorKeyInput } from './EditorKeyInput';
import { dotSwapPathFor } from './editorPaths';

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
  private pendingOperator: 'd' | 'y' | 'c' | null = null;
  private pendingCountStr = '';
  private pendingG = false;
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
  private blockInsertContext: { lines: number[]; col: number; suffixLenAtStart: number } | null = null;

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
    const trailStart = this.listCharsCfg.trail ? line.trimEnd().length : line.length;
    let out = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\t') out += this.listCharsCfg.tab;
      else if (ch === '\r') out += '^M';
      else if (ch === ' ' && i >= trailStart && this.listCharsCfg.trail) out += this.listCharsCfg.trail;
      else out += ch;
    }
    return out + this.listCharsCfg.eol;
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
    if (this._exited) return;

    if (this.isDotReplay || this.isMacroReplay) { this.dispatchByMode(k); this.syncSwapFile(); return; }

    if (this._mode === 'normal' && k.key === '.' && this.pendingOperator === null && !this.pendingG) {
      this.replayDotRepeat();
      return;
    }

    // Macro recording: capture every key between the opening `qa` and the
    // closing `q`, excluding the two keys that toggle recording itself.
    if (this.recordingMacro !== null) {
      const closesRecording = this._mode === 'normal' && k.key === 'q' && !this.awaitingMacroName;
      if (!closesRecording) this.recordingMacro.keys.push(k);
    }

    const wasRecording = this.dotRecording !== null;
    const startingChange = !wasRecording && this._mode === 'normal' && this.pendingOperator === null && !this.pendingG
      && ['i', 'I', 'a', 'A', 'o', 'O', 's', 'S', 'x', 'p', 'P', 'd', 'c', 'r'].includes(k.key);
    if (startingChange) this.dotRecording = [k];
    else if (wasRecording) this.dotRecording!.push(k);

    this.dispatchByMode(k);
    this.syncSwapFile();

    const awaitingFollowUpKey = this.awaitingReplaceChar || this.awaitingRegisterName
      || this.awaitingMacroName || this.awaitingMacroPlayback;
    if (this.dotRecording !== null && this._mode === 'normal' && this.pendingOperator === null && !awaitingFollowUpKey) {
      this.dotRepeat = this.dotRecording;
      this.dotRecording = null;
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
    return `${dir}/.${base}.sw${Date.now()}`;
  }

  private replayDotRepeat(): void {
    if (this.dotRepeat.length === 0) return;
    this.isDotReplay = true;
    for (const k of this.dotRepeat) this.applyKey(k);
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
  }

  private performUndo(): void {
    const snap = this.undoStack.pop();
    if (!snap) { this._message = 'Already at oldest change'; return; }
    this.redoStack.push({ lines: [...this.linesArr], cursorLine: this._cursorLine, cursorCol: this._cursorCol });
    this.linesArr = [...snap.lines];
    this._cursorLine = Math.min(snap.cursorLine, this.linesArr.length - 1);
    this._cursorCol = snap.cursorCol;
    this._modified = true;
    this._message = '';
  }

  private performRedo(): void {
    const snap = this.redoStack.pop();
    if (!snap) { this._message = 'Already at newest change'; return; }
    this.undoStack.push({ lines: [...this.linesArr], cursorLine: this._cursorLine, cursorCol: this._cursorCol });
    this.linesArr = [...snap.lines];
    this._cursorLine = Math.min(snap.cursorLine, this.linesArr.length - 1);
    this._cursorCol = snap.cursorCol;
    this._modified = true;
    this._message = '';
  }

  // ── NORMAL mode ──────────────────────────────────────────────────

  private takeCount(): number | undefined {
    const has = this.pendingCountStr !== '';
    const n = has ? parseInt(this.pendingCountStr, 10) : undefined;
    this.pendingCountStr = '';
    return n;
  }

  private applyNormalKey(k: EditorKeyInput): void {
    const key = k.key;

    if (this.awaitingRegisterName) {
      this.awaitingRegisterName = false;
      if (/^[a-zA-Z*+]$/.test(key)) this.pendingRegister = key;
      return;
    }
    // Register selection only precedes an operator/motion in real vim
    // (`"ayy`, never `y"a`) — with an operator already pending, `"` must
    // fall through to the operator's own motion handling instead (e.g.
    // the `i"`/`a"` text object).
    if (key === '"' && !this.pendingOperator) { this.awaitingRegisterName = true; return; }

    if (this.awaitingReplaceChar) {
      this.awaitingReplaceChar = false;
      if (key.length === 1 && key !== 'Escape') {
        this.pushUndoSnapshot();
        const l = this.line(this._cursorLine);
        if (this._cursorCol < l.length) {
          this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + key + l.slice(this._cursorCol + 1));
          this._modified = true;
        } else {
          this.undoStack.pop();
        }
      }
      return;
    }
    if (key === 'r' && !k.ctrl) { this.awaitingReplaceChar = true; return; }

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
    if (key === '@') { this.awaitingMacroPlayback = true; return; }

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
    if (key === 'q') {
      if (this.recordingMacro) {
        this.macroRegisters.set(this.recordingMacro.name, this.recordingMacro.keys);
        this.recordingMacro = null;
      } else {
        this.awaitingMacroName = true;
      }
      return;
    }

    if (k.ctrl) {
      const lower = key.toLowerCase();
      if (lower === 'r') { this.pendingCountStr = ''; this.performRedo(); return; }
      if (lower === 'f') { const n = this.takeCount() ?? 1; this._cursorLine = Math.min(this.linesArr.length - 1, this._cursorLine + 20 * n); this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol); return; }
      if (lower === 'b') { const n = this.takeCount() ?? 1; this._cursorLine = Math.max(0, this._cursorLine - 20 * n); this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol); return; }
      if (lower === 'v') { this.pendingCountStr = ''; this.enterVisual('visual-block'); return; }
    }

    // Digits accumulate into a count, except a leading '0' which is the
    // "start of line" motion.
    if (/^[0-9]$/.test(key) && !(key === '0' && this.pendingCountStr === '')) {
      this.pendingCountStr += key;
      return;
    }

    if (this.pendingG) {
      this.pendingG = false;
      if (key === 'g') {
        if (this.variant === 'vi') { this._message = ''; this.pendingCountStr = ''; return; } // gg is a vim extension
        const count = this.takeCount();
        this.gotoLine(count !== undefined ? count - 1 : 0);
        return;
      }
      this.pendingCountStr = '';
      return;
    }

    if (this.pendingOperator) {
      return this.applyOperatorMotion(key);
    }

    switch (key) {
      case 'g':
        this.pendingG = true;
        return;
      case 'G': {
        const count = this.takeCount();
        this.gotoLine(count !== undefined ? count - 1 : this.linesArr.length - 1);
        return;
      }
      case 'i': this.enterInsert(); return;
      case 'I': {
        const l = this.line(this._cursorLine);
        const firstNonBlank = l.search(/\S/);
        this._cursorCol = firstNonBlank >= 0 ? firstNonBlank : 0;
        this.enterInsert();
        return;
      }
      case 'a':
        this._cursorCol = Math.min(this.line(this._cursorLine).length, this._cursorCol + 1);
        this.enterInsert();
        return;
      case 'A':
        this._cursorCol = this.line(this._cursorLine).length;
        this.enterInsert();
        return;
      case 'o': {
        this.pushUndoSnapshot();
        const indent = this.autoindentEnabled ? this.line(this._cursorLine).match(/^[ \t]*/)?.[0] ?? '' : '';
        this.linesArr.splice(this._cursorLine + 1, 0, indent);
        this._cursorLine++;
        this._cursorCol = indent.length;
        this._modified = true;
        this.enterInsert();
        return;
      }
      case 'O': {
        this.pushUndoSnapshot();
        const indent = this.autoindentEnabled ? this.line(this._cursorLine).match(/^[ \t]*/)?.[0] ?? '' : '';
        this.linesArr.splice(this._cursorLine, 0, indent);
        this._cursorCol = indent.length;
        this._modified = true;
        this.enterInsert();
        return;
      }
      case 's': {
        this.pushUndoSnapshot();
        const count = this.takeCount() ?? 1;
        const l = this.line(this._cursorLine);
        const removed = l.slice(this._cursorCol, this._cursorCol + count);
        this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + l.slice(this._cursorCol + count));
        this.setRegister({ linewise: false, lines: [removed] });
        this._modified = true;
        this.enterInsert();
        return;
      }
      case 'S': {
        this.pushUndoSnapshot();
        this.setRegister({ linewise: true, lines: [this.line(this._cursorLine)] });
        this.setLine(this._cursorLine, '');
        this._cursorCol = 0;
        this._modified = true;
        this.enterInsert();
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
      case 'x': {
        const count = this.takeCount() ?? 1;
        const l = this.line(this._cursorLine);
        if (this._cursorCol < l.length) {
          this.pushUndoSnapshot();
          const removed = l.slice(this._cursorCol, this._cursorCol + count);
          this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + l.slice(this._cursorCol + count));
          this.setRegister({ linewise: false, lines: [removed] });
          this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol);
          this._modified = true;
        }
        return;
      }
      case 'p': this.pushUndoSnapshot(); this.paste(true); return;
      case 'P': this.pushUndoSnapshot(); this.paste(false); return;
      case 'd': case 'y': case 'c':
        this.pendingOperator = key as 'd' | 'y' | 'c';
        return;
      case 'u':
        this.pendingCountStr = '';
        this.performUndo();
        return;
      case 'h': case 'ArrowLeft':
        this._cursorCol = Math.max(0, this._cursorCol - (this.takeCount() ?? 1));
        return;
      case 'l': case 'ArrowRight':
        this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol + (this.takeCount() ?? 1));
        return;
      case 'j': case 'ArrowDown': {
        const n = this.takeCount() ?? 1;
        this._cursorLine = Math.min(this.linesArr.length - 1, this._cursorLine + n);
        this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol);
        return;
      }
      case 'k': case 'ArrowUp': {
        const n = this.takeCount() ?? 1;
        this._cursorLine = Math.max(0, this._cursorLine - n);
        this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol);
        return;
      }
      case '0':
        this._cursorCol = 0;
        return;
      case '$':
        this.pendingCountStr = '';
        this._cursorCol = Math.max(0, this.line(this._cursorLine).length - 1);
        return;
      case '^': {
        const l = this.line(this._cursorLine);
        const firstNonBlank = l.search(/\S/);
        this._cursorCol = firstNonBlank >= 0 ? firstNonBlank : 0;
        return;
      }
      case 'w': {
        this.pendingCountStr = '';
        const nxt = nextWordStart(this.line(this._cursorLine), this._cursorCol);
        if (nxt !== null) this._cursorCol = nxt;
        else if (this._cursorLine < this.linesArr.length - 1) { this._cursorLine++; this._cursorCol = 0; }
        return;
      }
      case 'b': {
        this.pendingCountStr = '';
        const prv = prevWordStart(this.line(this._cursorLine), this._cursorCol);
        if (prv !== null) this._cursorCol = prv;
        else if (this._cursorLine > 0) { this._cursorLine--; this._cursorCol = Math.max(0, this.line(this._cursorLine).length - 1); }
        return;
      }
      case 'e': {
        this.pendingCountStr = '';
        const end = wordRunEnd(this.line(this._cursorLine), this._cursorCol) - 1;
        this._cursorCol = Math.max(this._cursorCol, end);
        return;
      }
      case 'W': {
        this.pendingCountStr = '';
        const nxt = nextWordStart(this.line(this._cursorLine), this._cursorCol, true);
        if (nxt !== null) this._cursorCol = nxt;
        else if (this._cursorLine < this.linesArr.length - 1) { this._cursorLine++; this._cursorCol = 0; }
        return;
      }
      case 'B': {
        this.pendingCountStr = '';
        const prv = prevWordStart(this.line(this._cursorLine), this._cursorCol, true);
        if (prv !== null) this._cursorCol = prv;
        else if (this._cursorLine > 0) { this._cursorLine--; this._cursorCol = Math.max(0, this.line(this._cursorLine).length - 1); }
        return;
      }
      case 'E': {
        this.pendingCountStr = '';
        const end = wordRunEnd(this.line(this._cursorLine), this._cursorCol, true) - 1;
        this._cursorCol = Math.max(this._cursorCol, end);
        return;
      }
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

  private gotoLine(idx: number): void {
    this._cursorLine = Math.max(0, Math.min(idx, this.linesArr.length - 1));
    const l = this.line(this._cursorLine);
    const firstNonBlank = l.search(/\S/);
    this._cursorCol = firstNonBlank >= 0 ? firstNonBlank : 0;
  }

  private setLine(i: number, text: string): void { this.linesArr[i] = text; }

  /**
   * Resolve and perform a mark-jump triggered from NORMAL mode (`` `x ``,
   * `'x`, ``` `` ```, `''`). `key` is the second key of the pair; for the
   * "jump back" pair (`` `` ``/`''`) it repeats the same character used to
   * enter the awaiting state, which this treats as "use lastJumpPosition"
   * rather than a mark named backtick/quote (neither is a valid mark name).
   */
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
    this._mode = 'insert';
    this._message = this.variant === 'vim' ? '-- INSERT --' : '';
  }

  // ── Operator + motion (dd, yy, cw, dw, cc, ...) ────────────────────

  private applyOperatorMotion(key: string): void {
    const op = this.pendingOperator!;
    const count = this.takeCount() ?? 1;

    // Two-key operator motions ("awaiting second key" sub-states) are
    // consumed first, before either one's own trigger key is checked —
    // otherwise an armed text object's second key (e.g. the `'` in `ci'`)
    // could be misread as arming a *different* two-key motion instead of
    // resolving the one already pending.
    if (this.operatorPendingMarkMode) {
      const linewise = this.operatorPendingMarkMode === 'line';
      this.operatorPendingMarkMode = null;
      this.resolveMarkOperatorMotion(op, key, linewise);
      return;
    }
    if (this.operatorPendingTextObjectKind) {
      const kind = this.operatorPendingTextObjectKind;
      this.operatorPendingTextObjectKind = null;
      this.resolveTextObjectMotion(op, kind, key);
      return;
    }

    // A mark used as an operator's motion (`` d`a ``, `d'a`, ...) — the
    // first ` or ' just arms this and keeps the operator pending; the
    // following key (a mark name, or a repeated `/'`) resolves it.
    if (key === '`' || key === "'") {
      this.operatorPendingMarkMode = key === '`' ? 'exact' : 'line';
      return;
    }

    // A text object (`iw`, `a"`, `i(`, ...) — `i`/`a` arms this and keeps
    // the operator pending; the following key (the object) resolves it.
    if (key === 'i' || key === 'a') {
      this.operatorPendingTextObjectKind = key;
      return;
    }

    // Doubled operator (dd/yy/cc) → linewise on `count` lines from cursor.
    if (key === op || (op === 'c' && key === 'c') || (key === 'd' && op === 'd') || (key === 'y' && op === 'y')) {
      const n = Math.min(count, this.linesArr.length - this._cursorLine);
      let removed: string[];
      if (op === 'y') {
        removed = this.linesArr.slice(this._cursorLine, this._cursorLine + n);
      } else {
        this.pushUndoSnapshot();
        removed = this.linesArr.splice(this._cursorLine, n);
      }
      this.setRegister({ linewise: true, lines: removed });
      if (op === 'c') {
        // Real vim's linewise "change" always leaves exactly one blank
        // line at the removal point to type into, regardless of how many
        // lines were removed — not just when the buffer became empty.
        this.linesArr.splice(this._cursorLine, 0, '');
        this._cursorCol = 0;
        this._modified = true;
      } else if (op === 'd') {
        if (this.linesArr.length === 0) this.linesArr.push('');
        this._cursorLine = Math.min(this._cursorLine, this.linesArr.length - 1);
        this._cursorCol = 0;
        this._modified = true;
      }
      this._message = op === 'y' ? `${n} line${n === 1 ? '' : 's'} yanked` : '';
      this.pendingOperator = null;
      if (op === 'c') this.enterInsert();
      return;
    }

    if (key === 'w' || key === 'e') {
      // cw/dw/yw act like ce/de/ye when starting on a non-blank char
      // (classic vim special-case for the change-word family).
      const l = this.line(this._cursorLine);
      const end = wordRunEnd(l, this._cursorCol);
      const removedText = l.slice(this._cursorCol, end);
      this.applyCharwiseOperator(op, removedText);
      this.pendingOperator = null;
      return;
    }

    if (key === '$') {
      const l = this.line(this._cursorLine);
      const removedText = l.slice(this._cursorCol);
      this.applyCharwiseOperator(op, removedText);
      this.pendingOperator = null;
      return;
    }

    // Unknown motion after operator — real vim just cancels (rings bell).
    this.pendingOperator = null;
  }

  /**
   * Resolve `d`{mark}`, `d'{mark}`, and the `` `` ``/`''` jump-back
   * variants used as an operator's motion. `linewise` mirrors the
   * backtick/quote distinction of a bare mark-jump: `'` always acts on
   * whole lines (multi-line safe); `` ` `` is an exclusive charwise
   * motion, which this engine's charwise machinery only resolves when
   * mark and cursor share a line (see the scenario's test docstring for
   * the disclosed scope) — a cross-line `` `mark `` motion cancels, like
   * any other unrecognized motion after an operator.
   */
  private resolveMarkOperatorMotion(op: 'd' | 'y' | 'c', key: string, linewise: boolean): void {
    const isBackToggle = (!linewise && key === '`') || (linewise && key === "'");
    const target = isBackToggle ? this.lastJumpPosition : (this.marks.get(key) ?? null);
    if (!target) {
      this.pendingOperator = null;
      return;
    }

    if (linewise) {
      const lo = Math.min(this._cursorLine, target.line);
      const hi = Math.max(this._cursorLine, target.line);
      let removed: string[];
      if (op === 'y') {
        removed = this.linesArr.slice(lo, hi + 1);
      } else {
        this.pushUndoSnapshot();
        removed = this.linesArr.splice(lo, hi - lo + 1);
      }
      this.setRegister({ linewise: true, lines: removed });
      if (op === 'c') {
        this.linesArr.splice(lo, 0, '');
        this._cursorLine = lo;
        this._cursorCol = 0;
        this._modified = true;
      } else if (op === 'd') {
        if (this.linesArr.length === 0) this.linesArr.push('');
        this._cursorLine = Math.min(lo, this.linesArr.length - 1);
        this._cursorCol = 0;
        this._modified = true;
      }
      this._message = op === 'y' ? `${removed.length} line${removed.length === 1 ? '' : 's'} yanked` : '';
      this.pendingOperator = null;
      if (op === 'c') this.enterInsert();
      return;
    }

    if (target.line !== this._cursorLine) {
      this.pendingOperator = null;
      return;
    }
    const lo = Math.min(this._cursorCol, target.col);
    const hi = Math.max(this._cursorCol, target.col);
    const l = this.line(this._cursorLine);
    const removedText = l.slice(lo, hi);
    this.applyCharwiseOperator(op, removedText, lo);
    this.pendingOperator = null;
  }

  private resolveTextObjectMotion(op: 'd' | 'y' | 'c', kind: 'i' | 'a', objectKey: string): void {
    const range = this.computeTextObjectRange(kind, objectKey);
    if (!range) { this.pendingOperator = null; return; }
    const l = this.line(this._cursorLine);
    const removedText = l.slice(range.start, range.end);
    this.applyCharwiseOperator(op, removedText, range.start);
    this.pendingOperator = null;
  }

  private computeTextObjectRange(kind: 'i' | 'a', objectKey: string): { start: number; end: number } | null {
    const l = this.line(this._cursorLine);
    const col = this._cursorCol;

    if (objectKey === 'w') {
      if (l.length === 0) return null;
      const c = col < l.length ? col : l.length - 1;
      const cls = charClass(l[c]);
      let start = c, end = c + 1;
      while (start > 0 && charClass(l[start - 1]) === cls) start--;
      while (end < l.length && charClass(l[end]) === cls) end++;
      if (kind === 'i') return { start, end };
      if (end < l.length && charClass(l[end]) === 0) {
        let e2 = end;
        while (e2 < l.length && charClass(l[e2]) === 0) e2++;
        return { start, end: e2 };
      }
      let s2 = start;
      while (s2 > 0 && charClass(l[s2 - 1]) === 0) s2--;
      return { start: s2, end };
    }

    if (objectKey === '"' || objectKey === "'") {
      const pair = findQuotePair(l, col, objectKey);
      if (!pair) return null;
      if (kind === 'i') return { start: pair.start + 1, end: pair.end };
      return this.expandTextObjectForA(l, pair.start, pair.end);
    }

    const bracketChars: Record<string, [string, string]> = {
      '(': ['(', ')'], ')': ['(', ')'], b: ['(', ')'],
      '{': ['{', '}'], '}': ['{', '}'], B: ['{', '}'],
      '[': ['[', ']'], ']': ['[', ']'],
    };
    const pairChars = bracketChars[objectKey];
    if (pairChars) {
      const [open, close] = pairChars;
      const pair = findEnclosingBracketPair(l, col, open, close);
      if (!pair) return null;
      if (kind === 'i') return { start: pair.start + 1, end: pair.end };
      return this.expandTextObjectForA(l, pair.start, pair.end);
    }

    return null;
  }

  /** "a"-variant expansion shared by quotes/brackets: include the delimiters, then prefer trailing whitespace, else leading — the same rule `aw` uses. */
  private expandTextObjectForA(l: string, start: number, end: number): { start: number; end: number } {
    let s = start, e = end + 1;
    if (e < l.length && /\s/.test(l[e])) {
      while (e < l.length && /\s/.test(l[e])) e++;
    } else {
      while (s > 0 && /\s/.test(l[s - 1])) s--;
    }
    return { start: s, end: e };
  }

  private applyCharwiseOperator(op: 'd' | 'y' | 'c', text: string, atCol?: number): void {
    this.setRegister({ linewise: false, lines: [text] });
    const col = atCol ?? this._cursorCol;
    if (op !== 'y') {
      this.pushUndoSnapshot();
      const l = this.line(this._cursorLine);
      this.setLine(this._cursorLine, l.slice(0, col) + l.slice(col + text.length));
      this._cursorCol = col;
      this._modified = true;
    }
    if (op === 'c') this.enterInsert();
  }

  private paste(after: boolean): void {
    const reg = this.activeRegister();
    if (!reg || reg.lines.length === 0) return;
    if (reg.linewise) {
      const at = after ? this._cursorLine + 1 : this._cursorLine;
      this.linesArr.splice(at, 0, ...reg.lines);
      this._cursorLine = at;
      this._message = `${reg.lines.length} line${reg.lines.length === 1 ? '' : 's'} pasted`;
    } else {
      const l = this.line(this._cursorLine);
      const at = after ? Math.min(this._cursorCol + 1, l.length) : this._cursorCol;
      this.setLine(this._cursorLine, l.slice(0, at) + reg.lines[0] + l.slice(at));
    }
    this._modified = true;
  }

  // ── Shared cursor motions (used by NORMAL fallback-free callers and VISUAL) ──

  private tryMotion(key: string): boolean {
    switch (key) {
      case 'h': case 'ArrowLeft':
        this._cursorCol = Math.max(0, this._cursorCol - (this.takeCount() ?? 1));
        return true;
      case 'l': case 'ArrowRight':
        this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol + (this.takeCount() ?? 1));
        return true;
      case 'j': case 'ArrowDown': {
        const n = this.takeCount() ?? 1;
        this._cursorLine = Math.min(this.linesArr.length - 1, this._cursorLine + n);
        this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol);
        return true;
      }
      case 'k': case 'ArrowUp': {
        const n = this.takeCount() ?? 1;
        this._cursorLine = Math.max(0, this._cursorLine - n);
        this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol);
        return true;
      }
      case '0':
        this._cursorCol = 0;
        return true;
      case '$':
        this.pendingCountStr = '';
        this._cursorCol = Math.max(0, this.line(this._cursorLine).length - 1);
        return true;
      case '^': {
        const l = this.line(this._cursorLine);
        const firstNonBlank = l.search(/\S/);
        this._cursorCol = firstNonBlank >= 0 ? firstNonBlank : 0;
        return true;
      }
      case 'w': {
        this.pendingCountStr = '';
        const nxt = nextWordStart(this.line(this._cursorLine), this._cursorCol);
        if (nxt !== null) this._cursorCol = nxt;
        else if (this._cursorLine < this.linesArr.length - 1) { this._cursorLine++; this._cursorCol = 0; }
        return true;
      }
      case 'b': {
        this.pendingCountStr = '';
        const prv = prevWordStart(this.line(this._cursorLine), this._cursorCol);
        if (prv !== null) this._cursorCol = prv;
        else if (this._cursorLine > 0) { this._cursorLine--; this._cursorCol = Math.max(0, this.line(this._cursorLine).length - 1); }
        return true;
      }
      case 'e': {
        this.pendingCountStr = '';
        const end = wordRunEnd(this.line(this._cursorLine), this._cursorCol) - 1;
        this._cursorCol = Math.max(this._cursorCol, end);
        return true;
      }
      case 'W': {
        this.pendingCountStr = '';
        const nxt = nextWordStart(this.line(this._cursorLine), this._cursorCol, true);
        if (nxt !== null) this._cursorCol = nxt;
        else if (this._cursorLine < this.linesArr.length - 1) { this._cursorLine++; this._cursorCol = 0; }
        return true;
      }
      case 'B': {
        this.pendingCountStr = '';
        const prv = prevWordStart(this.line(this._cursorLine), this._cursorCol, true);
        if (prv !== null) this._cursorCol = prv;
        else if (this._cursorLine > 0) { this._cursorLine--; this._cursorCol = Math.max(0, this.line(this._cursorLine).length - 1); }
        return true;
      }
      case 'E': {
        this.pendingCountStr = '';
        const end = wordRunEnd(this.line(this._cursorLine), this._cursorCol, true) - 1;
        this._cursorCol = Math.max(this._cursorCol, end);
        return true;
      }
      case 'G': {
        const count = this.takeCount();
        this.gotoLine(count !== undefined ? count - 1 : this.linesArr.length - 1);
        return true;
      }
      default:
        return false;
    }
  }

  // ── VISUAL / VISUAL LINE / VISUAL BLOCK ─────────────────────────────

  private enterVisual(mode: 'visual' | 'visual-line' | 'visual-block'): void {
    this.visualAnchorLine = this._cursorLine;
    this.visualAnchorCol = this._cursorCol;
    this._mode = mode;
  }

  private exitVisual(): void {
    this.lastVisualStart = Math.min(this.visualAnchorLine, this._cursorLine);
    this.lastVisualEnd = Math.max(this.visualAnchorLine, this._cursorLine);
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

    if (/^[0-9]$/.test(key) && !(key === '0' && this.pendingCountStr === '')) {
      this.pendingCountStr += key;
      return;
    }
    if (this.pendingG) {
      this.pendingG = false;
      if (key === 'g') {
        if (this.variant === 'vi') { this.pendingCountStr = ''; return; }
        const count = this.takeCount();
        this.gotoLine(count !== undefined ? count - 1 : 0);
        return;
      }
      this.pendingCountStr = '';
      return;
    }
    if (key === 'g') { this.pendingG = true; return; }
    if (this.tryMotion(key)) return;

    if (key === 'Escape') { this.exitVisual(); return; }
    if (key === 'v') { if (this._mode === 'visual') this.exitVisual(); else this._mode = 'visual'; return; }
    if (key === 'V') { if (this._mode === 'visual-line') this.exitVisual(); else this._mode = 'visual-line'; return; }
    if (k.ctrl && key.toLowerCase() === 'v') { if (this._mode === 'visual-block') this.exitVisual(); else this._mode = 'visual-block'; return; }
    if (key === 'd' || key === 'x') { this.applyVisualOperator('d'); return; }
    if (key === 'y') { this.applyVisualOperator('y'); return; }
    if (key === 'c') { this.applyVisualOperator('c'); return; }
    if (key === '>') { this.indentVisualSelection(1); return; }
    if (key === '<') { this.indentVisualSelection(-1); return; }
    if (key === 'I' && this._mode === 'visual-block') { this.beginBlockInsert(); return; }
    if (key === ':') {
      this.lastVisualStart = Math.min(this.visualAnchorLine, this._cursorLine);
      this.lastVisualEnd = Math.max(this.visualAnchorLine, this._cursorLine);
      this.commandBuffer = "'<,'>";
      this._mode = 'command';
      return;
    }
  }

  private applyVisualOperator(op: 'd' | 'y' | 'c'): void {
    const mode = this._mode;
    if (op !== 'y') this.pushUndoSnapshot();

    if (mode === 'visual-line') {
      const lo = Math.min(this.visualAnchorLine, this._cursorLine);
      const hi = Math.max(this.visualAnchorLine, this._cursorLine);
      const removed = op === 'y' ? this.linesArr.slice(lo, hi + 1) : this.linesArr.splice(lo, hi - lo + 1);
      this.setRegister({ linewise: true, lines: removed });
      if (op !== 'y') {
        if (this.linesArr.length === 0) this.linesArr.push('');
        this._cursorLine = Math.min(lo, this.linesArr.length - 1);
        this._cursorCol = 0;
        this._modified = true;
      }
      this._mode = 'normal';
      if (op === 'c') { this.linesArr.splice(this._cursorLine, 0, ''); this.enterInsert(); }
      return;
    }

    if (mode === 'visual-block') {
      const lo = Math.min(this.visualAnchorLine, this._cursorLine);
      const hi = Math.max(this.visualAnchorLine, this._cursorLine);
      const cLo = Math.min(this.visualAnchorCol, this._cursorCol);
      const cHi = Math.max(this.visualAnchorCol, this._cursorCol);
      const removed: string[] = [];
      for (let i = lo; i <= hi; i++) {
        const l = this.line(i);
        removed.push(l.slice(cLo, cHi + 1));
        if (op !== 'y') this.setLine(i, l.slice(0, cLo) + l.slice(cHi + 1));
      }
      this.setRegister({ linewise: false, lines: removed });
      this._cursorLine = lo;
      this._cursorCol = cLo;
      if (op !== 'y') this._modified = true;
      this._mode = 'normal';
      if (op === 'c') this.enterInsert();
      return;
    }

    // charwise 'visual'
    const { startLine, startCol, endLine, endCol } = this.visualBounds();
    let removed: string[];
    if (startLine === endLine) {
      const l = this.line(startLine);
      removed = [l.slice(startCol, endCol + 1)];
      if (op !== 'y') this.setLine(startLine, l.slice(0, startCol) + l.slice(endCol + 1));
    } else {
      const firstText = this.line(startLine).slice(startCol);
      const lastText = this.line(endLine).slice(0, endCol + 1);
      const middle = this.linesArr.slice(startLine + 1, endLine);
      removed = [firstText, ...middle, lastText];
      if (op !== 'y') {
        this.setLine(startLine, this.line(startLine).slice(0, startCol) + this.line(endLine).slice(endCol + 1));
        this.linesArr.splice(startLine + 1, endLine - startLine);
      }
    }
    this.setRegister({ linewise: false, lines: removed });
    this._cursorLine = startLine;
    this._cursorCol = this.clampCol(startLine, startCol);
    if (op !== 'y') this._modified = true;
    this._mode = 'normal';
    if (op === 'c') this.enterInsert();
  }

  private indentVisualSelection(direction: 1 | -1): void {
    const lo = Math.min(this.visualAnchorLine, this._cursorLine);
    const hi = Math.max(this.visualAnchorLine, this._cursorLine);
    this.pushUndoSnapshot();
    const shift = '    '; // shiftwidth
    for (let i = lo; i <= hi; i++) {
      const l = this.line(i);
      if (direction === 1) {
        this.setLine(i, shift + l);
      } else {
        const strip = Math.min(shift.length, l.match(/^ */)?.[0].length ?? 0);
        this.setLine(i, l.slice(strip));
      }
    }
    this._cursorLine = lo;
    this._cursorCol = 0;
    this._modified = true;
    this._mode = 'normal';
  }

  private beginBlockInsert(): void {
    const lo = Math.min(this.visualAnchorLine, this._cursorLine);
    const hi = Math.max(this.visualAnchorLine, this._cursorLine);
    const col = Math.min(this.visualAnchorCol, this._cursorCol);
    this.pushUndoSnapshot();
    this._cursorLine = lo;
    this._cursorCol = col;
    this.blockInsertContext = {
      lines: [],
      col,
      suffixLenAtStart: this.line(lo).length - col,
    };
    for (let i = lo + 1; i <= hi; i++) this.blockInsertContext.lines.push(i);
    this._mode = 'insert';
    this._message = this.variant === 'vim' ? '-- INSERT --' : '';
  }

  // ── INSERT mode ──────────────────────────────────────────────────

  private applyInsertKey(k: EditorKeyInput): void {
    if (k.key === 'Escape' || (k.ctrl && k.key === '[')) {
      if (this.blockInsertContext) this.finishBlockInsert();
      this._cursorCol = Math.max(0, this._cursorCol - 1);
      this._mode = 'normal';
      this._message = '';
      return;
    }
    if (k.ctrl && k.key.toLowerCase() === 'h') { this.insertBackspace(); return; }
    if (k.ctrl && k.key.toLowerCase() === 'w') { this.insertDeleteWordBack(); return; }
    if (k.ctrl && k.key.toLowerCase() === 'u') { this.insertDeleteToLineStart(); return; }

    switch (k.key) {
      case 'Backspace': this.insertBackspace(); return;
      case 'Enter': {
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
        return;
      }
      default:
        if (k.key.length === 1 && !k.ctrl && !k.alt) {
          const l = this.line(this._cursorLine);
          this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + k.key + l.slice(this._cursorCol));
          this._cursorCol++;
          this._modified = true;
        }
        return;
    }
  }

  private insertBackspace(): void {
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
      const padded = l.length < ctx.col ? l + ' '.repeat(ctx.col - l.length) : l;
      this.setLine(lineIdx, padded.slice(0, ctx.col) + insertedText + padded.slice(ctx.col));
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
  private parseExRange(s: string): { start: number | null; end: number | null; rest: string } {
    if (s.startsWith('%')) return { start: 0, end: this.linesArr.length - 1, rest: s.slice(1) };
    const m = s.match(/^(\$|\.|'<|'>|\d+)(?:,(\$|\.|'<|'>|\d+))?/);
    if (!m) return { start: null, end: null, rest: s };
    const resolve = (tok: string) => {
      if (tok === '$') return this.linesArr.length - 1;
      if (tok === '.') return this._cursorLine;
      if (tok === "'<") return this.lastVisualStart;
      if (tok === "'>") return this.lastVisualEnd;
      return parseInt(tok, 10) - 1;
    };
    const start = resolve(m[1]);
    const end = m[2] !== undefined ? resolve(m[2]) : start;
    return { start, end, rest: s.slice(m[0].length) };
  }

  private parseSubstituteCmd(s: string): { pattern: string; replacement: string; flags: string } | null {
    const m = s.match(/^s\/((?:\\.|[^/])*)\/((?:\\.|[^/])*)(?:\/([a-zA-Z]*))?$/);
    if (!m) return null;
    return { pattern: m[1], replacement: m[2], flags: m[3] ?? '' };
  }

  protected executeExCommand(raw: string): void {
    const trimmed = raw.trim();
    const { start: rangeStart, end: rangeEnd, rest } = this.parseExRange(trimmed);

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
