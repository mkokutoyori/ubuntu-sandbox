/**
 * RmanScriptParser — pure function that turns RMAN script text into a
 * stream of typed ParsedLine entries.
 *
 * Supports:
 *   - blank lines and `#` comments (preserved as kind: 'blank' / 'comment'
 *     so callers can keep line numbers stable for error reporting);
 *   - the `RUN` keyword and bare `{` as block_start;
 *   - bare `}` as block_end;
 *   - any other line as `command`, with its trailing semicolon stripped.
 */

export type ParsedLine =
  | { kind: 'command';     text: string; lineNo: number }
  | { kind: 'block_start'; lineNo: number }
  | { kind: 'block_end';   lineNo: number }
  | { kind: 'comment';     lineNo: number }
  | { kind: 'blank';       lineNo: number };

export function parseRmanScript(source: string): ParsedLine[] {
  const lines = source.split('\n');
  const out: ParsedLine[] = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();

    if (!trimmed)                  { out.push({ kind: 'blank',   lineNo }); continue; }
    if (trimmed.startsWith('#'))   { out.push({ kind: 'comment', lineNo }); continue; }
    const upper = trimmed.toUpperCase();
    if (upper === 'RUN' || trimmed === '{' || upper === 'RUN {') {
      depth++;
      out.push({ kind: 'block_start', lineNo });
      continue;
    }
    if (trimmed === '}') {
      depth = Math.max(0, depth - 1);
      out.push({ kind: 'block_end', lineNo });
      continue;
    }
    const cmd = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed;
    out.push({ kind: 'command', text: cmd, lineNo });
  }
  return out;
}
