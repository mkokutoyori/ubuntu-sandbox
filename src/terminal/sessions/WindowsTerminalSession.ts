/**
 * WindowsTerminalSession — Windows CMD + PowerShell terminal model.
 *
 * PowerShell is managed as a subshell of cmd.exe at the device level
 * (WindowsPC). This session delegates shell mode management, prompt
 * generation, and command routing entirely to the device.
 *
 * Features:
 *   - Shell nesting handled by device (PowerShell from CMD, CMD from PowerShell, exit to return)
 *   - Tab completion (PS cmdlets + device file paths)
 */

import { Equipment } from '@/network';
import {
  TerminalSession, TerminalTheme, SessionType, KeyEvent, nextLineId,
} from './TerminalSession';
import { PlainOutputFormatter, type IOutputFormatter } from '@/terminal/core/OutputFormatter';
import { completeInput, completeInputCaseInsensitive } from '@/terminal/core/TabCompletionHelper';
import { PS_CMDLETS_LIST } from '@/network/devices/windows/PowerShellExecutor';
import type { WindowsPC } from '@/network/devices/WindowsPC';

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

  /** Typed accessor for the underlying WindowsPC device. */
  private get winDevice(): WindowsPC { return this.device as WindowsPC; }

  constructor(id: string, device: Equipment) {
    super(id, device);
  }

  getSessionType(): SessionType { return 'windows'; }
  getTheme(): TerminalTheme { return WINDOWS_THEME; }
  protected getFlowFormatter(): IOutputFormatter { return this._flowFormatter; }

  /** Shell mode is read from the device. */
  get shellMode(): 'cmd' | 'powershell' { return this.winDevice.getShellMode(); }
  /** Shell stack is read from the device. */
  get shellStack() { return this.winDevice.getShellStack(); }

  getPrompt(): string {
    return this.winDevice.getPromptString();
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

  // ── Command execution ───────────────────────────────────────────

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

    // Handle exit — delegates to device shell stack
    if (trimmed.toLowerCase() === 'exit') {
      if (!this.winDevice.exitCurrentShell()) {
        // No parent shell — close the terminal
        this._onRequestClose?.();
      } else {
        this._onShellModeChange?.(this.winDevice.getShellMode());
      }
      this.notify();
      return;
    }

    this.pushHistory(trimmed);
    // Share history with the device so PS Get-History works
    this.winDevice.setCommandHistory(this.history);

    const currentMode = this.winDevice.getShellMode();

    // Detect shell transitions (handled at session level for banner display)
    const lower = trimmed.toLowerCase();

    if (currentMode === 'cmd' && (lower === 'powershell' || lower === 'powershell.exe' || lower === 'pwsh' || lower === 'pwsh.exe')) {
      const banner = this.winDevice.enterPowerShell();
      const bannerLines = banner.split('\n');
      for (const line of bannerLines) {
        this.lines.push({ id: nextLineId(), text: line, type: 'ps-header' });
      }
      this._onShellModeChange?.('powershell');
      this.notify();
      return;
    }

    if (currentMode === 'powershell' && (lower === 'cmd' || lower === 'cmd.exe')) {
      const banner = this.winDevice.enterCmd();
      this.addMultiLine(banner);
      this._onShellModeChange?.('cmd');
      this.notify();
      return;
    }

    // cls / clear-host — handled at session level (screen clear)
    if (lower === 'cls' || (currentMode === 'powershell' && (lower === 'clear-host' || lower === 'clear'))) {
      this.lines = [];
      this.bannerCleared = true;
      this.notify();
      return;
    }

    // All other commands — delegate to device
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

  private addMultiLine(text: string, type: string = 'normal'): void {
    const lines = text.split('\n');
    for (const line of lines) {
      this.lines.push({ id: nextLineId(), text: line, type });
    }
    this.notify();
  }

  // ── Tab completion ──────────────────────────────────────────────

  protected onTab(): void {
    // PowerShell cmdlet completion (first word only)
    if (this.winDevice.getShellMode() === 'powershell') {
      const parts = this.input.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        const prefix = (parts[0] || '').toLowerCase();
        const matches = PS_CMDLETS_LIST.filter(c => c.toLowerCase().startsWith(prefix));
        const result = completeInputCaseInsensitive(this.input, matches, 20);
        this.input = result.input;
        this.tabSuggestions = result.suggestions;
        this.notify();
        return;
      }
    }

    // Fall back to device completions for file paths
    const completions = this.device.getCompletions(this.input);
    if (completions.length === 0) return;

    const result = completeInputCaseInsensitive(this.input, completions);
    this.input = result.input;
    this.tabSuggestions = result.suggestions;
    this.notify();
  }
}
