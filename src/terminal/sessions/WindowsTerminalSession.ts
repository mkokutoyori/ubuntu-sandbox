/**
 * WindowsTerminalSession — Windows CMD + PowerShell terminal model.
 *
 * Features:
 *   - Dual-mode: CMD and PowerShell
 *   - Shell nesting (PowerShell from CMD, CMD from PowerShell, exit to return)
 *   - PowerShell cmdlet execution via PowerShellExecutor
 *   - Tab completion (PS cmdlets + device file paths)
 */

import { Equipment } from '@/network';
import {
  TerminalSession, TerminalTheme, SessionType, KeyEvent, nextLineId,
} from './TerminalSession';
import { PowerShellExecutor, PS_BANNER, PS_CMDLETS_LIST } from '@/network/devices/windows/PowerShellExecutor';

interface ShellEntry {
  type: 'cmd' | 'powershell';
  cwd: string;
}

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
  shellMode: 'cmd' | 'powershell' = 'cmd';
  shellStack: ShellEntry[] = [];
  currentPrompt: string = 'C:\\Users\\User>';
  psCwd: string = 'C:\\Users\\User';
  bannerCleared: boolean = false;
  tabSuggestions: string[] | null = null;

  private psExecutor: PowerShellExecutor;
  private _onRequestClose?: () => void;
  private _onShellModeChange?: (mode: 'cmd' | 'powershell') => void;

  constructor(id: string, device: Equipment) {
    super(id, device);
    this.psExecutor = new PowerShellExecutor(device as any);
  }

  getSessionType(): SessionType { return 'windows'; }
  getTheme(): TerminalTheme { return WINDOWS_THEME; }

  getPrompt(): string {
    return this.shellMode === 'powershell'
      ? `PS ${this.psCwd}> `
      : this.currentPrompt;
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

    // Handle exit
    if (trimmed.toLowerCase() === 'exit') {
      if (!this.exitCurrentShell()) {
        this._onRequestClose?.();
      }
      return;
    }

    this.pushHistory(trimmed);

    if (this.shellMode === 'cmd') {
      await this.executeCmdCommand(trimmed);
    } else {
      await this.executePsCommand(trimmed);
    }
  }

  private async executeCmdCommand(trimmed: string): Promise<void> {
    const lower = trimmed.toLowerCase();

    // Detect PowerShell launch
    if (lower === 'powershell' || lower === 'powershell.exe' || lower === 'pwsh' || lower === 'pwsh.exe') {
      this.enterPowerShell();
      return;
    }

    // cls
    if (lower === 'cls') {
      this.lines = [];
      this.bannerCleared = true;
      await this.refreshPrompt();
      this.notify();
      return;
    }

    // Execute on device (with timeout + device-online guard)
    try {
      const result = await this.executeOnDevice(trimmed);
      if (result !== undefined && result !== null && result !== '') {
        this.addMultiLine(result);
      }
      if (lower.startsWith('cd ') || lower.startsWith('cd\\') || lower === 'cd' || lower.startsWith('chdir')) {
        await this.refreshPrompt();
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
  }

  private async executePsCommand(trimmed: string): Promise<void> {
    const lower = trimmed.toLowerCase();

    // Detect CMD launch from PS
    if (lower === 'cmd' || lower === 'cmd.exe') {
      this.shellStack.push({ type: 'powershell', cwd: this.currentPrompt });
      this.shellMode = 'cmd';
      this._onShellModeChange?.('cmd');
      this.addMultiLine('Microsoft Windows [Version 10.0.22631.6649]\n(c) Microsoft Corporation. All rights reserved.');
      this.notify();
      return;
    }

    // Clear-Host / cls / clear
    if (lower === 'clear-host' || lower === 'cls' || lower === 'clear') {
      this.lines = [];
      this.bannerCleared = true;
      this.notify();
      return;
    }

    // Execute PowerShell cmdlet
    this.psExecutor.setCwd(this.psCwd);
    this.psExecutor.setHistory(this.history);
    const result = await this.psExecutor.execute(trimmed);
    const newCwd = this.psExecutor.getCwd();
    if (newCwd !== this.psCwd) {
      this.psCwd = newCwd;
      this.currentPrompt = newCwd + '>';
    }

    if (result !== null && result !== undefined && result !== '') {
      this.addMultiLine(result);
    }

    // Update PS cwd after location changes
    if (lower.startsWith('set-location') || lower.startsWith('sl ') || lower.startsWith('cd ') || lower === 'cd') {
      try {
        const cdResult = await this.executeOnDevice('cd');
        if (cdResult && !cdResult.includes('not recognized')) {
          this.psCwd = cdResult.trim();
          this.currentPrompt = cdResult.trim() + '>';
        }
      } catch { /* ignore — cwd refresh is best-effort */ }
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

  // ── Shell nesting ───────────────────────────────────────────────

  private enterPowerShell(): void {
    this.shellStack.push({ type: this.shellMode, cwd: this.currentPrompt });
    this.shellMode = 'powershell';
    this._onShellModeChange?.('powershell');
    const bannerLines = PS_BANNER.split('\n');
    for (const line of bannerLines) {
      this.lines.push({ id: nextLineId(), text: line, type: 'ps-header' });
    }
    this.notify();
  }

  private exitCurrentShell(): boolean {
    if (this.shellStack.length > 0) {
      const prev = this.shellStack.pop()!;
      this.shellMode = prev.type;
      this.currentPrompt = prev.cwd;
      this._onShellModeChange?.(prev.type);
      this.notify();
      return true;
    }
    return false;
  }

  // ── Prompt refresh ──────────────────────────────────────────────

  private async refreshPrompt(): Promise<void> {
    try {
      const cdResult = await this.executeOnDevice('cd');
      if (cdResult && !cdResult.includes('not recognized')) {
        const cwd = cdResult.trim();
        this.currentPrompt = cwd + '>';
        this.psCwd = cwd;
      }
    } catch { /* ignore — prompt refresh is best-effort */ }
    this.notify();
  }

  // ── Tab completion ──────────────────────────────────────────────

  protected onTab(): void {
    if (this.shellMode === 'powershell') {
      const parts = this.input.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        const prefix = (parts[0] || '').toLowerCase();
        const matches = PS_CMDLETS_LIST.filter(c => c.toLowerCase().startsWith(prefix));
        if (matches.length === 1) {
          this.input = matches[0] + ' ';
          this.tabSuggestions = null;
        } else if (matches.length > 1) {
          this.tabSuggestions = matches.slice(0, 20);
        }
        this.notify();
        return;
      }
    }

    // Fall back to device completions for file paths
    if (!('getCompletions' in this.device)) return;
    const completions: string[] = (this.device as any).getCompletions(this.input);
    if (completions.length === 0) return;

    if (completions.length === 1) {
      const parts = this.input.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        this.input = completions[0] + ' ';
      } else {
        const lastArg = parts[parts.length - 1];
        const lastSep = lastArg.lastIndexOf('\\');
        if (lastSep >= 0) {
          parts[parts.length - 1] = lastArg.substring(0, lastSep + 1) + completions[0];
        } else {
          parts[parts.length - 1] = completions[0];
        }
        this.input = parts.join(' ');
      }
      this.tabSuggestions = null;
    } else {
      let common = completions[0];
      for (let i = 1; i < completions.length; i++) {
        while (common && !completions[i].toLowerCase().startsWith(common.toLowerCase())) {
          common = common.slice(0, -1);
        }
      }
      const parts = this.input.trimStart().split(/\s+/);
      const word = parts[parts.length - 1] || '';
      if (common.length > word.length) {
        if (parts.length <= 1) this.input = common;
        else { parts[parts.length - 1] = common; this.input = parts.join(' '); }
        this.tabSuggestions = null;
      } else {
        this.tabSuggestions = completions;
      }
    }
    this.notify();
  }
}
