import type { EditorFsContext } from './EditorFsContext';
import type { EditorKeyInput } from './EditorKeyInput';
import { dotSwapPathFor } from './editorPaths';

export type VimMode = 'normal' | 'insert' | 'command' | 'search' | 'confirm-substitute';
export type VimVariant = 'vim' | 'vi';

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

function charClass(ch: string | undefined): CharClass {
  if (ch === undefined || /\s/.test(ch)) return 0;
  if (/[A-Za-z0-9_]/.test(ch)) return 1;
  return 2;
}

/** End (exclusive) of the word/punct run starting at col, skipping leading blanks. Used by cw/dw/ce. */
function wordRunEnd(line: string, col: number): number {
  const n = line.length;
  let i = col;
  if (i >= n) return n;
  if (charClass(line[i]) === 0) {
    while (i < n && charClass(line[i]) === 0) i++;
    if (i >= n) return n;
  }
  const cls = charClass(line[i]);
  while (i < n && charClass(line[i]) === cls) i++;
  return i;
}

/** Column of the start of the next word on this line, or null if motion must cross a line boundary. */
function nextWordStart(line: string, col: number): number | null {
  const n = line.length;
  let i = col;
  if (i >= n) return null;
  const cls = charClass(line[i]);
  if (cls !== 0) { while (i < n && charClass(line[i]) === cls) i++; }
  while (i < n && charClass(line[i]) === 0) i++;
  return i < n ? i : null;
}

/** Column of the start of the previous word on this line, or null if motion must cross a line boundary. */
function prevWordStart(line: string, col: number): number | null {
  let i = col - 1;
  while (i >= 0 && charClass(line[i]) === 0) i--;
  if (i < 0) return null;
  const cls = charClass(line[i]);
  while (i > 0 && charClass(line[i - 1]) === cls) i--;
  return i;
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
  private pendingOperator: 'd' | 'y' | 'c' | null = null;
  private pendingCountStr = '';
  private pendingG = false;
  private unnamedRegister: UnnamedRegister = { linewise: true, lines: [] };
  private readonly swapPath: string;
  private substState: { rangeEnd: number; regex: RegExp; replacementTemplate: string; global: boolean; currentLine: number; currentCol: number; totalReplaced: number; linesTouched: Set<number> } | null = null;
  private _pendingMatch: PendingSubstMatch | null = null;

  constructor(
    private readonly fs: EditorFsContext,
    public readonly filePath: string,
    initialContent: string,
    isNewFile: boolean,
    public readonly variant: VimVariant = 'vim',
  ) {
    const body = initialContent.endsWith('\n') ? initialContent.slice(0, -1) : initialContent;
    this.linesArr = body.length === 0 && initialContent.length === 0 ? [''] : body.split('\n');
    this._message = isNewFile
      ? `"${filePath}" [New File]`
      : `"${filePath}" ${this.linesArr.length}L, ${initialContent.length}C`;
    this.swapPath = dotSwapPathFor(fs.resolvePath(filePath));
    this.fs.writeFile(this.swapPath, `b0VIM vim swap file for ${filePath}\n`);
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
  get swapFileExists(): boolean { return this.fs.exists(this.swapPath); }
  /** True while in insert mode AND the variant shows a mode indicator (vim, not strict vi). */
  get showsInsertIndicator(): boolean { return this._mode === 'insert' && this.variant === 'vim'; }
  get pendingSubstMatch(): PendingSubstMatch | null { return this._pendingMatch; }

  private line(i: number): string { return this.linesArr[i] ?? ''; }
  private clampCol(lineIdx: number, col: number, insertEdge = false): number {
    const max = Math.max(0, this.line(lineIdx).length - (insertEdge ? 0 : 1));
    return Math.max(0, Math.min(col, max));
  }

  // ── Key dispatch ─────────────────────────────────────────────────

  applyKey(k: EditorKeyInput): void {
    if (this._exited) return;
    switch (this._mode) {
      case 'normal': return this.applyNormalKey(k);
      case 'insert': return this.applyInsertKey(k);
      case 'command': return this.applyCommandKey(k);
      case 'search': return this.applySearchKey(k);
      case 'confirm-substitute': return this.applyConfirmSubstKey(k);
    }
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
      case 'o':
        this.linesArr.splice(this._cursorLine + 1, 0, '');
        this._cursorLine++;
        this._cursorCol = 0;
        this._modified = true;
        this.enterInsert();
        return;
      case 'O':
        this.linesArr.splice(this._cursorLine, 0, '');
        this._cursorCol = 0;
        this._modified = true;
        this.enterInsert();
        return;
      case ':':
        this.commandBuffer = '';
        this._mode = 'command';
        return;
      case '/':
        this.searchBuffer = '';
        this._mode = 'search';
        return;
      case 'x': {
        const count = this.takeCount() ?? 1;
        const l = this.line(this._cursorLine);
        if (this._cursorCol < l.length) {
          this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + l.slice(this._cursorCol + count));
          this._cursorCol = this.clampCol(this._cursorLine, this._cursorCol);
          this._modified = true;
        }
        return;
      }
      case 'p': this.paste(true); return;
      case 'P': this.paste(false); return;
      case 'd': case 'y': case 'c':
        this.pendingOperator = key as 'd' | 'y' | 'c';
        return;
      case 'u':
        this._message = 'Already at oldest change';
        this.pendingCountStr = '';
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

  private enterInsert(): void {
    this._mode = 'insert';
    this._message = this.variant === 'vim' ? '-- INSERT --' : '';
  }

  // ── Operator + motion (dd, yy, cw, dw, cc, ...) ────────────────────

  private applyOperatorMotion(key: string): void {
    const op = this.pendingOperator!;
    const count = this.takeCount() ?? 1;

    // Doubled operator (dd/yy/cc) → linewise on `count` lines from cursor.
    if (key === op || (op === 'c' && key === 'c') || (key === 'd' && op === 'd') || (key === 'y' && op === 'y')) {
      const n = Math.min(count, this.linesArr.length - this._cursorLine);
      const removed = this.linesArr.splice(this._cursorLine, n);
      this.unnamedRegister = { linewise: true, lines: removed };
      if (op !== 'y') {
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

  private applyCharwiseOperator(op: 'd' | 'y' | 'c', text: string): void {
    this.unnamedRegister = { linewise: false, lines: [text] };
    if (op !== 'y') {
      const l = this.line(this._cursorLine);
      this.setLine(this._cursorLine, l.slice(0, this._cursorCol) + l.slice(this._cursorCol + text.length));
      this._modified = true;
    }
    if (op === 'c') this.enterInsert();
  }

  private paste(after: boolean): void {
    const reg = this.unnamedRegister;
    if (reg.lines.length === 0) return;
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

  // ── INSERT mode ──────────────────────────────────────────────────

  private applyInsertKey(k: EditorKeyInput): void {
    if (k.key === 'Escape' || (k.ctrl && k.key === '[')) {
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
        const after = l.slice(this._cursorCol);
        this.linesArr.splice(this._cursorLine, 1, before, after);
        this._cursorLine++;
        this._cursorCol = 0;
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

  // ── COMMAND-LINE (ex) mode ──────────────────────────────────────

  private applyCommandKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      this.executeExCommand(this.commandBuffer);
      return;
    }
    if (k.key === 'Escape') {
      this._mode = 'normal';
      this.commandBuffer = '';
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

  /** Parse an optional leading ex range (`%`, `N`, `N,M`, `$`, `.`) off a command string. */
  private parseExRange(s: string): { start: number | null; end: number | null; rest: string } {
    if (s.startsWith('%')) return { start: 0, end: this.linesArr.length - 1, rest: s.slice(1) };
    const m = s.match(/^(\$|\.|\d+)(?:,(\$|\.|\d+))?/);
    if (!m) return { start: null, end: null, rest: s };
    const resolve = (tok: string) => tok === '$' ? this.linesArr.length - 1 : tok === '.' ? this._cursorLine : parseInt(tok, 10) - 1;
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
      this.executeGlobal(rangeStart ?? 0, rangeEnd ?? this.linesArr.length - 1, pattern, cmd);
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
        const result = this.executeSubstitute(s, e, parsed.pattern, parsed.replacement, parsed.flags);
        if (result.count > 0) {
          this._modified = true;
          this._message = `${result.count} substitution${result.count === 1 ? '' : 's'} on ${result.lines} line${result.lines === 1 ? '' : 's'}`;
        } else {
          this._message = `E486: Pattern not found: ${parsed.pattern}`;
        }
        this._mode = 'normal';
      }
      return;
    }

    if (trimmed === 'w' || trimmed === 'write') {
      this.writeFile(this.filePath);
      this._mode = 'normal';
      return;
    }
    if (trimmed.startsWith('w ')) {
      this.writeFile(trimmed.slice(2).trim());
      this._mode = 'normal';
      return;
    }
    if (trimmed === 'w!') {
      this.writeFile(this.filePath);
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
    if (trimmed === 'wq' || trimmed === 'x' || trimmed === 'wq!' || trimmed === 'xit') {
      this.writeFile(this.filePath);
      this.finishExit(true);
      return;
    }
    if (trimmed === 'set number' || trimmed === 'set nu' || trimmed === 'set nonumber' || trimmed === 'set nonu') {
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

  private writeFile(path: string): void {
    this.fs.writeFile(path, `${this.content}\n`);
    this._modified = false;
    this._message = `"${path}" ${this.linesArr.length}L, ${this.content.length}C written`;
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
    }
  }

  // ── SEARCH (/) mode ──────────────────────────────────────────────

  private applySearchKey(k: EditorKeyInput): void {
    if (k.key === 'Enter') {
      if (this.searchBuffer) this.performSearch(this.searchBuffer);
      this._mode = 'normal';
      return;
    }
    if (k.key === 'Escape') {
      this._mode = 'normal';
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
    const flatOffset = this.linesArr.slice(0, this._cursorLine).join('\n').length
      + (this._cursorLine > 0 ? 1 : 0) + this._cursorCol;
    const text = this.content;
    let idx = text.indexOf(query, flatOffset + 1);
    let wrapped = false;
    if (idx < 0) { idx = text.indexOf(query); wrapped = true; }
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
    this.fs.deleteFile(this.swapPath);
  }
}
