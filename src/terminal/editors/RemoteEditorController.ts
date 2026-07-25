/**
 * RemoteEditorController — the object a VimEditor / NanoEditor overlay
 * drives when the buffer lives on the far side of an SSH channel.
 *
 * It exposes exactly the surface the overlays already read off a local
 * engine, served from the last screen the server sent. Keystrokes are
 * forwarded and the fresh screen replaces the old one, so the overlay
 * needs to know nothing about where the file actually is
 * (docs/PRD-SSH-Unification.md §4bis B3).
 *
 * Design pattern: **Proxy** — same interface, remote subject.
 */

import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import type {
  EditorView,
  NanoEditorView,
  VimEditorView,
} from '@/network/devices/linux/editors/EditorView';
import type { NanoMode, PendingReplaceMatch } from '@/network/devices/linux/editors/NanoEngine';
import type {
  PendingSubstMatch,
  PendingSwapRecovery,
  VimMode,
  VimVariant,
} from '@/network/devices/linux/editors/VimEngine';
import {
  displayColumnFor,
  renderListLine,
} from '@/network/devices/linux/editors/editorRender';

/** The wire operations a controller needs; satisfied by ISshShellChannel. */
export interface RemoteEditorTransport {
  sendEditorKey(key: EditorKeyInput): Promise<EditorView | null>;
  pasteIntoEditor(text: string): Promise<EditorView | null>;
  moveEditorCursor(offset: number): Promise<EditorView | null>;
  closeEditor(): void;
}

abstract class BaseRemoteEditorController<V extends EditorView> {
  protected current: V;

  constructor(
    protected readonly transport: RemoteEditorTransport,
    initial: V,
    /** Called after each screen arrives so the overlay can re-render. */
    private readonly onUpdate: () => void,
  ) {
    this.current = initial;
  }

  get lines(): readonly string[] { return this.current.lines; }
  get cursorLine(): number { return this.current.cursorLine; }
  get cursorCol(): number { return this.current.cursorCol; }
  get modified(): boolean { return this.current.modified; }
  get exited(): boolean { return this.current.exited; }
  get savedOnExit(): boolean { return this.current.savedOnExit; }
  get isReadOnly(): boolean { return this.current.isReadOnly; }
  get lineNumbersShown(): boolean { return this.current.lineNumbersShown; }

  /**
   * Keystrokes reach the engine one round trip later — the same
   * behaviour a real editor over SSH has. The overlay re-renders when
   * the screen lands.
   */
  applyKey(key: EditorKeyInput): void {
    void this.transport.sendEditorKey(key).then((view) => this.absorb(view));
  }

  dispose(): void { this.transport.closeEditor(); }

  protected absorb(view: EditorView | null): void {
    if (view) this.current = view as V;
    this.onUpdate();
  }
}

export class RemoteVimController extends BaseRemoteEditorController<VimEditorView> {
  get variant(): VimVariant { return this.current.variant; }
  get mode(): VimMode { return this.current.mode; }
  get content(): string { return this.current.content; }
  get message(): string { return this.current.message; }
  get commandLineText(): string { return this.current.commandLineText; }
  get searchText(): string { return this.current.searchText; }
  get fileFormat(): 'unix' | 'dos' { return this.current.fileFormat; }
  get listMode(): boolean { return this.current.listMode; }
  get relativeNumbersShown(): boolean { return this.current.relativeNumbersShown; }
  get colorColumn(): number | null { return this.current.colorColumn; }
  get isRecordingMacro(): boolean { return this.current.isRecordingMacro; }
  get recordingMacroName(): string | null { return this.current.recordingMacroName; }
  get pendingBinaryWarning(): string | null { return this.current.pendingBinaryWarning; }
  get pendingSubstMatch(): PendingSubstMatch | null { return this.current.pendingSubstMatch; }
  get pendingSwapRecovery(): PendingSwapRecovery | null { return this.current.pendingSwapRecovery; }

  renderListLine(line: string): string {
    if (!this.current.listMode) return line;
    return renderListLine(line, this.current.listChars);
  }
}

export class RemoteNanoController extends BaseRemoteEditorController<NanoEditorView> {
  get mode(): NanoMode { return this.current.mode; }
  get statusMessage(): string { return this.current.statusMessage; }
  get helpText(): string { return this.current.helpText; }
  get displayContent(): string { return this.current.displayContent; }
  get displayCursorOffset(): number { return this.current.displayCursorOffset; }
  get promptCursor(): number { return this.current.promptCursor; }
  get saveFileName(): string { return this.current.saveFileName; }
  get searchQuery(): string { return this.current.searchQuery; }
  get gotoLineQuery(): string { return this.current.gotoLineQuery; }
  get executeCommandQuery(): string { return this.current.executeCommandQuery; }
  get readFileQuery(): string { return this.current.readFileQuery; }
  get regexSearchEnabled(): boolean { return this.current.regexSearchEnabled; }
  get replaceSearchQuery(): string { return this.current.replaceSearchQuery; }
  get replaceWithText(): string { return this.current.replaceWithText; }
  get pendingReplaceMatch(): PendingReplaceMatch | null { return this.current.pendingReplaceMatch; }

  displayColumnFor(line: number, col: number): number {
    return displayColumnFor(this.current.lines, line, col);
  }

  applyPaste(text: string): void {
    void this.transport.pasteIntoEditor(text).then((view) => this.absorb(view));
  }

  moveCursorToDisplayOffset(offset: number): void {
    void this.transport.moveEditorCursor(offset).then((view) => this.absorb(view));
  }
}

export function createRemoteEditorController(
  transport: RemoteEditorTransport,
  view: EditorView,
  onUpdate: () => void,
): RemoteVimController | RemoteNanoController {
  return view.kind === 'vim'
    ? new RemoteVimController(transport, view, onUpdate)
    : new RemoteNanoController(transport, view, onUpdate);
}
