/**
 * Interactive line-continuation detection for bash.
 *
 * Decides whether the text typed so far is a COMPLETE command or whether
 * an interactive shell would keep reading (PS2 `>`). It is a lightweight
 * lexical scanner — deliberately independent of the full parser — because
 * the terminal needs a cheap, throw-free "should I keep collecting?"
 * answer on every Enter, before the command is ever executed.
 *
 * Handles: open single/double quotes, trailing backslash, dangling
 * pipe/`&&`/`||`, unfinished compound blocks (if/for/while/case/{/(), and
 * unterminated here-documents (returning the awaited delimiter).
 */

export interface BashInputAnalysis {
  /** True when the input forms a complete command ready to execute. */
  complete: boolean;
  /** Set when an unterminated `<<DELIM` here-document is open. */
  heredocDelimiter?: string;
}

const OPENERS: Record<string, string> = { if: 'fi', for: 'done', while: 'done', until: 'done', case: 'esac' };
const CLOSERS = new Set(['fi', 'done', 'esac']);

interface ScanState {
  quote: '"' | "'" | null;
  trailingBackslash: boolean;
  /** Depth stack of block keywords / brackets awaiting their closer. */
  blocks: string[];
  /** Last significant operator token, to catch a dangling connector. */
  danglingConnector: boolean;
  /** Paren depth inside `$((…))` / `((…))` — `<<` there is a shift. */
  arithDepth: number;
  /**
   * Delimiters awaited, in the order their bodies come — `cmd <<A <<B`
   * reads A's body first, then B's. A queue, like `BashLexer`'s own
   * `pendingHeredocs`, so both layers model the same rule.
   */
  pendingHeredocs: string[];
}

/**
 * Scan a single physical line, updating quote/continuation state. Appends
 * to `st.pendingHeredocs` every here-doc opened on this line.
 */
function scanLine(line: string, st: ScanState): void {
  st.trailingBackslash = false;
  const words: string[] = [];
  let cur = '';
  let i = 0;

  const flush = (): void => { if (cur) { words.push(cur); cur = ''; } };

  while (i < line.length) {
    const ch = line[i];

    if (st.quote) {
      if (ch === '\\' && st.quote === '"' && i + 1 < line.length) { cur += line[i + 1]; i += 2; continue; }
      if (ch === st.quote) { st.quote = null; i++; continue; }
      cur += ch; i++; continue;
    }

    // Arithmetic context: `<<` is a bit shift there, never a heredoc, so
    // consume the whole `$((…))` / `((…))` span counting parens only.
    if (st.arithDepth > 0) {
      if (ch === '(') st.arithDepth++;
      else if (ch === ')') st.arithDepth--;
      cur += ch; i++; continue;
    }
    if (ch === '$' && line[i + 1] === '(' && line[i + 2] === '(') {
      st.arithDepth = 2; cur += '$(('; i += 3; continue;
    }
    if (ch === '(' && line[i + 1] === '(' && cur === ''
        && (words.length === 0 || words[words.length - 1] === ';'
            || words[words.length - 1] === '&&' || words[words.length - 1] === '||')) {
      st.arithDepth = 2; i += 2; continue;
    }

    if (ch === '\\') {
      if (i === line.length - 1) { st.trailingBackslash = true; i++; break; }
      cur += line[i + 1]; i += 2; continue;
    }
    if (ch === "'" || ch === '"') { st.quote = ch; i++; continue; }
    if (ch === '#' && cur === '' && (i === 0 || /\s/.test(line[i - 1]))) break; // comment to EOL

    // Here-document: `<<[-]WORD` or `<<[-]"WORD"` / `<<'WORD'`.
    if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      flush();
      let j = i + 2;
      if (line[j] === '-') j++;
      while (j < line.length && /\s/.test(line[j])) j++;
      let delim = '';
      const q = line[j];
      if (q === '"' || q === "'") {
        j++;
        while (j < line.length && line[j] !== q) { delim += line[j]; j++; }
        j++;
      } else {
        while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) { delim += line[j]; j++; }
      }
      if (delim) st.pendingHeredocs.push(delim);
      i = j; continue;
    }

    if (/\s/.test(ch)) { flush(); i++; continue; }
    if (ch === ';') { flush(); cur = ''; words.push(';'); i++; continue; }
    // `&` and `|` come in runs, and WHICH run it is decides whether the
    // command is finished. `cmd &` is a complete command put in the
    // background; `cmd &&` is waiting for its right-hand side. The scanner
    // used to record `ch + ch` for both, so a single `&` was read as `&&`
    // and the terminal answered a `>` continuation prompt to a line real
    // bash runs immediately. Push the operator that is actually there.
    if (ch === '&' || ch === '|') {
      flush();
      cur = '';
      let op = '';
      while (i < line.length && (line[i] === '&' || line[i] === '|')) { op += line[i]; i++; }
      words.push(op);
      continue;
    }
    cur += ch; i++;
  }
  flush();

  // Track block openers/closers and dangling connectors from the word stream.
  for (const w of words) {
    if (OPENERS[w]) st.blocks.push(OPENERS[w]);
    else if (CLOSERS.has(w)) { if (st.blocks[st.blocks.length - 1] === w) st.blocks.pop(); }
    else if (w === 'do' || w === 'then') { /* structural, no stack change */ }
  }

  // A line ending in a connector with nothing after it is dangling — bash
  // asks for the right-hand side. A lone `&` is NOT one of them: it
  // terminates the command and backgrounds it, so the line is finished.
  const lastWord = words[words.length - 1];
  st.danglingConnector = lastWord === '|' || lastWord === '||'
    || lastWord === '&&' || lastWord === '|&';
}

export function analyzeBashInput(input: string): BashInputAnalysis {
  const lines = input.split('\n');
  const st: ScanState = {
    quote: null, trailingBackslash: false, blocks: [],
    danglingConnector: false, arithDepth: 0, pendingHeredocs: [],
  };

  for (const line of lines) {
    if (st.pendingHeredocs.length > 0) {
      // Inside a here-document: only the exact delimiter line closes it,
      // and it closes the one at the head of the queue.
      if (line.trim() === st.pendingHeredocs[0]) st.pendingHeredocs.shift();
      continue;
    }
    scanLine(line, st);
  }

  if (st.pendingHeredocs.length > 0) {
    return { complete: false, heredocDelimiter: st.pendingHeredocs[0] };
  }
  if (st.quote !== null || st.trailingBackslash || st.blocks.length > 0
      || st.danglingConnector || st.arithDepth > 0) {
    return { complete: false };
  }
  return { complete: true };
}
