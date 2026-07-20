import type { EditorFsContext } from './EditorFsContext';
import type { EditorKeyInput } from './EditorKeyInput';
import { dotSwapPathFor } from './editorPaths';

export type NanoMode =
  | 'edit' | 'save-prompt' | 'exit-save-prompt' | 'search'
  | 'replace-search' | 'replace-with' | 'replace-confirm' | 'goto-line';

/**
 * Lines a PageUp/PageDown jumps by. Real nano ties this to the terminal
 * window's actual row count; this headless engine has no live viewport,
 * so — like VimEditor's own `visibleLineCount` assumption — a fixed
 * value approximates "a screen's worth" well enough for chunked
 * navigation through a long file.
 */
const PAGE_SIZE = 30;

export interface PendingReplaceMatch {
  line: number;
  start: number;
  end: number;
  matchText: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** displayContent's rendering of a single raw character: `\t`/`\n` pass
 *  through unchanged, control bytes (< 0x20, plus DEL) become `^X`. */
function displayNotation(ch: string): string {
  if (ch === '\t' || ch === '\n') return ch;
  const code = ch.charCodeAt(0);
  if (code < 0x20) return '^' + String.fromCharCode(code + 64);
  if (code === 0x7f) return '^?';
  return ch;
}

/** Width (1 or 2) that a single raw character occupies in displayContent. */
function displayWidth(ch: string): number {
  return displayNotation(ch).length;
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
  private _statusMessage: string;
  private _exited = false;
  private _savedOnExit = false;
  private saveFileNameBuffer: string;
  private gotoLineBuffer = '';
  private searchQueryBuffer = '';
  private lastSearchTerm = '';
  // Up/Down history recall in the Search: prompt, scoped to this session.
  private searchHistoryList: string[] = [];
  private historyNavIndex: number | null = null;
  private historyNavStash = '';
  private useRegex = false;
  private replaceSearchBuffer = '';
  private replaceWithBuffer = '';
  private replaceState: { regex: RegExp; replacement: string; currentLine: number; currentCol: number; totalReplaced: number } | null = null;
  private _pendingReplaceMatch: PendingReplaceMatch | null = null;
  private cutBuffer: string[] = [];
  private lastActionWasCut = false;
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
    private readonly _readOnly = false,
  ) {
    const body = initialContent.endsWith('\n') ? initialContent.slice(0, -1) : initialContent;
    this.linesArr = body.length === 0 && initialContent.length === 0 ? [''] : body.split('\n');
    this._statusMessage = _readOnly
      ? '[ View mode ]'
      : isNewFile
        ? '[ New File ]'
        : `[ Read ${this.linesArr.length} line${this.linesArr.length === 1 ? '' : 's'} ]`;
    this.saveFileNameBuffer = filePath;
    this.lockPath = dotSwapPathFor(fs.resolvePath(filePath));
    // GNU nano creates a `.<file>.swp` lock file for the duration of the
    // editing session to prevent two nano instances from editing the same
    // file concurrently; removed on clean exit (see swapFilePath below).
    // View mode (-v) never locks — it never intends to write.
    if (!_readOnly) this.fs.writeFile(this.lockPath, `nano lock: ${filePath}\n`);
  }

  // ── Public state (read-only) ──────────────────────────────────────

  get content(): string { return this.linesArr.join('\n'); }
  /**
   * Real nano always renders non-printable control bytes as `^X` (never
   * the raw byte, which would corrupt the terminal) — unlike vim's opt-in
   * `:set list`, this isn't a toggle. Tab and newline stay real characters
   * (they're structural, not garbage); everything else below 0x20, plus
   * DEL (0x7f), gets the caret notation.
   */
  get displayContent(): string {
    let out = '';
    for (const ch of this.content) out += displayNotation(ch);
    return out;
  }
  /**
   * Flat offset into `displayContent` for the current cursor — the
   * caret position the textarea must show. Differs from a plain raw
   * offset whenever a control character before the cursor expanded to
   * the two-character `^X` notation.
   */
  get displayCursorOffset(): number {
    let offset = 0;
    for (let i = 0; i < this._cursorLine; i++) {
      for (const ch of this.line(i)) offset += displayWidth(ch);
      offset += 1; // newline
    }
    const cur = this.line(this._cursorLine);
    for (let i = 0; i < this._cursorCol; i++) offset += displayWidth(cur[i]);
    return offset;
  }
  /** What gets written to disk: buffer content plus the trailing newline nano always restores on save. */
  private serialize(): string { return this.linesArr.join('\n') + '\n'; }
  get lines(): readonly string[] { return this.linesArr; }
  get mode(): NanoMode { return this._mode; }
  get cursorLine(): number { return this._cursorLine; }
  get cursorCol(): number { return this._cursorCol; }
  get modified(): boolean { return this._modified; }
  get statusMessage(): string { return this._statusMessage; }
  get exited(): boolean { return this._exited; }
  get savedOnExit(): boolean { return this._savedOnExit; }
  get saveFileName(): string { return this.saveFileNameBuffer; }
  get gotoLineQuery(): string { return this.gotoLineBuffer; }
  get searchQuery(): string { return this.searchQueryBuffer; }
  get swapFilePath(): string { return this.lockPath; }
  get swapFileExists(): boolean { return this.fs.exists(this.lockPath); }
  /** True when opened with `-v` (view mode) — real nano refuses all edits and offers no Write Out. */
  get isReadOnly(): boolean { return this._readOnly; }
  /** Real nano's regex-search toggle (Meta+R / Alt+R inside a search or replace prompt). */
  get regexSearchEnabled(): boolean { return this.useRegex; }
  get replaceSearchQuery(): string { return this.replaceSearchBuffer; }
  get replaceWithText(): string { return this.replaceWithBuffer; }
  get pendingReplaceMatch(): PendingReplaceMatch | null { return this._pendingReplaceMatch; }

  // ── Key dispatch ─────────────────────────────────────────────────

  applyKey(k: EditorKeyInput): void {
    if (this._exited) return;
    switch (this._mode) {
      case 'edit': return this.applyEditKey(k);
      case 'save-prompt': return this.applySavePromptKey(k);
      case 'exit-save-prompt': return this.applyExitSavePromptKey(k);
      case 'search': return this.applySearchKey(k);
      case 'replace-search': return this.applyReplaceSearchKey(k);
      case 'replace-with': return this.applyReplaceWithKey(k);
      case 'replace-confirm': return this.applyReplaceConfirmKey(k);
      case 'goto-line': return this.applyGotoLineKey(k);
    }
  }

  /**
   * Move the cursor to the raw (line, col) position corresponding to a
   * flat offset into `displayContent` — the inverse of
   * `displayCursorOffset`. Drives mouse-click cursor placement: the
   * textarea shows `displayContent`, so a click's `selectionStart` is a
   * display-space offset that must be mapped back through any `^X`
   * control-char expansion before touching the buffer.
   */
  moveCursorToDisplayOffset(offset: number): void {
    if (this._mode !== 'edit') return;
    let remaining = offset;
    for (let line = 0; line < this.linesArr.length; line++) {
      const text = this.linesArr[line];
      for (let col = 0; col < text.length; col++) {
        const w = displayWidth(text[col]);
        if (remaining < w) { this.setCursor(line, col); return; }
        remaining -= w;
      }
      if (remaining === 0) { this.setCursor(line, text.length); return; }
      remaining -= 1; // newline
    }
    const lastLine = Math.max(0, this.linesArr.length - 1);
    this.setCursor(lastLine, this.line(lastLine).length);
  }

  private setCursor(line: number, col: number): void {
    this._cursorLine = line;
    this._cursorCol = col;
    this.lastEditKind = null;
  }

  /**
   * Insert pasted text at the cursor (edit mode) or append it to the
   * active prompt field (search/replace/save-name — single-line, so
   * embedded newlines are dropped past the first). No bracketed-paste
   * distinction is modeled: characters land exactly as if typed very
   * fast, so a literal Tab in the clipboard still inserts `\t` even
   * though the Tab *key* is otherwise unbound in edit mode.
   */
  applyPaste(text: string): void {
    if (this._exited || !text) return;
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    switch (this._mode) {
      case 'edit':
        this.pasteIntoBuffer(normalized);
        return;
      case 'save-prompt':
        this.saveFileNameBuffer += normalized.split('\n')[0];
        return;
      case 'search':
        this.searchQueryBuffer += normalized.split('\n')[0];
        return;
      case 'replace-search':
        this.replaceSearchBuffer += normalized.split('\n')[0];
        return;
      case 'replace-with':
        this.replaceWithBuffer += normalized.split('\n')[0];
        return;
      case 'goto-line':
        this.gotoLineBuffer += normalized.split('\n')[0];
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
      return;
    }

    switch (k.key) {
      case 'ArrowLeft':
        if (this._cursorCol > 0) this._cursorCol--;
        else if (this._cursorLine > 0) { this._cursorLine--; this._cursorCol = this.line(this._cursorLine).length; }
        this.lastEditKind = null;
        return;
      case 'ArrowRight':
        if (this._cursorCol < this.line(this._cursorLine).length) this._cursorCol++;
        else if (this._cursorLine < this.linesArr.length - 1) { this._cursorLine++; this._cursorCol = 0; }
        this.lastEditKind = null;
        return;
      case 'ArrowUp':
        if (this._cursorLine > 0) { this._cursorLine--; this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol); }
        this.lastEditKind = null;
        return;
      case 'ArrowDown':
        if (this._cursorLine < this.linesArr.length - 1) { this._cursorLine++; this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol); }
        this.lastEditKind = null;
        return;
      case 'Home':
        this._cursorCol = 0;
        this.lastEditKind = null;
        return;
      case 'End':
        this._cursorCol = this.line(this._cursorLine).length;
        this.lastEditKind = null;
        return;
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
    const key = k.key.toLowerCase();
    // View mode (-v): no Write Out, Cut, Paste, or Replace — real nano
    // simply has no such shortcuts bound while read-only.
    if (this._readOnly && (key === 'o' || key === 'k' || key === 'u' || key === '\\')) {
      return;
    }
    switch (key) {
      case 'o': // Write Out
        this.saveFileNameBuffer = this.filePath;
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
      case 'k': { // Cut line
        if (this._cursorLine < this.linesArr.length) {
          this.beginDiscreteEdit();
          const cut = this.linesArr[this._cursorLine];
          this.cutBuffer = this.lastActionWasCut ? [...this.cutBuffer, cut] : [cut];
          this.linesArr.splice(this._cursorLine, 1);
          if (this.linesArr.length === 0) this.linesArr.push('');
          this._cursorCol = 0;
          this._modified = true;
          this._statusMessage = 'Cut 1 line';
          this.lastActionWasCut = true;
        }
        return;
      }
      case 'u': // Paste (uncut)
        if (this.cutBuffer.length > 0) {
          this.beginDiscreteEdit();
          this.linesArr.splice(this._cursorLine, 0, ...this.cutBuffer);
          this._modified = true;
          this._statusMessage = `Pasted ${this.cutBuffer.length} line(s)`;
        }
        this.lastActionWasCut = false;
        return;
      case 'w': // Where Is (search) — prefilled with the last search term, like real nano
        this.searchQueryBuffer = this.lastSearchTerm;
        this._mode = 'search';
        this.historyNavIndex = null;
        this.lastActionWasCut = false;
        return;
      case '\\': // Replace
        this.replaceSearchBuffer = this.lastSearchTerm;
        this._mode = 'replace-search';
        this.lastActionWasCut = false;
        return;
      case 'g': { // cursor position
        const total = this.linesArr.length;
        const pct = total > 0 ? Math.round(((this._cursorLine + 1) / total) * 100) : 100;
        this._statusMessage = `[ line ${this._cursorLine + 1}/${total} (${pct}%), col ${this._cursorCol + 1} ]`;
        this.lastActionWasCut = false;
        return;
      }
      case 'c': {
        const total = this.linesArr.length;
        this._statusMessage = `[ line ${this._cursorLine + 1}/${total}, col ${this._cursorCol + 1} ]`;
        this.lastActionWasCut = false;
        return;
      }
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
        this._mode = 'goto-line';
        this.lastActionWasCut = false;
        return;
      default:
        this.lastActionWasCut = false;
        return;
    }
  }

  private pageUp(): void {
    this._cursorLine = Math.max(0, this._cursorLine - PAGE_SIZE);
    this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol);
    this.lastEditKind = null;
  }

  private pageDown(): void {
    this._cursorLine = Math.min(this.linesArr.length - 1, this._cursorLine + PAGE_SIZE);
    this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol);
    this.lastEditKind = null;
  }

  private applyEditAltKey(k: EditorKeyInput): void {
    const key = k.key.toLowerCase();
    if (key === 'u') { this.performUndo(); this.lastActionWasCut = false; return; }
    if (key === 'e') { this.performRedo(); this.lastActionWasCut = false; return; }
    if (key === 'g') { // Go To Line (M-G alias)
      this.gotoLineBuffer = '';
      this._mode = 'goto-line';
      this.lastActionWasCut = false;
      return;
    }
  }

  // ── Save prompt ──────────────────────────────────────────────────

  private applySavePromptKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      const ok = this.fs.writeFile(this.saveFileNameBuffer, this.serialize());
      this._mode = 'edit';
      if (!ok) {
        this._statusMessage = `[ Error writing ${this.saveFileNameBuffer} ]`;
        return;
      }
      this._modified = false;
      const n = this.linesArr.length;
      this._statusMessage = `[ Wrote ${n} line${n === 1 ? '' : 's'} ]`;
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this._statusMessage = 'Cancelled';
      this._mode = 'edit';
      return;
    }
    if (k.key === 'Backspace') {
      this.saveFileNameBuffer = this.saveFileNameBuffer.slice(0, -1);
      return;
    }
    if (k.key.length === 1) {
      this.saveFileNameBuffer += k.key;
    }
  }

  // ── Exit-save (Y/N/^C) prompt ───────────────────────────────────

  private applyExitSavePromptKey(k: EditorKeyInput): void {
    const key = k.key.toLowerCase();
    if (!k.ctrl && key === 'y') {
      const ok = this.fs.writeFile(this.filePath, this.serialize());
      if (!ok) {
        this._mode = 'edit';
        this._statusMessage = `[ Error writing ${this.filePath} ]`;
        return;
      }
      this._modified = false;
      this.finishExit(true);
      return;
    }
    if (!k.ctrl && key === 'n') {
      this.finishExit(false);
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && key === 'c')) {
      this._statusMessage = '';
      this._mode = 'edit';
    }
  }

  // ── Go To Line (^_ / M-G) ────────────────────────────────────────

  private applyGotoLineKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      this.performGotoLine(this.gotoLineBuffer);
      this._mode = 'edit';
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this._mode = 'edit';
      return;
    }
    if (k.key === 'Backspace') {
      this.gotoLineBuffer = this.gotoLineBuffer.slice(0, -1);
      return;
    }
    if (k.key.length === 1) {
      this.gotoLineBuffer += k.key;
    }
  }

  /** Parses real nano's "line[,column]" goto-line syntax (both 1-indexed). Invalid/non-numeric input is a silent no-op. */
  private performGotoLine(input: string): void {
    const trimmed = input.trim();
    if (!trimmed) return;
    const [lineStr, colStr] = trimmed.split(',');
    const lineNum = parseInt(lineStr, 10);
    if (!Number.isFinite(lineNum) || lineNum < 1) return;
    const targetLine = Math.min(lineNum, this.linesArr.length) - 1;
    this._cursorLine = targetLine;
    const colNum = colStr !== undefined ? parseInt(colStr, 10) : NaN;
    this._cursorCol = Number.isFinite(colNum) && colNum >= 1 ? this.clampCol(targetLine, colNum - 1) : 0;
    this.lastEditKind = null;
  }

  // ── Search ───────────────────────────────────────────────────────

  private applySearchKey(k: EditorKeyInput): void {
    if (k.alt && k.key.toLowerCase() === 'r') {
      this.useRegex = !this.useRegex;
      return;
    }
    if (k.key === 'Enter') {
      if (this.searchQueryBuffer) {
        this.lastSearchTerm = this.searchQueryBuffer;
        this.searchHistoryList.push(this.searchQueryBuffer);
        this.performSearch(this.searchQueryBuffer);
      }
      this._mode = 'edit';
      this.historyNavIndex = null;
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this._mode = 'edit';
      this.historyNavIndex = null;
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
      return;
    }
    if (k.key === 'Backspace') {
      this.searchQueryBuffer = this.searchQueryBuffer.slice(0, -1);
      return;
    }
    if (k.key.length === 1) {
      this.searchQueryBuffer += k.key;
    }
  }

  private buildSearchRegex(query: string): RegExp {
    return new RegExp(this.useRegex ? query : escapeRegExp(query));
  }

  private performSearch(query: string): void {
    const flatOffset = this.linesArr.slice(0, this._cursorLine).join('\n').length
      + (this._cursorLine > 0 ? 1 : 0) + this._cursorCol;
    const text = this.content;
    const re = this.buildSearchRegex(query);
    let m = text.slice(flatOffset + 1).match(re);
    let idx = m && m.index !== undefined ? flatOffset + 1 + m.index : -1;
    let wrapped = false;
    if (idx < 0) {
      m = text.match(re);
      idx = m && m.index !== undefined ? m.index : -1;
      wrapped = true;
    }
    if (idx < 0) {
      this._statusMessage = `[ "${query}" not found ]`;
      return;
    }
    const before = text.slice(0, idx).split('\n');
    this._cursorLine = before.length - 1;
    this._cursorCol = before[before.length - 1].length;
    this._statusMessage = wrapped ? '[ Search Wrapped ]' : '';
  }

  // ── Replace (Ctrl+\) ────────────────────────────────────────────

  private applyReplaceSearchKey(k: EditorKeyInput): void {
    if (k.alt && k.key.toLowerCase() === 'r') {
      this.useRegex = !this.useRegex;
      return;
    }
    if (k.key === 'Enter') {
      if (!this.replaceSearchBuffer) { this._mode = 'edit'; return; }
      this.lastSearchTerm = this.replaceSearchBuffer;
      this.replaceWithBuffer = '';
      this._mode = 'replace-with';
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this._mode = 'edit';
      return;
    }
    if (k.key === 'Backspace') {
      this.replaceSearchBuffer = this.replaceSearchBuffer.slice(0, -1);
      return;
    }
    if (k.key.length === 1) {
      this.replaceSearchBuffer += k.key;
    }
  }

  private applyReplaceWithKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      this.startReplace();
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this._mode = 'edit';
      return;
    }
    if (k.key === 'Backspace') {
      this.replaceWithBuffer = this.replaceWithBuffer.slice(0, -1);
      return;
    }
    if (k.key.length === 1) {
      this.replaceWithBuffer += k.key;
    }
  }

  private startReplace(): void {
    const regex = this.buildSearchRegex(this.lastSearchTerm);
    this.replaceState = { regex, replacement: this.replaceWithBuffer, currentLine: 0, currentCol: 0, totalReplaced: 0 };
    if (!this.advanceReplaceMatch()) this.finishReplace();
  }

  private advanceReplaceMatch(): boolean {
    const st = this.replaceState;
    if (!st) return false;
    while (st.currentLine < this.linesArr.length) {
      const m = execFrom(this.linesArr[st.currentLine], st.regex, st.currentCol);
      if (m) {
        this._pendingReplaceMatch = { line: st.currentLine, start: m.index, end: m.index + m[0].length, matchText: m[0] };
        this._mode = 'replace-confirm';
        return true;
      }
      st.currentLine++;
      st.currentCol = 0;
    }
    return false;
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
      this._statusMessage = `Replaced ${st.totalReplaced} occurrence${st.totalReplaced === 1 ? '' : 's'}`;
    }
  }

  // ── Exit bookkeeping ─────────────────────────────────────────────

  private finishExit(saved: boolean): void {
    this._exited = true;
    this._savedOnExit = saved;
    this.fs.deleteFile(this.lockPath);
  }
}
