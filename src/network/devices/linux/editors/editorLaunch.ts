/**
 * editorLaunch — one place that knows which command lines open an editor
 * and what their flags mean.
 *
 * Shared by the local terminal and by the SSH server, so a session
 * opened over the wire honours `-v`, `-l`, `+LINE,COL` exactly as a
 * console one does. Registering another editor here is the only change
 * a new engine needs to be reachable from both.
 */

export type EditorName = 'nano' | 'vi' | 'vim';

const EDITOR_NAMES: readonly EditorName[] = ['nano', 'vi', 'vim'];

/** Flags that make the binary print and exit instead of opening a buffer. */
const NON_OPENING_FLAGS = new Set(['--version', '-V', '--help', '-h']);

export interface EditorLaunch {
  readonly editor: EditorName;
  /** Path as typed — still relative; the FS context resolves it. */
  readonly filePath: string;
  readonly readOnly: boolean;
  readonly showPosition: boolean;
  readonly showLineNumbers: boolean;
  readonly initialCursorLine?: number;
  readonly initialCursorCol?: number;
}

/** Is this segment a `nano`/`vi`/`vim` invocation (with or without sudo)? */
export function isEditorSegment(segment: string): boolean {
  return parseEditorLaunch(segment) !== null;
}

/**
 * Read an editor invocation, or null when the line opens no editor —
 * a different command, or one of the print-and-exit flags.
 */
export function parseEditorLaunch(commandLine: string): EditorLaunch | null {
  const trimmed = commandLine.trim();
  const noSudo = trimmed.startsWith('sudo ') ? trimmed.slice(5).trimStart() : trimmed;
  const parts = noSudo.split(/\s+/).filter(Boolean);
  const head = parts[0] as EditorName | undefined;
  if (!head || !EDITOR_NAMES.includes(head)) return null;

  const args = parts.slice(1);
  if (args.some((a) => NON_OPENING_FLAGS.has(a))) return null;

  let filePath = '';
  for (const arg of args) {
    if (!arg.startsWith('-') && !arg.startsWith('+')) { filePath = arg; break; }
  }

  // `+LINE[,COLUMN]` (nano) / `+LINE` (vim/vi): real editors take the
  // LAST such argument when several are given.
  let initialCursorLine: number | undefined;
  let initialCursorCol: number | undefined;
  for (const arg of args) {
    const m = /^\+(\d+)(?:,(\d+))?$/.exec(arg);
    if (m) {
      initialCursorLine = parseInt(m[1], 10);
      initialCursorCol = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
    }
  }

  // nano-only display flags; vi/vim express the same ideas through
  // `:view` and `:set ruler` instead.
  const isNano = head === 'nano';
  return {
    editor: head,
    filePath,
    readOnly: isNano && args.some((a) => a === '-v' || a === '--view'),
    showPosition: isNano && args.some((a) => a === '-c' || a === '--constantshow'),
    showLineNumbers: isNano && args.some((a) => a === '-l' || a === '--linenumbers'),
    initialCursorLine,
    initialCursorCol,
  };
}
