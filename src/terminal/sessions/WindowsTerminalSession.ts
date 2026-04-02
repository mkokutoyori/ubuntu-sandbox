/**
 * WindowsTerminalSession — Windows CMD + PowerShell terminal model.
 *
 * PowerShell is a sub-shell of cmd.exe, using the same ISubShell
 * interface as SQL*Plus is for Linux bash. Shell nesting is supported
 * via a stack of ISubShell instances (cmd → PS → cmd → PS → …).
 *
 * Features:
 *   - Sub-shell architecture: PowerShell & nested cmd via ISubShell
 *   - Shell nesting with stack (same pattern as Linux sub-shells)
 *   - Tab completion (PS cmdlets + device file paths)
 */

import { Equipment } from '@/network';
import {
  TerminalSession, TerminalTheme, SessionType, KeyEvent, nextLineId,
  type InputMode,
} from './TerminalSession';
import { PlainOutputFormatter, type IOutputFormatter } from '@/terminal/core/OutputFormatter';
import { completeInputCaseInsensitive } from '@/terminal/core/TabCompletionHelper';
import { PS_CMDLETS_LIST } from '@/network/devices/windows/PowerShellExecutor';
import type { ISubShell, SubShellResult } from '@/terminal/subshells/ISubShell';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { CmdSubShell } from '@/terminal/subshells/CmdSubShell';

const WINDOWS_THEME: TerminalTheme = {
  sessionType: 'windows',
  backgroundColor: '#0c0c0c',
  textColor: '#cccccc',
  errorColor: '#f14c4c',
  promptColor: '#cccccc',
  fontFamily: "'Cascadia Mono', 'Consolas', 'Courier New', monospace",
  infoBarBg: '#0c0c0c',
  infoBarText: '#808080',
  infoBarBorder: '#333333',
  warningColor: '#cca700',
};

export class WindowsTerminalSession extends TerminalSession {
  bannerCleared: boolean = false;
  tabSuggestions: string[] | null = null;

  private readonly _flowFormatter = new PlainOutputFormatter();
  private _onRequestClose?: () => void;
  private _onShellModeChange?: (mode: 'cmd' | 'powershell') => void;

  /** Active sub-shell (PowerShell or nested cmd). Null when in root cmd mode. */
  private activeSubShell: ISubShell | null = null;
  /** Stack of parent sub-shells for nesting (cmd → PS → cmd → …). */
  private subShellStack: ISubShell[] = [];
  /** Command history for the active sub-shell. */
  private subShellHistory: string[] = [];
  /** History navigation index for the active sub-shell (-1 = not navigating). */
  private subShellHistoryIndex: number = -1;
  /** Saved input before history navigation started. */
  private subShellSavedInput: string = '';

  constructor(id: string, device: Equipment) {
    super(id, device);
  }

  getSessionType(): SessionType { return 'windows'; }
  getTheme(): TerminalTheme { return WINDOWS_THEME; }
  protected getFlowFormatter(): IOutputFormatter { return this._flowFormatter; }

  /**
   * Current shell mode — derived from the active sub-shell type.
   * Used by UI components (TerminalModal, TerminalView) for display.
   */
  get shellMode(): 'cmd' | 'powershell' {
    if (this.activeSubShell instanceof PowerShellSubShell) return 'powershell';
    return 'cmd';
  }

  /**
   * Shell stack depth — used by TerminalView to decide whether to show the CMD banner.
   * Returns an array-like with a length property for compatibility.
   */
  get shellStack(): { length: number } {
    return { length: this.subShellStack.length + (this.activeSubShell ? 1 : 0) };
  }

  getPrompt(): string {
    if (this.activeSubShell) {
      return this.activeSubShell.getPrompt();
    }
    return `${(this.device as any).getCwd()}>`;
  }

  override get currentInputMode(): InputMode {
    if (this.activeSubShell) {
      return { type: 'interactive-text', promptText: this.activeSubShell.getPrompt() };
    }
    return this.inputMode;
  }

  getInfoBarContent() {
    return { left: '' }; // Windows terminal has no info bar
  }

  onRequestClose(cb: () => void): void { this._onRequestClose = cb; }
  onShellModeChange(cb: (mode: 'cmd' | 'powershell') => void): void { this._onShellModeChange = cb; }

  async init(): Promise<void> {
    // No boot sequence for Windows terminal — ready immediately
  }

  // ── Key handling ────────────────────────────────────────────────

  handleKey(e: KeyEvent): boolean {
    if (this.disposed) return false;

    // Sub-shell active (PowerShell or nested cmd) — route input there
    if (this.activeSubShell) {
      return this.handleSubShellKey(e);
    }

    return super.handleKey(e);
  }

  protected handleModeKey(_e: KeyEvent): boolean {
    return false; // Windows has no special modes (no pager, no boot keys)
  }

  protected handleNormalKey(e: KeyEvent): boolean {
    // Tab
    if (e.key === 'Tab') {
      this.onTab();
      return true;
    }

    // Clear tab suggestions on non-Tab key
    if (e.key !== 'Tab' && this.tabSuggestions) {
      this.tabSuggestions = null;
      this.notify();
    }

    // Escape → clear input
    if (e.key === 'Escape') {
      this.input = '';
      this.tabSuggestions = null;
      this.notify();
      return true;
    }

    // Ctrl+C
    if (e.key === 'c' && e.ctrlKey) {
      this.addLine(`${this.getPrompt()}${this.input}^C`, 'warning');
      this.input = '';
      this.notify();
      return true;
    }

    // Ctrl+L
    if (e.key === 'l' && e.ctrlKey) {
      this.lines = [];
      this.bannerCleared = true;
      this.notify();
      return true;
    }

    return super.handleNormalKey(e);
  }

  // ── Command execution (root cmd mode) ──────────────────────────

  protected onEnter(): void {
    const cmd = this.input;
    this.input = '';
    this.tabSuggestions = null;
    this.recordEvent('input', cmd);
    this.executeCommand(cmd);
    this.notify();
  }

  private async executeCommand(cmd: string): Promise<void> {
    const trimmed = cmd.trim();
    const prompt = this.getPrompt();

    this.addLine(`${prompt}${cmd}`, 'prompt');

    if (!trimmed) return;

    // Handle exit at root level → close terminal
    if (trimmed.toLowerCase() === 'exit') {
      this._onRequestClose?.();
      return;
    }

    this.pushHistory(trimmed);

    // Detect PowerShell launch from root cmd
    const lower = trimmed.toLowerCase();
    if (lower === 'powershell' || lower === 'powershell.exe' || lower === 'pwsh' || lower === 'pwsh.exe') {
      this.enterPowerShell();
      return;
    }

    // cls
    if (lower === 'cls') {
      this.lines = [];
      this.bannerCleared = true;
      this.notify();
      return;
    }

    // Execute on device (root cmd)
    try {
      const result = await this.executeOnDevice(trimmed);
      if (result !== undefined && result !== null && result !== '') {
        this.addMultiLine(result);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'DeviceOfflineError') {
        this.addLine('Device is powered off — session disconnected', 'error');
        return;
      }
      if (err instanceof Error && err.name === 'CommandTimeoutError') {
        this.addLine('Command execution timed out', 'error');
      } else {
        this.addLine(`Error: ${err}`, 'error');
      }
    }

    this.notify();
  }

  // ── Sub-shell management ───────────────────────────────────────

  private enterPowerShell(): void {
    const { subShell, banner } = PowerShellSubShell.create(this.device);
    // If there's already an active subshell, push it onto the stack
    if (this.activeSubShell) {
      this.subShellStack.push(this.activeSubShell);
    }
    this.activeSubShell = subShell;
    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;

    for (const line of banner) {
      this.lines.push({ id: nextLineId(), text: line, type: 'ps-header' });
    }
    this._onShellModeChange?.('powershell');
    this.notify();
  }

  private enterNestedCmd(): void {
    const { subShell, banner } = CmdSubShell.create(this.device);
    // Push current subshell (PowerShell) onto the stack
    if (this.activeSubShell) {
      this.subShellStack.push(this.activeSubShell);
    }
    this.activeSubShell = subShell;
    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;

    for (const line of banner) {
      this.addLine(line);
    }
    this._onShellModeChange?.('cmd');
    this.notify();
  }

  private exitSubShell(): void {
    if (this.activeSubShell) {
      this.activeSubShell.dispose();
    }

    // Pop the parent sub-shell from the stack
    if (this.subShellStack.length > 0) {
      this.activeSubShell = this.subShellStack.pop()!;
    } else {
      this.activeSubShell = null;
    }

    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;
    this.subShellSavedInput = '';

    this._onShellModeChange?.(this.shellMode);
    this.notify();
  }

  /**
   * Generic sub-shell key handler.
   * Works for PowerShell and nested cmd sub-shells.
   */
  private handleSubShellKey(e: KeyEvent): boolean {
    if (!this.activeSubShell) return false;

    if (e.key === 'Enter') {
      const line = this._inputBuf;
      this._inputBuf = '';
      this.subShellHistoryIndex = -1;
      this.subShellSavedInput = '';
      this.addLine(`${this.activeSubShell.getPrompt()}${line}`);

      // Push non-empty lines to sub-shell history
      if (line.trim()) {
        this.subShellHistory = [...this.subShellHistory.slice(-199), line];
      }

      const maybePromise = this.activeSubShell.processLine(line);

      const applyResult = (result: SubShellResult & { _enterPowerShell?: boolean; _enterCmd?: boolean }) => {
        if (result.clearScreen) {
          this.lines = [];
          this.bannerCleared = true;
        }

        for (const outputLine of result.output) this.addLine(outputLine);

        if (result.exit) {
          this.exitSubShell();
          return;
        }

        // Handle nested shell transitions
        if (result._enterPowerShell) {
          this.enterPowerShell();
          return;
        }
        if (result._enterCmd) {
          this.enterNestedCmd();
          return;
        }

        this.notify();
      };

      if (maybePromise instanceof Promise) {
        maybePromise.then(applyResult);
      } else {
        applyResult(maybePromise as SubShellResult & { _enterPowerShell?: boolean; _enterCmd?: boolean });
      }
      return true;
    }

    // Arrow Up → sub-shell history previous
    if (e.key === 'ArrowUp') {
      if (this.subShellHistory.length === 0) return true;
      if (this.subShellHistoryIndex === -1) {
        this.subShellSavedInput = this._inputBuf;
        this.subShellHistoryIndex = this.subShellHistory.length - 1;
      } else if (this.subShellHistoryIndex > 0) {
        this.subShellHistoryIndex--;
      }
      this._inputBuf = this.subShellHistory[this.subShellHistoryIndex] || '';
      this.notify();
      return true;
    }

    // Arrow Down → sub-shell history next
    if (e.key === 'ArrowDown') {
      if (this.subShellHistoryIndex === -1) return true;
      const idx = this.subShellHistoryIndex + 1;
      if (idx >= this.subShellHistory.length) {
        this.subShellHistoryIndex = -1;
        this._inputBuf = this.subShellSavedInput;
        this.subShellSavedInput = '';
      } else {
        this.subShellHistoryIndex = idx;
        this._inputBuf = this.subShellHistory[idx] || '';
      }
      this.notify();
      return true;
    }

    // Escape → clear input
    if (e.key === 'Escape') {
      this._inputBuf = '';
      this.tabSuggestions = null;
      this.notify();
      return true;
    }

    // Ctrl+C → cancel current input
    if (e.key === 'c' && e.ctrlKey) {
      this._inputBuf = '';
      this.subShellHistoryIndex = -1;
      this.addLine(`${this.activeSubShell.getPrompt()}^C`);
      this.notify();
      return true;
    }

    // Ctrl+L → clear screen
    if (e.key === 'l' && e.ctrlKey) {
      this.lines = [];
      this.bannerCleared = true;
      this.notify();
      return true;
    }

    // Tab completion in sub-shell
    if (e.key === 'Tab') {
      this.onSubShellTab();
      return true;
    }

    // Clear tab suggestions on non-Tab key
    if (e.key !== 'Tab' && this.tabSuggestions) {
      this.tabSuggestions = null;
      this.notify();
    }

    // Let the view handle other keys (typing into the interactive-text input)
    return false;
  }

  // ── Tab completion ──────────────────────────────────────────────

  private onSubShellTab(): void {
    // PowerShell cmdlet completion
    if (this.activeSubShell instanceof PowerShellSubShell) {
      const parts = this._inputBuf.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        const prefix = (parts[0] || '').toLowerCase();
        const matches = PS_CMDLETS_LIST.filter(c => c.toLowerCase().startsWith(prefix));
        const result = completeInputCaseInsensitive(this._inputBuf, matches, 20);
        this._inputBuf = result.input;
        this.tabSuggestions = result.suggestions;
        this.notify();
        return;
      }
    }

    // Fall back to device completions for file paths
    const completions = this.device.getCompletions(this._inputBuf);
    if (completions.length === 0) return;

    const result = completeInputCaseInsensitive(this._inputBuf, completions);
    this._inputBuf = result.input;
    this.tabSuggestions = result.suggestions;
    this.notify();
  }

  protected onTab(): void {
    // Root cmd tab completion — same as before
    const completions = this.device.getCompletions(this.input);
    if (completions.length === 0) return;

    const result = completeInputCaseInsensitive(this.input, completions);
    this.input = result.input;
    this.tabSuggestions = result.suggestions;
    this.notify();
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private addMultiLine(text: string, type: string = 'normal'): void {
    const lines = text.split('\n');
    for (const line of lines) {
      this.lines.push({ id: nextLineId(), text: line, type });
    }
    this.notify();
  }
}
