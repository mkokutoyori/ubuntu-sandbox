/**
 * CLITerminalSession — Abstract base for vendor CLI terminals (Cisco IOS, Huawei VRP).
 *
 * Shared features:
 *   - Boot sequence with line-by-line animation
 *   - --More-- / ---- More ---- pager
 *   - Inline ? help (intercepted on keypress)
 *   - Tab completion via device.cliTabComplete()
 *   - Ctrl+Z (exit to top-level mode)
 *   - Ctrl+W (delete word backward)
 *   - Ctrl+A/E (cursor movement)
 *   - Dynamic prompt from device.getPrompt()
 */

import { Equipment } from '@/network';
import {
  TerminalSession, TerminalTheme, SessionType,
  KeyEvent, InputMode,
} from './TerminalSession';

const PAGE_SIZE = 24;

export abstract class CLITerminalSession extends TerminalSession {
  isBooting: boolean = true;
  prompt: string = '';

  // Pager state
  pagerLines: string[] | null = null;
  pagerOffset: number = 0;

  constructor(id: string, device: Equipment) {
    super(id, device);
  }

  // ── Prompt ──────────────────────────────────────────────────────

  updatePrompt(): void {
    if ('getPrompt' in this.device && typeof (this.device as any).getPrompt === 'function') {
      this.prompt = (this.device as any).getPrompt();
    } else {
      this.prompt = this.getDefaultPrompt();
    }
    this.notify();
  }

  getPrompt(): string { return this.prompt; }

  protected abstract getDefaultPrompt(): string;

  /** The vendor-specific "go to top-level" command (Cisco: 'end', Huawei: 'return') */
  protected abstract getCtrlZCommand(): string;

  /** The pager indicator text */
  protected abstract getPagerIndicator(): string;

  // ── Boot sequence ───────────────────────────────────────────────

  async init(): Promise<void> {
    this.isBooting = true;
    this.inputMode = { type: 'booting' };
    this.notify();

    let bootText = '';
    if ('getBootSequence' in this.device && typeof (this.device as any).getBootSequence === 'function') {
      bootText = (this.device as any).getBootSequence();
    }

    if (bootText) {
      const lines = bootText.split('\n');
      for (const line of lines) {
        await new Promise(r => setTimeout(r, 12));
        this.addLine(line, 'boot');
      }
    } else {
      const fallback = this.getFallbackBootLines();
      for (const line of fallback) {
        await new Promise(r => setTimeout(r, 15));
        this.addLine(line, 'boot');
      }
    }

    // Show MOTD banner if available
    if ('getBanner' in this.device && typeof (this.device as any).getBanner === 'function') {
      const motd = (this.device as any).getBanner('motd');
      if (motd) {
        this.addLine('');
        this.addLine(motd);
      }
    }

    this.addLine('');
    this.isBooting = false;
    this.inputMode = { type: 'normal' };
    this.updatePrompt();
  }

  /** Fallback boot lines if device doesn't provide getBootSequence(). */
  protected abstract getFallbackBootLines(): string[];

  // ── Close callback ─────────────────────────────────────────────

  private _onRequestClose?: () => void;
  onRequestClose(cb: () => void): void { this._onRequestClose = cb; }

  // ── Key handling ────────────────────────────────────────────────

  protected handleModeKey(e: KeyEvent): boolean {
    // Pager mode
    if (this.pagerLines) {
      if (e.key === ' ') { this.pagerNextPage(); return true; }
      if (e.key === 'Enter') { this.pagerNextLine(); return true; }
      if (e.key === 'q' || e.key === 'Q' || (e.key === 'c' && e.ctrlKey)) {
        this.pagerQuit();
        return true;
      }
      return true; // consume all keys in pager mode
    }
    return false;
  }

  protected handleNormalKey(e: KeyEvent): boolean {
    // ? (inline help — intercepted before reaching input)
    if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      this.showInlineHelp(this.input);
      return true;
    }

    // Ctrl+Z → go to top-level mode
    if (e.key === 'z' && e.ctrlKey) {
      this.addLine(`${this.prompt}${this.input}^Z`);
      this.input = '';
      this.executeOnDevice(this.getCtrlZCommand())
        .then(() => this.updatePrompt())
        .catch((err) => {
          if (err instanceof Error && err.name === 'DeviceOfflineError') {
            this.addLine('% Device is powered off', 'error');
          } else {
            this.addLine(`% Error: ${err}`, 'error');
          }
        });
      this.notify();
      return true;
    }

    // Ctrl+W → delete word backward
    if (e.key === 'w' && e.ctrlKey) {
      const pos = this.input.length;
      let i = pos - 1;
      while (i >= 0 && this.input[i] === ' ') i--;
      while (i >= 0 && this.input[i] !== ' ') i--;
      this.input = this.input.slice(0, i + 1);
      this.notify();
      return true;
    }

    // Ctrl+A/E → cursor (handled by view, but consume)
    if ((e.key === 'a' || e.key === 'e') && e.ctrlKey) return true;

    return super.handleNormalKey(e);
  }

  // ── Command execution ───────────────────────────────────────────

  protected onEnter(): void {
    const cmd = this.input;
    this.input = '';
    this.recordEvent('input', cmd);
    this.executeCommand(cmd);
    this.notify();
  }

  private async executeCommand(cmd: string): Promise<void> {
    const trimmed = cmd.trim();
    this.addLine(`${this.prompt}${cmd}`);

    if (trimmed) {
      this.pushHistory(trimmed);
    }

    try {
      const result = await this.executeOnDevice(trimmed);

      if (result === 'Connection closed.') {
        this._onRequestClose?.();
        return;
      }

      if (result) {
        const lines = result.split('\n');
        if (lines.length > PAGE_SIZE) {
          this.startPager(lines);
        } else {
          this.addLine(result);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'DeviceOfflineError') {
        this.addLine('% Device is powered off — session disconnected', 'error');
        return;
      }
      if (err instanceof Error && err.name === 'CommandTimeoutError') {
        this.addLine('% Command execution timed out', 'error');
      } else {
        this.addLine(`% Error: ${err}`, 'error');
      }
    }

    this.updatePrompt();
  }

  // ── Tab completion ──────────────────────────────────────────────

  protected onTab(): void {
    if ('cliTabComplete' in this.device && typeof (this.device as any).cliTabComplete === 'function') {
      const completed = (this.device as any).cliTabComplete(this.input);
      if (completed) {
        this.input = completed;
        this.notify();
      }
    }
  }

  // ── Inline help ─────────────────────────────────────────────────

  private showInlineHelp(currentInput: string): void {
    this.addLine(`${this.prompt}${currentInput}?`);

    let helpText = '';
    if ('cliHelp' in this.device && typeof (this.device as any).cliHelp === 'function') {
      helpText = (this.device as any).cliHelp(currentInput);
    } else {
      helpText = '% Help not available';
    }

    if (helpText) this.addLine(helpText);
    // Input is NOT cleared — user continues typing
  }

  // ── Pager ───────────────────────────────────────────────────────

  private startPager(allLines: string[]): void {
    const firstPage = allLines.slice(0, PAGE_SIZE);
    this.addLines(firstPage);

    if (allLines.length > PAGE_SIZE) {
      this.pagerLines = allLines;
      this.pagerOffset = PAGE_SIZE;
      this.inputMode = { type: 'pager', indicator: this.getPagerIndicator() };
      this.notify();
    }
  }

  private pagerNextPage(): void {
    if (!this.pagerLines) return;
    const next = this.pagerLines.slice(this.pagerOffset, this.pagerOffset + PAGE_SIZE);
    this.addLines(next);
    if (this.pagerOffset + PAGE_SIZE >= this.pagerLines.length) {
      this.pagerQuit();
    } else {
      this.pagerOffset += PAGE_SIZE;
      this.notify();
    }
  }

  private pagerNextLine(): void {
    if (!this.pagerLines) return;
    if (this.pagerOffset < this.pagerLines.length) {
      this.addLine(this.pagerLines[this.pagerOffset]);
      if (this.pagerOffset + 1 >= this.pagerLines.length) {
        this.pagerQuit();
      } else {
        this.pagerOffset++;
        this.notify();
      }
    }
  }

  private pagerQuit(): void {
    this.pagerLines = null;
    this.pagerOffset = 0;
    this.inputMode = { type: 'normal' };
    this.notify();
  }
}
