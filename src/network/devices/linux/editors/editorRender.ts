/**
 * editorRender — the pure screen maths an editor's renderer needs.
 *
 * Kept out of the engines so the same functions serve a buffer held
 * locally and one held on the far side of an SSH channel: the remote
 * view carries the data (lines, listchars) and the renderer computes
 * the rest here rather than calling back over the wire
 * (docs/PRD-SSH-Unification.md §4bis B3).
 */

export interface ListChars {
  readonly tab: string;
  readonly trail: string;
  readonly eol: string;
}

/** vim `:set list` rendering of one buffer line. */
export function renderListLine(line: string, listChars: ListChars): string {
  const trailStart = listChars.trail ? line.trimEnd().length : line.length;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\t') out += listChars.tab;
    else if (ch === '\r') out += '^M';
    else if (ch === ' ' && i >= trailStart && listChars.trail) out += listChars.trail;
    else out += ch;
  }
  return out + listChars.eol;
}

/**
 * nano's rendering of one raw character: `\t`/`\n` pass through, control
 * bytes (< 0x20, plus DEL) become `^X`.
 */
export function displayNotation(ch: string): string {
  if (ch === '\t' || ch === '\n') return ch;
  const code = ch.charCodeAt(0);
  if (code < 0x20) return '^' + String.fromCharCode(code + 64);
  if (code === 0x7f) return '^?';
  return ch;
}

/** Width (1 or 2) a single raw character occupies once rendered. */
export function displayWidth(ch: string): number {
  return displayNotation(ch).length;
}

/** Rendered column a (line, col) cursor sits at. */
export function displayColumnFor(lines: readonly string[], line: number, col: number): number {
  const text = lines[line] ?? '';
  let w = 0;
  for (let i = 0; i < col && i < text.length; i++) w += displayWidth(text[i]);
  return w;
}
