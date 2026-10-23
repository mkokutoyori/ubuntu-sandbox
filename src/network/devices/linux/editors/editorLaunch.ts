/**
 * editorLaunch — one place that knows which command lines open an editor
 * and what their flags mean.
 *
 * Shared by the local terminal and by the SSH server, so a session
 * opened over the wire honours `-v`, `-l`, `+LINE,COL` exactly as a
 * console one does. Registering another editor here is the only change
 * a new engine needs to be reachable from both.
 */

import { parseNanoCommandLine, type NanoStart } from './nano/NanoCommandLine';
import type { NanoSettings } from './nano/NanoSettings';
import { invalidOperatingDirectoryMessage, operatingDirectoryRoot, type OperatingDirectoryHost } from './nano/NanoOperatingDirectory';

export type EditorName = 'nano' | 'vi' | 'vim';

const EDITOR_NAMES: readonly EditorName[] = ['nano', 'vi', 'vim'];

/** Flags that make the binary print and exit instead of opening a buffer. */
const NON_OPENING_FLAGS = new Set(['--version', '-V', '--help', '-h']);

export interface NanoLaunch {
  readonly settings: NanoSettings;
  readonly start: NanoStart | null;
}

export interface EditorLaunch {
  readonly editor: EditorName;
  /** Path as typed — still relative; the FS context resolves it. */
  readonly filePath: string;
  readonly nano: NanoLaunch | null;
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

  return parseEditorArgs(head, parts.slice(1));
}

export function parseEditorArgs(editor: EditorName, args: readonly string[]): EditorLaunch | null {
  if (editor === 'nano') {
    const invocation = parseNanoCommandLine(args);
    if (invocation.kind !== 'open') return null;
    const first = invocation.files[0];
    return { editor, filePath: first?.path ?? '', nano: { settings: invocation.settings, start: first?.start ?? null } };
  }
  if (args.some((a) => NON_OPENING_FLAGS.has(a))) return null;

  let filePath = '';
  for (const arg of args) {
    if (!arg.startsWith('-') && !arg.startsWith('+')) { filePath = arg; break; }
  }

  let initialCursorLine: number | undefined;
  let initialCursorCol: number | undefined;
  for (const arg of args) {
    const m = /^\+(\d+)(?:,(\d+))?$/.exec(arg);
    if (m) {
      initialCursorLine = parseInt(m[1], 10);
      initialCursorCol = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
    }
  }

  return { editor, filePath, nano: null, initialCursorLine, initialCursorCol };
}

export function editorLaunchFailure(host: OperatingDirectoryHost, launch: EditorLaunch): string | null {
  const operating = launch.nano?.settings.operatingdir ?? null;
  return operating !== null && operatingDirectoryRoot(host, operating) === null ? invalidOperatingDirectoryMessage(operating) : null;
}

export function launchedFilePath(host: OperatingDirectoryHost, launch: EditorLaunch): string {
  if (launch.filePath === '') return '';
  const operating = launch.nano?.settings.operatingdir ?? null;
  const root = operating === null ? null : operatingDirectoryRoot(host, operating);
  return host.resolvePath(root === null || launch.filePath.startsWith('/') ? launch.filePath : `${root}${launch.filePath}`);
}

export function viVariantFor(vimPackageInstalled: boolean): 'vi' | 'vim' {
  return vimPackageInstalled ? 'vim' : 'vi';
}
