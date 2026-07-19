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
}

/**
 * Scan a single physical line, updating quote/continuation state. Returns
 * the here-doc delimiter opened on this line (if any).
 */
function scanLine(line: string, st: ScanState): string | null {
  st.trailingBackslash = false;
  let heredoc: string | null = null;
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
      if (delim) heredoc = delim;
      i = j; continue;
    }

    if (/\s/.test(ch)) { flush(); i++; continue; }
    if (ch === ';' || ch === '&' || ch === '|') { flush(); cur = ''; words.push(ch === ';' ? ';' : ch + ch); i++; while (i < line.length && (line[i] === '&' || line[i] === '|')) i++; continue; }
    cur += ch; i++;
  }
  flush();

  // Track block openers/closers and dangling connectors from the word stream.
  for (const w of words) {
    if (OPENERS[w]) st.blocks.push(OPENERS[w]);
    else if (CLOSERS.has(w)) { if (st.blocks[st.blocks.length - 1] === w) st.blocks.pop(); }
    else if (w === 'do' || w === 'then') { /* structural, no stack change */ }
  }

  // A line ending in a connector (| && ||) with nothing after is dangling.
  const lastWord = words[words.length - 1];
  st.danglingConnector = lastWord === '|' || lastWord === '&&' || lastWord === '||';

  return heredoc;
}

export function analyzeBashInput(input: string): BashInputAnalysis {
  const lines = input.split('\n');
  const st: ScanState = { quote: null, trailingBackslash: false, blocks: [], danglingConnector: false };
  let pendingHeredoc: string | null = null;

  for (const line of lines) {
    if (pendingHeredoc !== null) {
      // Inside a here-document: only the exact delimiter line closes it.
      if (line.trim() === pendingHeredoc) pendingHeredoc = null;
      continue;
    }
    const opened = scanLine(line, st);
    if (opened) pendingHeredoc = opened;
  }

  if (pendingHeredoc !== null) {
    return { complete: false, heredocDelimiter: pendingHeredoc };
  }
  if (st.quote !== null || st.trailingBackslash || st.blocks.length > 0 || st.danglingConnector) {
    return { complete: false };
  }
  return { complete: true };
}
