import type { EditorFsContext } from './EditorFsContext';
import type { EditorKeyInput } from './EditorKeyInput';
import { dotSwapPathFor } from './editorPaths';

export type NanoMode = 'edit' | 'save-prompt' | 'exit-save-prompt' | 'search';

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
  private searchQueryBuffer = '';
  private cutBuffer: string[] = [];
  private lastActionWasCut = false;
  private readonly lockPath: string;

  constructor(
    private readonly fs: EditorFsContext,
    public readonly filePath: string,
    initialContent: string,
    isNewFile: boolean,
  ) {
    const body = initialContent.endsWith('\n') ? initialContent.slice(0, -1) : initialContent;
    this.linesArr = body.length === 0 && initialContent.length === 0 ? [''] : body.split('\n');
    this._statusMessage = isNewFile ? '[ New File ]' : '';
    this.saveFileNameBuffer = filePath;
    this.lockPath = dotSwapPathFor(fs.resolvePath(filePath));
    // GNU nano creates a `.<file>.swp` lock file for the duration of the
    // editing session to prevent two nano instances from editing the same
    // file concurrently; removed on clean exit (see swapFilePath below).
    this.fs.writeFile(this.lockPath, `nano lock: ${filePath}\n`);
  }

  // ── Public state (read-only) ──────────────────────────────────────

  get content(): string { return this.linesArr.join('\n'); }
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
  get searchQuery(): string { return this.searchQueryBuffer; }
  get swapFilePath(): string { return this.lockPath; }
  get swapFileExists(): boolean { return this.fs.exists(this.lockPath); }

  // ── Key dispatch ─────────────────────────────────────────────────

  applyKey(k: EditorKeyInput): void {
    if (this._exited) return;
    switch (this._mode) {
      case 'edit': return this.applyEditKey(k);
      case 'save-prompt': return this.applySavePromptKey(k);
      case 'exit-save-prompt': return this.applyExitSavePromptKey(k);
      case 'search': return this.applySearchKey(k);
    }
  }

  private line(i: number): string { return this.linesArr[i] ?? ''; }

  private clampCol(line: number, col: number): number {
    return Math.max(0, Math.min(col, this.line(line).length));
  }

  // ── Edit mode ────────────────────────────────────────────────────

  private applyEditKey(k: EditorKeyInput): void {
    if (k.ctrl) return this.applyEditCtrlKey(k);

    switch (k.key) {
      case 'ArrowLeft':
        if (this._cursorCol > 0) this._cursorCol--;
        else if (this._cursorLine > 0) { this._cursorLine--; this._cursorCol = this.line(this._cursorLine).length; }
        return;
      case 'ArrowRight':
        if (this._cursorCol < this.line(this._cursorLine).length) this._cursorCol++;
        else if (this._cursorLine < this.linesArr.length - 1) { this._cursorLine++; this._cursorCol = 0; }
        return;
      case 'ArrowUp':
        if (this._cursorLine > 0) { this._cursorLine--; this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol); }
        return;
      case 'ArrowDown':
        if (this._cursorLine < this.linesArr.length - 1) { this._cursorLine++; this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol); }
        return;
      case 'Home':
        this._cursorCol = 0;
        return;
      case 'End':
        this._cursorCol = this.line(this._cursorLine).length;
        return;
      case 'Enter': {
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
          this.linesArr.splice(this._cursorLine, 0, ...this.cutBuffer);
          this._modified = true;
          this._statusMessage = `Pasted ${this.cutBuffer.length} line(s)`;
        }
        this.lastActionWasCut = false;
        return;
      case 'w': // Where Is (search)
        this.searchQueryBuffer = '';
        this._mode = 'search';
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
      default:
        this.lastActionWasCut = false;
        return;
    }
  }

  // ── Save prompt ──────────────────────────────────────────────────

  private applySavePromptKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      this.fs.writeFile(this.saveFileNameBuffer, this.serialize());
      this._modified = false;
      const n = this.linesArr.length;
      this._statusMessage = `[ Wrote ${n} line${n === 1 ? '' : 's'} ]`;
      this._mode = 'edit';
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
      this.fs.writeFile(this.filePath, this.serialize());
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

  // ── Search ───────────────────────────────────────────────────────

  private applySearchKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      if (this.searchQueryBuffer) {
        this.performSearch(this.searchQueryBuffer);
      }
      this._mode = 'edit';
      return;
    }
    if (k.key === 'Escape' || (k.ctrl && k.key.toLowerCase() === 'c')) {
      this._mode = 'edit';
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

  private performSearch(query: string): void {
    const flatOffset = this.linesArr.slice(0, this._cursorLine).join('\n').length
      + (this._cursorLine > 0 ? 1 : 0) + this._cursorCol;
    const text = this.content;
    let idx = text.indexOf(query, flatOffset + 1);
    let wrapped = false;
    if (idx < 0) {
      idx = text.indexOf(query);
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

  // ── Exit bookkeeping ─────────────────────────────────────────────

  private finishExit(saved: boolean): void {
    this._exited = true;
    this._savedOnExit = saved;
    this.fs.deleteFile(this.lockPath);
  }
}
