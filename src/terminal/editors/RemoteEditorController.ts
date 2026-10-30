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
import type { EditorScreen } from '@/network/devices/linux/editors/screen/EditorScreen';
import type {
  EditorView,
  LessEditorView,
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

/** The wire operations a controller needs; satisfied by ISshShellChannel. */
export interface RemoteEditorTransport {
  sendEditorKey(key: EditorKeyInput): Promise<EditorView | null>;
  pasteIntoEditor(text: string): Promise<EditorView | null>;
  clickEditor(row: number, col: number): Promise<EditorView | null>;
  scrollEditor(up: boolean, count: number): Promise<EditorView | null>;
  onEditorView(handler: (view: EditorView) => void): () => void;
  resize(cols: number, rows: number): void;
  closeEditor(): void;
}

abstract class BaseRemoteEditorController<V extends EditorView> {
  protected current: V;
  private readonly stopListening: () => void;

  constructor(
    protected readonly transport: RemoteEditorTransport,
    initial: V,
    /** Called after each screen arrives so the overlay can re-render. */
    private readonly onUpdate: () => void,
  ) {
    this.current = initial;
    this.stopListening = transport.onEditorView((view) => this.absorb(view));
  }

  get lines(): readonly string[] { return this.current.lines; }
  get cursorLine(): number { return this.current.cursorLine; }
  get cursorCol(): number { return this.current.cursorCol; }
  get modified(): boolean { return this.current.modified; }
  get exited(): boolean { return this.current.exited; }
  get savedOnExit(): boolean { return this.current.savedOnExit; }
  get isReadOnly(): boolean { return this.current.isReadOnly; }
  get lineNumbersShown(): boolean { return this.current.lineNumbersShown; }
  get isNewFile(): boolean { return this.current.isNewFile; }

  /**
   * Keystrokes reach the engine one round trip later — the same
   * behaviour a real editor over SSH has. The overlay re-renders when
   * the screen lands.
   */
  applyKey(key: EditorKeyInput): void {
    void this.transport.sendEditorKey(key).then((view) => this.absorb(view));
  }

  dispose(): void {
    this.stopListening();
    this.transport.closeEditor();
  }

  resize(rows: number, cols: number): void { this.transport.resize(cols, rows); }

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
  get fileFormat(): 'unix' | 'dos' | 'mac' { return this.current.fileFormat; }
  get listMode(): boolean { return this.current.listMode; }
  get relativeNumbersShown(): boolean { return this.current.relativeNumbersShown; }
  get colorColumn(): number | null { return this.current.colorColumn; }
  get isRecordingMacro(): boolean { return this.current.isRecordingMacro; }
  get recordingMacroName(): string | null { return this.current.recordingMacroName; }
  get pendingBinaryWarning(): string | null { return this.current.pendingBinaryWarning; }
  get pendingSubstMatch(): PendingSubstMatch | null { return this.current.pendingSubstMatch; }
  get pendingSwapRecovery(): PendingSwapRecovery | null { return this.current.pendingSwapRecovery; }
  get isReplacing(): boolean { return this.current.isReplacing; }
  get searchPromptChar(): '/' | '?' { return this.current.searchPromptChar; }
  get visualAnchor(): { line: number; col: number } { return { ...this.current.visualAnchor }; }
  get screen(): EditorScreen { return this.current.screen; }

  scrollView(up: boolean, count: number): void {
    void this.transport.scrollEditor(up, count).then((view) => this.absorb(view));
  }

  clickAt(row: number, col: number): void {
    void this.transport.clickEditor(row, col).then((view) => this.absorb(view));
  }
}

export class RemoteNanoController extends BaseRemoteEditorController<NanoEditorView> {
  get mode(): NanoMode { return this.current.mode; }
  get screen(): EditorScreen { return this.current.screen; }
  get statusMessage(): string { return this.current.statusMessage; }
  get helpText(): string { return this.current.helpText; }
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
  get exitNotice(): string { return this.current.exitNotice; }

  scrollView(up: boolean, count: number): void {
    void this.transport.scrollEditor(up, count).then((view) => this.absorb(view));
  }

  applyPaste(text: string): void {
    void this.transport.pasteIntoEditor(text).then((view) => this.absorb(view));
  }

  clickAt(row: number, col: number): void {
    void this.transport.clickEditor(row, col).then((view) => this.absorb(view));
  }
}

export class RemoteLessController extends BaseRemoteEditorController<LessEditorView> {
  get screen(): EditorScreen { return this.current.screen; }
  get exitNotice(): string { return ''; }

  scrollView(up: boolean, count: number): void {
    void this.transport.scrollEditor(up, count).then((view) => this.absorb(view));
  }
}

export function createRemoteEditorController(
  transport: RemoteEditorTransport,
  view: EditorView,
  onUpdate: () => void,
): RemoteVimController | RemoteNanoController | RemoteLessController {
  if (view.kind === 'less') return new RemoteLessController(transport, view, onUpdate);
  return view.kind === 'vim'
    ? new RemoteVimController(transport, view, onUpdate)
    : new RemoteNanoController(transport, view, onUpdate);
}
