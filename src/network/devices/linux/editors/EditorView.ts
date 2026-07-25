/**
 * EditorView — a serialisable snapshot of an editor engine's screen.
 *
 * An editor opened over SSH runs on the server, where the file, its
 * permissions and its swap file actually live; only keystrokes and this
 * snapshot cross the wire (docs/PRD-SSH-Unification.md §4bis B3). The
 * local console renders the very same shape straight off its engine, so
 * one renderer serves both.
 */

import type { EditorFsContext } from './EditorFsContext';
import type { NanoMode, PendingReplaceMatch } from './NanoEngine';
import type { PendingSubstMatch, PendingSwapRecovery, VimMode, VimVariant } from './VimEngine';
import type { EditorKeyInput } from './EditorKeyInput';
import type { EditorName } from './editorLaunch';
import type { ListChars } from './editorRender';

export interface EditorViewBase {
  readonly filePath: string;
  readonly lines: readonly string[];
  readonly cursorLine: number;
  readonly cursorCol: number;
  readonly modified: boolean;
  readonly exited: boolean;
  readonly savedOnExit: boolean;
  readonly isReadOnly: boolean;
  readonly lineNumbersShown: boolean;
  /** Whether the file was absent when the buffer opened (vim's splash). */
  readonly isNewFile: boolean;
}

export interface VimEditorView extends EditorViewBase {
  readonly kind: 'vim';
  readonly variant: VimVariant;
  readonly mode: VimMode;
  readonly content: string;
  readonly message: string;
  readonly commandLineText: string;
  readonly searchText: string;
  readonly fileFormat: 'unix' | 'dos';
  readonly listMode: boolean;
  readonly relativeNumbersShown: boolean;
  readonly colorColumn: number | null;
  readonly isRecordingMacro: boolean;
  readonly recordingMacroName: string | null;
  readonly pendingBinaryWarning: string | null;
  readonly pendingSubstMatch: PendingSubstMatch | null;
  readonly pendingSwapRecovery: PendingSwapRecovery | null;
  /** `:set listchars` — the renderer applies it, so `:set list` works remotely. */
  readonly listChars: ListChars;
}

export interface NanoEditorView extends EditorViewBase {
  readonly kind: 'nano';
  readonly mode: NanoMode;
  readonly statusMessage: string;
  readonly helpText: string;
  readonly displayContent: string;
  readonly displayCursorOffset: number;
  readonly promptCursor: number;
  readonly saveFileName: string;
  readonly searchQuery: string;
  readonly gotoLineQuery: string;
  readonly executeCommandQuery: string;
  readonly readFileQuery: string;
  readonly regexSearchEnabled: boolean;
  readonly replaceSearchQuery: string;
  readonly replaceWithText: string;
  readonly pendingReplaceMatch: PendingReplaceMatch | null;
}

export type EditorView = VimEditorView | NanoEditorView;

/**
 * One editor running somewhere else — on the server side of an SSH
 * channel today. Keystrokes go in, a fresh view comes out.
 */
export interface EditorSession {
  readonly view: EditorView;
  applyKey(key: EditorKeyInput): EditorView;
  /** Clipboard paste, where the engine treats it as more than keystrokes. */
  applyPaste?(text: string): EditorView;
  /** Click-to-position, in rendered columns. */
  moveCursorToDisplayOffset?(offset: number): EditorView;
  close(): void;
}

/**
 * Everything an engine needs to be constructed, gathered by whoever
 * opens the session (the SSH server reads the remote's own VFS here).
 */
export interface EditorSessionSeed {
  /** The filesystem the engine acts on — the remote's own, over SSH. */
  readonly fs: EditorFsContext;
  readonly filePath: string;
  readonly content: string;
  readonly isNewFile: boolean;
  readonly owner: string;
  readonly readOnly: boolean;
  readonly showPosition: boolean;
  readonly showLineNumbers: boolean;
  readonly initialCursorLine?: number;
  readonly initialCursorCol?: number;
}
export type EditorSessionFactory = (seed: EditorSessionSeed) => EditorSession;

const registry = new Map<EditorName, EditorSessionFactory>();

/**
 * Register the engine that backs an editor name. Doing so is the whole
 * integration: the SSH server offers whatever is registered, and needs
 * to learn nothing about the engine itself.
 */
export function registerEditorSession(name: EditorName, factory: EditorSessionFactory): void {
  registry.set(name, factory);
}

export function createEditorSession(
  name: EditorName,
  seed: EditorSessionSeed,
): EditorSession | null {
  return registry.get(name)?.(seed) ?? null;
}

export function hasEditorSession(name: EditorName): boolean {
  return registry.has(name);
}
