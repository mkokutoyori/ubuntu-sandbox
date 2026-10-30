import { codePointWidth } from './vim/VimCells';
import type { EditorKeyInput } from './EditorKeyInput';
import type { EditorScreen, ScreenRow, ScreenSpan } from './screen/EditorScreen';

export interface LessOptions {
  readonly lineNumbers: boolean;
  readonly chopLongLines: boolean;
  readonly ignoreCase: boolean;
  readonly ignoreCaseAlways: boolean;
}

export interface LessSource {
  readonly title: string;
  readonly content: string;
}

export const DEFAULT_LESS_OPTIONS: LessOptions = {
  lineNumbers: false,
  chopLongLines: false,
  ignoreCase: false,
  ignoreCaseAlways: false,
};

interface DisplayRow {
  readonly line: number;
  readonly text: string;
  readonly first: boolean;
}

type PromptKind = '/' | '?' | ':' | '-';

const TAB_WIDTH = 8;
const NUMBER_WIDTH = 7;
const HORIZONTAL_STEP = 8;

export const LESS_HELP_LINES: readonly string[] = [
  '',
  '                   SUMMARY OF LESS COMMANDS',
  '',
  '      Commands marked with * may be preceded by a number, N.',
  '      Notes in parentheses indicate the behavior if N is given.',
  '      A key preceded by a caret indicates the Ctrl key; thus ^K is ctrl-K.',
  '',
  '  h  H                 Display this help.',
  '  q  :q  Q  :Q  ZZ     Exit.',
  ' ---------------------------------------------------------------------------',
  '',
  '                           MOVING',
  '',
  '  e  ^E  j  ^N  CR  *  Forward  one line   (or N lines).',
  '  y  ^Y  k  ^K  ^P  *  Backward one line   (or N lines).',
  '  J                 *  Forward  one line, but don\'t stop at end-of-file.',
  '  K  Y              *  Backward one line, but don\'t stop at beginning-of-file.',
  '  f  ^F  ^V  SPACE  *  Forward  one window (or N lines).',
  '  b  ^B  ESC-v      *  Backward one window (or N lines).',
  '  z                 *  Forward  one window (and set window to N).',
  '  w                 *  Backward one window (and set window to N).',
  '  d  ^D             *  Forward  one half-window (and set half-window to N).',
  '  u  ^U             *  Backward one half-window (and set half-window to N).',
  '  ESC-)  RightArrow *  Right one half screen width (or N positions).',
  '  ESC-(  LeftArrow  *  Left  one half screen width (or N positions).',
  '  r  ^R  ^L            Repaint screen.',
  '        ---------------------------------------------------',
  '        Default "window" is the screen height.',
  '        Default "half-window" is half of the screen height.',
  ' ---------------------------------------------------------------------------',
  '',
  '                          SEARCHING',
  '',
  '  /pattern          *  Search forward for (N-th) matching line.',
  '  ?pattern          *  Search backward for (N-th) matching line.',
  '  n                 *  Repeat previous search (for N-th occurrence).',
  '  N                 *  Repeat previous search in reverse direction.',
  '        ---------------------------------------------------',
  '        Search is case-sensitive unless changed with -i or -I.',
  ' ---------------------------------------------------------------------------',
  '',
  '                           JUMPING',
  '',
  '  g  <  ESC-<  HOME *  Go to first line in file (or line N).',
  '  G  >  ESC->  END  *  Go to last line in file (or line N).',
  '  p  %              *  Go to beginning of file (or N percent into file).',
  '  m<letter>         *  Mark the top line (or line N) with <letter>.',
  '  M<letter>         *  Mark the bottom line (or line N) with <letter>.',
  '  \'<letter>         *  Go to a previously marked position (put on position N).',
  '  \'\'                *  Go to the previous position.',
  '        ---------------------------------------------------',
  '        A mark is any upper-case or lower-case letter.',
  '        Certain marks are predefined:',
  '             ^  means  beginning of the file',
  '             $  means  end of the file',
  ' ---------------------------------------------------------------------------',
  '',
  '                        CHANGING FILES',
  '',
  '  :n                *  Examine the (N-th) next file from the command line.',
  '  :p                *  Examine the (N-th) previous file from the command line.',
  '  :x                *  Examine the first (or N-th) file from the command line.',
  '  =  ^G  :f            Print current file name.',
  ' ---------------------------------------------------------------------------',
  '',
  '                    MISCELLANEOUS COMMANDS',
  '',
  '  -<flag>              Toggle a command line option (N, S, i, I).',
];

function expandLine(raw: string): string {
  let out = '';
  let column = 0;
  for (const ch of raw) {
    if (ch === '\t') {
      const pad = TAB_WIDTH - (column % TAB_WIDTH);
      out += ' '.repeat(pad);
      column += pad;
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (code === 0x1b) {
      out += 'ESC';
      column += 3;
    } else if (code < 0x20) {
      out += `^${String.fromCharCode(code + 64)}`;
      column += 2;
    } else if (code === 0x7f) {
      out += '^?';
      column += 2;
    } else {
      out += ch;
      column += codePointWidth(code);
    }
  }
  return out;
}

function splitByWidth(text: string, width: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let used = 0;
  for (const ch of text) {
    const w = Math.max(1, codePointWidth(ch.codePointAt(0)!));
    if (used + w > width && current !== '') {
      pieces.push(current);
      current = '';
      used = 0;
    }
    current += ch;
    used += w;
  }
  pieces.push(current);
  return pieces;
}

export class LessEngine {
  private sourceLines: string[] = [];
  private title = '';
  private index = 0;
  private readonly sources: readonly LessSource[];
  private opts: LessOptions;
  private display: DisplayRow[] = [];
  private top = 0;
  private rowsTotal = 24;
  private colsTotal = 80;
  private horizontal = 0;
  private count = '';
  private prompt: { kind: PromptKind; text: string } | null = null;
  private notice = '';
  private lastSearch: { pattern: string; forward: boolean } | null = null;
  private firstPrompt = true;
  private helping = false;
  private pendingZ = false;
  private pendingColon = false;
  private pendingMark: 'set-top' | 'set-bottom' | 'jump' | null = null;
  private marks = new Map<string, number>();
  private previousTop = 0;
  private windowSize: number | null = null;
  private halfWindowSize: number | null = null;
  private done = false;

  constructor(sources: readonly LessSource[], options: LessOptions = DEFAULT_LESS_OPTIONS, rows = 24, cols = 80) {
    this.sources = sources;
    this.opts = options;
    this.rowsTotal = Math.max(2, rows);
    this.colsTotal = Math.max(1, cols);
    this.load(0);
  }

  private load(index: number): void {
    const source = this.sources[index] ?? { title: '', content: '' };
    const normalised = source.content.endsWith('\n') ? source.content.slice(0, -1) : source.content;
    this.index = index;
    this.title = source.title;
    this.sourceLines = source.content === '' ? [] : normalised.split('\n');
    this.display = [];
    this.top = 0;
    this.firstPrompt = true;
    this.rebuild();
  }

  feed(keys: string): void {
    for (const ch of keys) this.applyKey({ key: ch === '\n' ? 'Enter' : ch });
  }

  fitsOnOneScreen(): boolean {
    return this.sources.length === 1 && this.display.length <= this.textRows;
  }

  get plainContent(): string {
    return this.sources.map((source) => source.content).join('');
  }

  get exited(): boolean {
    return this.done;
  }

  get options(): LessOptions {
    return this.opts;
  }

  get topLine(): number {
    return this.display[this.top]?.line ?? 0;
  }

  get lineCount(): number {
    return this.sourceLines.length;
  }

  private get textRows(): number {
    return this.rowsTotal - 1;
  }

  private get lines(): readonly string[] {
    return this.helping ? LESS_HELP_LINES : this.sourceLines;
  }

  private numberPrefixWidth(): number {
    return this.opts.lineNumbers && !this.helping ? NUMBER_WIDTH + 1 : 0;
  }

  private rebuild(): void {
    const anchorLine = this.display[this.top]?.line ?? 0;
    const width = Math.max(1, this.colsTotal - this.numberPrefixWidth());
    const rows: DisplayRow[] = [];
    this.lines.forEach((raw, line) => {
      const expanded = expandLine(raw);
      if (this.opts.chopLongLines) {
        rows.push({ line, text: expanded, first: true });
        return;
      }
      splitByWidth(expanded, width).forEach((text, index) => rows.push({ line, text, first: index === 0 }));
    });
    this.display = rows;
    const anchorRow = rows.findIndex((row) => row.line === anchorLine && row.first);
    this.top = this.clampTop(anchorRow < 0 ? 0 : anchorRow);
  }

  private maxTop(): number {
    return Math.max(0, this.display.length - this.textRows);
  }

  private clampTop(top: number): number {
    return Math.min(Math.max(0, top), this.maxTop());
  }

  private atEnd(): boolean {
    return this.top >= this.maxTop();
  }

  resize(rows: number, cols: number): void {
    this.rowsTotal = Math.max(2, rows);
    this.colsTotal = Math.max(1, cols);
    this.rebuild();
  }

  scrollView(up: boolean, count: number): void {
    this.top = this.clampTop(this.top + (up ? -count : count));
  }

  private takeCount(): number | null {
    const value = this.count === '' ? null : parseInt(this.count, 10);
    this.count = '';
    return value;
  }

  private rowOfLine(line: number): number {
    const index = this.display.findIndex((row) => row.line >= line && row.first);
    return index < 0 ? this.display.length : index;
  }

  private percentLabel(): number {
    if (this.display.length === 0) return 100;
    const bottom = Math.min(this.display.length, this.top + this.textRows);
    return Math.floor((bottom * 100) / this.display.length);
  }

  applyKey(input: EditorKeyInput): void {
    if (this.done) return;
    this.notice = '';
    this.firstPrompt = false;
    if (this.prompt !== null) {
      this.promptKey(input);
      return;
    }
    const key = input.key;
    if (this.pendingMark !== null) {
      this.markKey(key);
      return;
    }
    if (input.alt) {
      this.meta(key);
      return;
    }
    if (input.ctrl) {
      this.control(key.toLowerCase());
      return;
    }
    if (this.pendingZ) {
      this.pendingZ = false;
      if (key === 'Z') this.leave();
      return;
    }
    if (this.pendingColon) {
      this.pendingColon = false;
      if (key === 'q' || key === 'Q') this.leave();
      else if (key === 'f') this.showFileInfo();
      else if (key === 'n') this.switchFile(1);
      else if (key === 'p') this.switchFile(-1);
      return;
    }
    if (/^[0-9]$/.test(key)) {
      this.count += key;
      return;
    }
    const n = this.takeCount();
    const window = this.windowSize ?? Math.max(1, this.textRows - 1);
    const half = this.halfWindowSize ?? Math.max(1, Math.floor(this.textRows / 2));
    switch (key) {
      case 'q': case 'Q': this.leave(); return;
      case 'J': this.forward(n ?? 1, true); return;
      case 'K': case 'Y': this.backward(n ?? 1, true); return;
      case 'z': if (n !== null) this.windowSize = n; this.forward(n ?? window); return;
      case 'w': if (n !== null) this.windowSize = n; this.backward(n ?? window); return;
      case 'm': this.pendingMark = 'set-top'; return;
      case 'M': this.pendingMark = 'set-bottom'; return;
      case "'": this.pendingMark = 'jump'; return;
      case 'Z': this.pendingZ = true; return;
      case ':': this.pendingColon = true; return;
      case 'j': case 'e': case 'Enter': case 'ArrowDown': this.forward(n ?? 1); return;
      case 'k': case 'y': case 'ArrowUp': this.backward(n ?? 1); return;
      case ' ': case 'f': case 'PageDown': this.forward(n ?? window); return;
      case 'b': case 'PageUp': this.backward(n ?? window); return;
      case 'd': if (n !== null) this.halfWindowSize = n; this.forward(n ?? half); return;
      case 'u': if (n !== null) this.halfWindowSize = n; this.backward(n ?? half); return;
      case 'g': case '<': case 'Home': this.gotoLine(n ?? 1); return;
      case 'G': case '>': case 'End': this.gotoLine(n ?? this.sourceLines.length, true); return;
      case 'p': case '%': this.top = this.clampTop(Math.floor(((n ?? 0) * this.display.length) / 100)); return;
      case 'ArrowRight': this.shiftHorizontal(n ?? HORIZONTAL_STEP); return;
      case 'ArrowLeft': this.shiftHorizontal(-(n ?? HORIZONTAL_STEP)); return;
      case '/': this.prompt = { kind: '/', text: '' }; this.count = n === null ? '' : String(n); return;
      case '?': this.prompt = { kind: '?', text: '' }; this.count = n === null ? '' : String(n); return;
      case 'n': this.repeatSearch(false, n ?? 1); return;
      case 'N': this.repeatSearch(true, n ?? 1); return;
      case '-': this.prompt = { kind: '-', text: '' }; return;
      case '=': this.showFileInfo(); return;
      case 'h': case 'H': this.openHelp(); return;
      case 'r': case 'R': return;
      case 'Escape': return;
      default:
    }
  }

  private control(key: string): void {
    const n = this.takeCount();
    const window = Math.max(1, this.textRows - 1);
    const half = Math.max(1, Math.floor(this.textRows / 2));
    switch (key) {
      case 'f': case 'v': this.forward(n ?? window); return;
      case 'b': this.backward(n ?? window); return;
      case 'e': case 'n': case 'j': this.forward(n ?? 1); return;
      case 'y': case 'k': case 'p': this.backward(n ?? 1); return;
      case 'd': this.forward(n ?? half); return;
      case 'u': this.backward(n ?? half); return;
      case 'g': this.showFileInfo(); return;
      case 'r': case 'l': return;
      case 'c': this.count = ''; return;
      default:
    }
  }

  private meta(key: string): void {
    const n = this.takeCount();
    const window = this.windowSize ?? Math.max(1, this.textRows - 1);
    switch (key) {
      case 'v': this.backward(n ?? window); return;
      case ')': this.shiftHorizontal(n ?? Math.floor(this.colsTotal / 2)); return;
      case '(': this.shiftHorizontal(-(n ?? Math.floor(this.colsTotal / 2))); return;
      case '<': this.gotoLine(n ?? 1); return;
      case '>': this.gotoLine(n ?? this.sourceLines.length, true); return;
      default:
    }
  }

  private markKey(key: string): void {
    const mode = this.pendingMark!;
    this.pendingMark = null;
    const n = this.takeCount();
    if (mode === 'jump') {
      if (key === "'" || key === '^' || key === '$') {
        const target = key === "'" ? this.previousTop : key === '^' ? 0 : this.maxTop();
        this.previousTop = this.top;
        this.top = this.clampTop(target);
        return;
      }
      const mark = this.marks.get(key);
      if (mark === undefined) {
        this.notice = 'Mark not set';
        return;
      }
      this.previousTop = this.top;
      this.top = this.clampTop(this.rowOfLine(mark));
      return;
    }
    if (!/^[A-Za-z]$/.test(key)) {
      this.notice = `Invalid mark letter ${key}`;
      return;
    }
    const row = mode === 'set-top' ? this.top : Math.min(this.display.length, this.top + this.textRows) - 1;
    const line = n !== null ? n - 1 : this.display[Math.max(0, row)]?.line ?? 0;
    this.marks.set(key, line);
  }

  private leave(): void {
    if (this.helping) {
      this.helping = false;
      this.rebuild();
      return;
    }
    this.done = true;
  }

  private switchFile(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.sources.length) {
      this.notice = delta > 0 ? 'No next file' : 'No previous file';
      return;
    }
    this.load(next);
  }

  private openHelp(): void {
    if (this.helping) return;
    this.helping = true;
    this.display = [];
    this.top = 0;
    this.rebuild();
  }

  private forward(lines: number, pastEnd = false): void {
    this.top = pastEnd ? Math.min(Math.max(0, this.display.length - 1), this.top + lines) : this.clampTop(this.top + lines);
  }

  private backward(lines: number, pastStart = false): void {
    this.top = pastStart ? Math.max(0, this.top - lines) : this.clampTop(this.top - lines);
  }

  private shiftHorizontal(delta: number): void {
    if (!this.opts.chopLongLines) return;
    this.horizontal = Math.max(0, this.horizontal + delta);
  }

  private gotoLine(line: number, last = false): void {
    if (last && line >= this.sourceLines.length) {
      this.top = this.maxTop();
      return;
    }
    this.top = this.clampTop(this.rowOfLine(Math.max(0, line - 1)));
  }

  private showFileInfo(): void {
    const total = this.sourceLines.length;
    const first = (this.display[this.top]?.line ?? 0) + 1;
    const lastRow = this.display[Math.min(this.display.length, this.top + this.textRows) - 1];
    const last = (lastRow?.line ?? 0) + 1;
    this.notice = `${this.title} lines ${first}-${last}/${total} ${this.percentLabel()}%`;
  }

  private promptKey(input: EditorKeyInput): void {
    const prompt = this.prompt!;
    if (input.key === 'Escape' || (input.ctrl && input.key.toLowerCase() === 'c')) {
      this.prompt = null;
      this.count = '';
      return;
    }
    if (input.key === 'Backspace') {
      if (prompt.text === '') this.prompt = null;
      else this.prompt = { kind: prompt.kind, text: prompt.text.slice(0, -1) };
      return;
    }
    if (input.key === 'Enter') {
      this.prompt = null;
      this.submit(prompt.kind, prompt.text);
      return;
    }
    if (input.key.length === 1 && !input.ctrl) {
      if (prompt.kind === '-') {
        this.prompt = null;
        this.toggleOption(input.key);
        return;
      }
      this.prompt = { kind: prompt.kind, text: prompt.text + input.key };
    }
  }

  private toggleOption(letter: string): void {
    switch (letter) {
      case 'N':
        this.opts = { ...this.opts, lineNumbers: !this.opts.lineNumbers };
        this.notice = this.opts.lineNumbers ? 'Use line numbers' : "Don't use line numbers";
        break;
      case 'S':
        this.opts = { ...this.opts, chopLongLines: !this.opts.chopLongLines };
        this.horizontal = 0;
        this.notice = this.opts.chopLongLines ? 'Chop long lines' : 'Fold long lines';
        break;
      case 'i':
        this.opts = { ...this.opts, ignoreCase: !this.opts.ignoreCase };
        this.notice = this.opts.ignoreCase ? 'Ignore case in searches' : 'Case is significant in searches';
        break;
      case 'I':
        this.opts = { ...this.opts, ignoreCaseAlways: !this.opts.ignoreCaseAlways };
        this.notice = this.opts.ignoreCaseAlways ? 'Ignore case in searches and in patterns' : 'Case is significant in searches';
        break;
      default:
        this.notice = `There is no ${letter} option ("less --help" for help)`;
        return;
    }
    this.rebuild();
  }

  private submit(kind: PromptKind, text: string): void {
    const n = this.takeCount() ?? 1;
    if (kind === '/' || kind === '?') {
      const pattern = text === '' && this.lastSearch !== null ? this.lastSearch.pattern : text;
      if (pattern === '') return;
      this.lastSearch = { pattern, forward: kind === '/' };
      this.search(pattern, kind === '/', n);
    }
  }

  private matcher(pattern: string): RegExp | null {
    const insensitive = this.opts.ignoreCaseAlways || (this.opts.ignoreCase && !/[A-Z]/.test(pattern));
    try {
      return new RegExp(pattern, insensitive ? 'gi' : 'g');
    } catch {
      return null;
    }
  }

  private repeatSearch(reverse: boolean, n: number): void {
    if (this.lastSearch === null) {
      this.notice = 'No previous regular expression';
      return;
    }
    const forward = reverse ? !this.lastSearch.forward : this.lastSearch.forward;
    this.search(this.lastSearch.pattern, forward, n);
  }

  private search(pattern: string, forward: boolean, occurrences: number): void {
    const regex = this.matcher(pattern);
    if (regex === null) {
      this.notice = 'Invalid pattern';
      return;
    }
    const matches = (line: number): boolean => {
      regex.lastIndex = 0;
      return regex.test(expandLine(this.sourceLines[line]));
    };
    let line = this.display[this.top]?.line ?? 0;
    let remaining = occurrences;
    let found = -1;
    const step = forward ? 1 : -1;
    for (let candidate = line + step; candidate >= 0 && candidate < this.sourceLines.length; candidate += step) {
      if (matches(candidate)) {
        remaining -= 1;
        found = candidate;
        if (remaining === 0) break;
      }
    }
    if (found < 0 || remaining > 0) {
      this.notice = `Pattern not found: ${pattern}`;
      return;
    }
    line = found;
    this.top = this.clampTop(this.rowOfLine(line));
  }

  private matchSpans(text: string, regex: RegExp | null, offset: number): ScreenSpan[] {
    if (regex === null) return [];
    const spans: ScreenSpan[] = [];
    regex.lastIndex = 0;
    let match = regex.exec(text);
    while (match !== null) {
      if (match[0] === '') {
        regex.lastIndex += 1;
      } else {
        spans.push({ from: offset + match.index, to: offset + match.index + match[0].length, style: 'reverse' });
      }
      match = regex.exec(text);
    }
    return spans;
  }

  private statusText(): { text: string; reverse: boolean } {
    if (this.prompt !== null) return { text: this.prompt.kind === '-' ? '-' : `${this.prompt.kind}${this.prompt.text}`, reverse: false };
    if (this.notice !== '') {
      const urgent = this.notice.startsWith('Pattern not found');
      return { text: urgent ? `${this.notice} (press RETURN)` : this.notice, reverse: true };
    }
    if (this.pendingColon) return { text: ':', reverse: false };
    if (this.helping) return { text: this.atEnd() ? 'HELP -- END -- Press g to see it again, or q when done' : 'HELP -- Press RETURN for more, or q when done', reverse: true };
    const parts: string[] = [];
    if (this.firstPrompt && this.title !== '') {
      parts.push(this.title);
      if (this.sources.length > 1) parts.push(`(file ${this.index + 1} of ${this.sources.length})`);
    }
    if (this.atEnd()) {
      parts.push('(END)');
      const next = this.sources[this.index + 1];
      if (next !== undefined) parts.push(`- Next: ${next.title}`);
    }
    if (parts.length > 0) return { text: parts.join(' '), reverse: true };
    return { text: ':', reverse: false };
  }

  get screen(): EditorScreen {
    const regex = this.lastSearch === null || this.helping ? null : this.matcher(this.lastSearch.pattern);
    const rows: ScreenRow[] = [];
    const prefix = this.numberPrefixWidth();
    for (let index = 0; index < this.textRows; index += 1) {
      const row = this.display[this.top + index];
      if (row === undefined) {
        rows.push({ text: '~', spans: [] });
        continue;
      }
      let body = row.text;
      if (this.opts.chopLongLines) body = splitByWidth(body.slice(this.horizontal), Math.max(1, this.colsTotal - prefix))[0];
      const label = prefix > 0 ? (row.first ? String(row.line + 1).padStart(NUMBER_WIDTH) : ' '.repeat(NUMBER_WIDTH)) + ' ' : '';
      const spans = this.matchSpans(body, regex, label.length);
      rows.push({ text: label + body, spans });
    }
    const status = this.statusText();
    const statusSpans: ScreenSpan[] = status.reverse && status.text !== '' ? [{ from: 0, to: status.text.length, style: 'reverse' }] : [];
    rows.push({ text: status.text, spans: statusSpans });
    return { rows, cursor: status.reverse ? null : { row: rows.length - 1, col: status.text.length } };
  }
}
