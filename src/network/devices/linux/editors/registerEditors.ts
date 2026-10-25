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
import { viVariantFor } from './editorLaunch';
import { findPackage } from '../packages/PackageDatabase';
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
    seed.displayName,
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
    isNewFile: seed.isNewFile,
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
    isReplacing: engine.isReplacing,
    searchPromptChar: engine.searchPromptChar,
    visualAnchor: engine.visualAnchor,
    screen: engine.screen,
  });
  return {
    get view() { return view(); },
    applyKey: (key) => { engine.applyKey(key); return view(); },
    resize: (rows, cols) => { engine.resize(rows, cols); return view(); },
    click: (row, col) => { engine.clickAt(row, col); return view(); },
    scroll: (up, count) => { engine.scrollView(up, count); return view(); },
    close: () => { if (!engine.exited) engine.applyKey({ key: 'q', ctrl: false }); },
  };
}

function nanoSession(seed: EditorSessionSeed): EditorSession {
  const engine = new NanoEngine(
    seed.fs, seed.filePath, seed.content, seed.isNewFile, false, undefined, false,
    { settings: seed.nano?.settings, start: seed.nano?.start, displayName: seed.displayName },
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
    isNewFile: seed.isNewFile,
    mode: engine.mode,
    statusMessage: engine.statusMessage,
    helpText: engine.helpText,
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
    exitNotice: engine.exitNotice,
    screen: engine.screen,
  });
  return {
    get view() { return view(); },
    applyKey: (key) => { engine.applyKey(key); return view(); },
    applyPaste: (text) => { engine.applyPaste(text); return view(); },
    click: (row, col) => { engine.clickAt(row, col); return view(); },
    resize: (rows, cols) => { engine.resize(rows, cols); return view(); },
    scroll: (up, count) => { engine.scrollView(up, count); return view(); },
    close: () => { if (!engine.exited) engine.applyKey({ key: 'x', ctrl: true }); },
  };
}

function viVariant(): 'vi' | 'vim' {
  return viVariantFor(findPackage('vim')?.installed === true);
}

export function installDefaultEditors(): void {
  if (installed) return;
  installed = true;
  registerEditorSession('vim', (seed) => vimSession('vim', seed));
  registerEditorSession('vi', (seed) => vimSession(viVariant(), seed));
  registerEditorSession('nano', nanoSession);
}
