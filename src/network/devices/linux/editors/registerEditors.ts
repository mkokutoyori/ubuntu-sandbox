/**
 * registerEditors — bind the built-in engines to their editor names so
 * an SSH channel can open them on the server side of the wire
 * (docs/PRD-SSH-Unification.md §4bis B3).
 *
 * Each entry is a `toView()` projection over an engine that is otherwise
 * untouched: the engine still owns the buffer, the modes and every
 * filesystem effect. Adding another editor means writing its engine and
 * adding one entry here.
 */

import { NanoEngine } from './NanoEngine';
import { VimEngine } from './VimEngine';
import {
  registerEditorSession,
  type EditorSession,
  type EditorSessionSeed,
  type NanoEditorView,
  type VimEditorView,
} from './EditorView';

let installed = false;

function vimSession(variant: 'vi' | 'vim', seed: EditorSessionSeed): EditorSession {
  const engine = new VimEngine(
    seed.fs, seed.filePath, seed.content, seed.isNewFile, variant, seed.owner,
    seed.initialCursorLine !== undefined ? { line: seed.initialCursorLine } : undefined,
  );
  const view = (): VimEditorView => ({
    kind: 'vim',
    variant,
    filePath: seed.filePath,
    lines: [...engine.lines],
    cursorLine: engine.cursorLine,
    cursorCol: engine.cursorCol,
    modified: engine.modified,
    exited: engine.exited,
    savedOnExit: engine.savedOnExit,
    isReadOnly: engine.isReadOnly,
    lineNumbersShown: engine.lineNumbersShown,
    mode: engine.mode,
    content: engine.content,
    message: engine.message,
    commandLineText: engine.commandLineText,
    searchText: engine.searchText,
    fileFormat: engine.fileFormat,
    listMode: engine.listMode,
    relativeNumbersShown: engine.relativeNumbersShown,
    colorColumn: engine.colorColumn,
    isRecordingMacro: engine.isRecordingMacro,
    recordingMacroName: engine.recordingMacroName,
    pendingBinaryWarning: engine.pendingBinaryWarning,
    pendingSubstMatch: engine.pendingSubstMatch,
    pendingSwapRecovery: engine.pendingSwapRecovery,
  });
  return {
    get view() { return view(); },
    applyKey: (key) => { engine.applyKey(key); return view(); },
    close: () => { if (!engine.exited) engine.applyKey({ key: 'q', ctrl: false }); },
  };
}

function nanoSession(seed: EditorSessionSeed): EditorSession {
  const engine = new NanoEngine(
    seed.fs, seed.filePath, seed.content, seed.isNewFile, seed.readOnly,
    seed.initialCursorLine !== undefined
      ? { line: seed.initialCursorLine, col: seed.initialCursorCol }
      : undefined,
    seed.showLineNumbers,
  );
  const view = (): NanoEditorView => ({
    kind: 'nano',
    filePath: seed.filePath,
    lines: [...engine.lines],
    cursorLine: engine.cursorLine,
    cursorCol: engine.cursorCol,
    modified: engine.modified,
    exited: engine.exited,
    savedOnExit: engine.savedOnExit,
    isReadOnly: engine.isReadOnly,
    lineNumbersShown: engine.lineNumbersShown,
    mode: engine.mode,
    statusMessage: engine.statusMessage,
    helpText: engine.helpText,
    displayContent: engine.displayContent,
    displayCursorOffset: engine.displayCursorOffset,
    promptCursor: engine.promptCursor,
    saveFileName: engine.saveFileName,
    searchQuery: engine.searchQuery,
    gotoLineQuery: engine.gotoLineQuery,
    executeCommandQuery: engine.executeCommandQuery,
    readFileQuery: engine.readFileQuery,
    regexSearchEnabled: engine.regexSearchEnabled,
    replaceSearchQuery: engine.replaceSearchQuery,
    replaceWithText: engine.replaceWithText,
    pendingReplaceMatch: engine.pendingReplaceMatch,
  });
  return {
    get view() { return view(); },
    applyKey: (key) => { engine.applyKey(key); return view(); },
    close: () => { if (!engine.exited) engine.applyKey({ key: 'x', ctrl: true }); },
  };
}

export function installDefaultEditors(): void {
  if (installed) return;
  installed = true;
  registerEditorSession('vim', (seed) => vimSession('vim', seed));
  registerEditorSession('vi', (seed) => vimSession('vi', seed));
  registerEditorSession('nano', nanoSession);
}
