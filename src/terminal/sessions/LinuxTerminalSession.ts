/**
 * LinuxTerminalSession — Ubuntu terminal emulation model.
 *
 * Features ported from the original Terminal.tsx:
 *   - Interactive multi-step prompts (sudo, su, passwd, adduser)
 *   - ANSI color support (handled in the view via AnsiRenderer)
 *   - Text editors (nano, vi, vim) via EditorOverlay
 *   - Colored prompt (user@host:path$)
 *   - Tab completion
 */

import { Equipment } from '@/network';
import {
  TerminalSession, TerminalTheme, SessionType,
  KeyEvent, InputMode, nextLineId,
} from './TerminalSession';
import type { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import { createSQLPlusSession, getOracleDatabase, initOracleFilesystem } from '@/terminal/commands/database';

// ─── Interactive prompt types ─────────────────────────────────────

type InteractiveStep =
  | { type: 'password'; prompt: string }
  | { type: 'output'; text: string }
  | { type: 'execute'; command: string }
  | { type: 'set-password'; username: string }
  | { type: 'adduser-info'; command: string }
  | { type: 'input'; prompt: string; field: string }
  | { type: 'set-gecos'; username: string }
  | { type: 'confirm'; prompt: string };

interface InteractiveState {
  steps: InteractiveStep[];
  stepIndex: number;
  originalCommand: string;
  collectedPassword?: string;
  targetUser?: string;
  attemptsLeft: number;
  currentPromptText: string;
  gecosFields?: { fullName: string; room: string; workPhone: string; homePhone: string; other: string };
}

// ─── Theme ────────────────────────────────────────────────────────

const LINUX_THEME: TerminalTheme = {
  sessionType: 'linux',
  backgroundColor: '#300a24',
  textColor: '#ffffff',
  errorColor: '#ef2929',
  promptColor: '#8ae234',
  fontFamily: "'Ubuntu Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'Monaco', monospace",
  infoBarBg: '#2c0a1f',
  infoBarText: '#c0a0b0',
  infoBarBorder: '#5c3d50',
};

// ─── Session ──────────────────────────────────────────────────────

export class LinuxTerminalSession extends TerminalSession {
  currentPath: string;
  currentUser: string;
  private interactive: InteractiveState | null = null;
  private passwordBuf: string = '';
  private inputBuf: string = '';
  /** Tab suggestions currently shown (null = hidden) */
  tabSuggestions: string[] | null = null;
  /** Active SQL*Plus sub-shell session (null when not in sqlplus mode) */
  private sqlPlusSession: SQLPlusSession | null = null;
  /** Prompt text for the active SQL*Plus session */
  private sqlPlusPrompt: string = 'SQL> ';

  constructor(id: string, device: Equipment) {
    super(id, device);
    this.currentPath = device.getCwd() || '/home/user';
    this.currentUser = device.getCurrentUser() || 'user';
  }

  // ── Template implementations ────────────────────────────────────

  getSessionType(): SessionType { return 'linux'; }
  getTheme(): TerminalTheme { return LINUX_THEME; }

  getPrompt(): string {
    const hostname = this.device.getHostname() || 'localhost';
    const user = this.currentUser;
    const homeDir = user === 'root' ? '/root' : `/home/${user}`;
    let path = this.currentPath;
    if (path === homeDir) path = '~';
    else if (path.startsWith(homeDir + '/')) path = '~' + path.slice(homeDir.length);
    const promptChar = user === 'root' ? '#' : '$';
    return `${user}@${hostname}:${path}${promptChar} `;
  }

  /** Structured prompt parts for the colored prompt renderer. */
  getPromptParts() {
    const hostname = this.device.getHostname() || 'localhost';
    const user = this.currentUser;
    const homeDir = user === 'root' ? '/root' : `/home/${user}`;
    let path = this.currentPath;
    if (path === homeDir) path = '~';
    else if (path.startsWith(homeDir + '/')) path = '~' + path.slice(homeDir.length);
    const promptChar = user === 'root' ? '#' : '$';
    return { user, hostname, path, promptChar };
  }

  getInfoBarContent() {
    const p = this.getPromptParts();
    return { left: `${p.user}@${p.hostname}: ${p.path}` };
  }

  async init(): Promise<void> {
    // Linux terminal has no boot sequence — ready immediately
  }

  // ── Input mode ──────────────────────────────────────────────────

  get currentInputMode(): InputMode {
    if (this.sqlPlusSession) {
      return { type: 'interactive-text', promptText: this.sqlPlusPrompt };
    }
    if (this.interactive) {
      const step = this.interactive.steps[this.interactive.stepIndex];
      if (!step) return { type: 'normal' };
      if (step.type === 'password') return { type: 'password', promptText: step.prompt };
      if (step.type === 'input' || step.type === 'confirm') return { type: 'interactive-text', promptText: step.prompt };
    }
    return this.inputMode;
  }

  // ── Key handling ────────────────────────────────────────────────

  handleKey(e: KeyEvent): boolean {
    if (this.disposed) return false;

    // SQL*Plus sub-shell mode — route to interactive text handler
    if (this.sqlPlusSession) {
      return this.handleSqlPlusKey(e);
    }

    // Password mode
    if (this.interactive) {
      const step = this.interactive.steps[this.interactive.stepIndex];
      if (step?.type === 'password') return this.handlePasswordKey(e);
      if (step?.type === 'input' || step?.type === 'confirm') return this.handleInteractiveTextKey(e);
    }

    // Editor mode is handled by the view component (NanoEditor / VimEditor)
    if (this.inputMode.type === 'editor') return false;

    return super.handleKey(e);
  }

  protected handleModeKey(_e: KeyEvent): boolean {
    // All mode handling is done in the overridden handleKey above
    return false;
  }

  protected handleNormalKey(e: KeyEvent): boolean {
    // Ctrl+A → beginning of line (handled by view's input element, but consume)
    if (e.key === 'a' && e.ctrlKey) return true;
    // Ctrl+E → end of line
    if (e.key === 'e' && e.ctrlKey) return true;

    // Tab
    if (e.key === 'Tab') {
      this.onTab();
      return true;
    }

    // Clear tab suggestions on any non-Tab key
    if (this.tabSuggestions && e.key !== 'Tab') {
      this.tabSuggestions = null;
      this.notify();
    }

    return super.handleNormalKey(e);
  }

  // ── Password mode keys ─────────────────────────────────────────

  private handlePasswordKey(e: KeyEvent): boolean {
    if (e.key === 'Enter') {
      const pw = this.passwordBuf;
      this.passwordBuf = '';
      this.handlePasswordSubmit(pw);
      return true;
    }
    if (e.key === 'c' && e.ctrlKey) {
      this.interactive = null;
      this.passwordBuf = '';
      this.addLine('^C');
      this.inputMode = { type: 'normal' };
      this.notify();
      return true;
    }
    // All other keys are captured by the hidden password input in the view
    return false;
  }

  /** Called by the view's hidden password <input> onChange */
  setPasswordBuf(value: string): void {
    this.passwordBuf = value;
    this.notify();
  }

  // ── Interactive text mode keys ──────────────────────────────────

  private handleInteractiveTextKey(e: KeyEvent): boolean {
    if (e.key === 'Enter') {
      const val = this.inputBuf;
      this.inputBuf = '';
      this.handleInputSubmit(val);
      return true;
    }
    if (e.key === 'c' && e.ctrlKey) {
      this.interactive = null;
      this.inputBuf = '';
      this.inputMode = { type: 'normal' };
      this.addLine('^C');
      return true;
    }
    return false;
  }

  /** Called by the view's interactive text <input> onChange */
  setInputBuf(value: string): void {
    this.inputBuf = value;
    this.notify();
  }

  getInputBuf(): string { return this.inputBuf; }
  getPasswordBuf(): string { return this.passwordBuf; }

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

    // Echo command with prompt
    this.addLine(`${this.getPrompt()}${cmd}`);

    // Handle exit/logout
    if (trimmed === 'exit' || trimmed === 'logout') {
      const exitResult = this.device.handleExit();
      if (exitResult.inSu) {
        if (exitResult.output) this.addLine(exitResult.output);
        this.syncDeviceState();
        return;
      }
      // Signal close — the view/manager will handle it
      this._onRequestClose?.();
      return;
    }

    // Add to history
    this.pushHistory(trimmed);

    // Intercept editor commands
    {
      const noSudo = trimmed.startsWith('sudo ') ? trimmed.slice(5).trim() : trimmed;
      const parts = noSudo.split(/\s+/);
      const editorCmd = parts[0];
      if (editorCmd === 'nano' || editorCmd === 'vi' || editorCmd === 'vim') {
        this.openEditor(editorCmd as 'nano' | 'vi' | 'vim', parts.slice(1));
        return;
      }
    }

    // Intercept sqlplus command — enter SQL*Plus sub-shell (only if no sudo prefix)
    {
      const noSudo = trimmed.startsWith('sudo ') ? trimmed.slice(5).trim() : trimmed;
      const parts = noSudo.split(/\s+/);
      if (parts[0] === 'sqlplus' && !trimmed.startsWith('sudo ')) {
        this.enterSqlPlus(parts.slice(1));
        return;
      }
      // Intercept lsnrctl — Oracle listener control
      if (parts[0] === 'lsnrctl' && !trimmed.startsWith('sudo ')) {
        this.handleLsnrctl(parts.slice(1));
        return;
      }
      // Intercept tnsping — Oracle TNS connectivity test
      if (parts[0] === 'tnsping' && !trimmed.startsWith('sudo ')) {
        this.handleTnsping(parts.slice(1));
        return;
      }
    }

    // Check if this command needs interactive prompts
    // (handles sudo password for `sudo sqlplus`, sudo passwd, su, etc.)
    const interactiveState = this.buildInteractiveSteps(trimmed);
    if (interactiveState) {
      this.interactive = interactiveState;
      this.passwordBuf = '';
      this.processInteractiveSteps(interactiveState);
      return;
    }

    // Execute directly (with timeout + device-online guard)
    try {
      const result = await this.executeOnDevice(trimmed);
      if (result) {
        if (result.includes('\x1b[2J') || result.includes('\x1b[H')) {
          this.clear();
        } else {
          this.addLine(result);
        }
      }
      this.syncDeviceState();
    } catch (err) {
      if (err instanceof Error && err.name === 'DeviceOfflineError') {
        this.addLine(`\x1b[31mConnection lost: device is powered off\x1b[0m`, 'error');
        this.inputMode = { type: 'normal' };
      } else if (err instanceof Error && err.name === 'CommandTimeoutError') {
        this.addLine(`\x1b[31mCommand timed out\x1b[0m`, 'error');
      } else {
        this.addLine(`Error: ${err}`, 'error');
      }
    }
  }

  // ── Tab completion ──────────────────────────────────────────────

  protected onTab(): void {
    const completions = this.device.getCompletions(this.input);
    if (completions.length === 0) return;

    if (completions.length === 1) {
      const parts = this.input.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        this.input = completions[0] + ' ';
      } else {
        parts[parts.length - 1] = completions[0];
        this.input = parts.slice(0, -1).join(' ') + ' ' + completions[0];
      }
      this.tabSuggestions = null;
    } else {
      const parts = this.input.trimStart().split(/\s+/);
      const word = parts[parts.length - 1] || '';
      let common = completions[0];
      for (let i = 1; i < completions.length; i++) {
        while (!completions[i].startsWith(common)) common = common.slice(0, -1);
      }
      if (common.length > word.length) {
        if (parts.length <= 1) {
          this.input = common;
        } else {
          parts[parts.length - 1] = common;
          this.input = parts.slice(0, -1).join(' ') + ' ' + common;
        }
        this.tabSuggestions = null;
      } else {
        this.tabSuggestions = completions;
      }
    }
    this.notify();
  }

  // ── Editor integration ──────────────────────────────────────────

  private openEditor(editorCmd: 'nano' | 'vi' | 'vim', args: string[]): void {
    let filePath = '';
    for (const arg of args) {
      if (!arg.startsWith('-') && !arg.startsWith('+')) { filePath = arg; break; }
    }
    if (!filePath) filePath = editorCmd === 'nano' ? 'New Buffer' : '';

    const absolutePath = this.device.resolveAbsolutePath(filePath);
    const existingContent = this.device.readFileForEditor(absolutePath);
    const isNewFile = existingContent === null;

    this.inputMode = {
      type: 'editor',
      editorType: editorCmd,
      filePath: absolutePath,
      absolutePath,
      content: existingContent ?? '',
      isNewFile,
    };
    this.notify();
  }

  /** Called by the view when editor saves a file. */
  editorSave(content: string, filePath: string): void {
    this.device.writeFileFromEditor(filePath, content);
  }

  /** Called by the view when editor exits. */
  editorExit(): void {
    this.inputMode = { type: 'normal' };
    this.notify();
  }

  // ── Device state sync ───────────────────────────────────────────

  private syncDeviceState(): void {
    const cwd = this.device.getCwd();
    if (cwd) this.currentPath = cwd;
    this.currentUser = this.device.getCurrentUser();
    this.notify();
  }

  // ── Close callback ─────────────────────────────────────────────

  private _onRequestClose?: () => void;
  onRequestClose(cb: () => void): void { this._onRequestClose = cb; }

  // ── Interactive prompt builder ──────────────────────────────────

  private buildInteractiveSteps(command: string): InteractiveState | null {
    const trimmed = command.trim();
    const parts = trimmed.split(/\s+/);
    const currentUser = this.device.getCurrentUser();
    const currentUid = this.device.getCurrentUid();
    const isRoot = currentUid === 0;

    // BUG FIX: Check if user can use sudo before proceeding
    if (parts[0] === 'sudo' && !isRoot) {
      if (!this.device.canSudo()) {
        return null; // Will be handled by executeOnDevice which returns the error
      }

      const subParts = parts.slice(1);
      const subCmd = subParts[0];

      // sudo with no sub-command or sudo -l → no interactive steps, let executor handle
      if (!subCmd || subCmd === '-l') {
        return null;
      }

      // Handle sudo passwd with flags (-l, -u, -S) — no interactive password needed for these
      if (subCmd === 'passwd' && subParts.length >= 2 && subParts[1].startsWith('-')) {
        return {
          steps: [
            { type: 'password', prompt: `[sudo] password for ${currentUser}:` },
            { type: 'execute', command: trimmed },
          ],
          stepIndex: 0, originalCommand: trimmed, attemptsLeft: 3,
          currentPromptText: `[sudo] password for ${currentUser}:`,
        };
      }

      if (subCmd === 'passwd' && subParts.length >= 2 && !subParts[1].startsWith('-')) {
        const targetUser = subParts[subParts.length - 1];
        return {
          steps: [
            { type: 'password', prompt: `[sudo] password for ${currentUser}:` },
            { type: 'password', prompt: 'New password:' },
            { type: 'password', prompt: 'Retype new password:' },
            { type: 'set-password', username: targetUser },
            { type: 'output', text: 'passwd: password updated successfully' },
          ],
          stepIndex: 0, originalCommand: trimmed, attemptsLeft: 3,
          currentPromptText: `[sudo] password for ${currentUser}:`,
        };
      }

      if (subCmd === 'adduser' && subParts.length >= 2) {
        // BUG FIX: Skip 'adduser' itself and option values when finding the target username
        const targetUser = subParts.slice(1).filter(a => !a.startsWith('-') && a !== '--gecos' && a !== '--disabled-password' && a !== '--disabled-login')[0];
        const hasDisabledPassword = subParts.includes('--disabled-password') || subParts.includes('--disabled-login');
        const hasGecos = subParts.indexOf('--gecos') >= 0;

        if (hasDisabledPassword && hasGecos) {
          return {
            steps: [
              { type: 'password', prompt: `[sudo] password for ${currentUser}:` },
              { type: 'adduser-info', command: trimmed },
            ],
            stepIndex: 0, originalCommand: trimmed, attemptsLeft: 3,
            currentPromptText: `[sudo] password for ${currentUser}:`,
            targetUser,
          };
        }

        const passwordSteps: InteractiveStep[] = hasDisabledPassword ? [] : [
          { type: 'password', prompt: 'New password:' },
          { type: 'password', prompt: 'Retype new password:' },
          { type: 'set-password', username: targetUser },
          { type: 'output', text: 'passwd: password updated successfully' },
        ];
        const chfnSteps: InteractiveStep[] = hasGecos ? [] : [
          { type: 'output', text: `Changing the user information for ${targetUser}` },
          { type: 'output', text: 'Enter the new value, or press ENTER for the default' },
          { type: 'input', prompt: '\tFull Name []: ', field: 'fullName' },
          { type: 'input', prompt: '\tRoom Number []: ', field: 'room' },
          { type: 'input', prompt: '\tWork Phone []: ', field: 'workPhone' },
          { type: 'input', prompt: '\tHome Phone []: ', field: 'homePhone' },
          { type: 'input', prompt: '\tOther []: ', field: 'other' },
          { type: 'confirm', prompt: 'Is the information correct? [Y/n] ' },
          { type: 'set-gecos', username: targetUser },
        ];

        return {
          steps: [
            { type: 'password', prompt: `[sudo] password for ${currentUser}:` },
            { type: 'adduser-info', command: trimmed },
            ...passwordSteps,
            ...chfnSteps,
          ],
          stepIndex: 0, originalCommand: trimmed, attemptsLeft: 3,
          currentPromptText: `[sudo] password for ${currentUser}:`,
          targetUser,
          gecosFields: { fullName: '', room: '', workPhone: '', homePhone: '', other: '' },
        };
      }

      if (subCmd === 'su') {
        return {
          steps: [
            { type: 'password', prompt: `[sudo] password for ${currentUser}:` },
            { type: 'execute', command: trimmed },
          ],
          stepIndex: 0, originalCommand: trimmed, attemptsLeft: 3,
          currentPromptText: `[sudo] password for ${currentUser}:`,
        };
      }

      return {
        steps: [
          { type: 'password', prompt: `[sudo] password for ${currentUser}:` },
          { type: 'execute', command: trimmed },
        ],
        stepIndex: 0, originalCommand: trimmed, attemptsLeft: 3,
        currentPromptText: `[sudo] password for ${currentUser}:`,
      };
    }

    // BUG FIX: su should allow 3 password attempts (like real Linux)
    if (parts[0] === 'su' && !isRoot) {
      let targetUser = 'root';
      for (const p of parts.slice(1)) {
        if (p !== '-' && p !== '-l' && p !== '--login' && !p.startsWith('-')) targetUser = p;
      }
      return {
        steps: [
          { type: 'password', prompt: 'Password:' },
          { type: 'execute', command: trimmed },
        ],
        stepIndex: 0, originalCommand: trimmed, targetUser, attemptsLeft: 3,
        currentPromptText: 'Password:',
      };
    }

    // passwd (no args) — change own password
    if (parts[0] === 'passwd' && parts.length === 1) {
      if (isRoot) {
        // BUG FIX: Root can change own password without entering current password
        return {
          steps: [
            { type: 'password', prompt: 'New password:' },
            { type: 'password', prompt: 'Retype new password:' },
            { type: 'set-password', username: currentUser },
            { type: 'output', text: 'passwd: password updated successfully' },
          ],
          stepIndex: 0, originalCommand: trimmed, attemptsLeft: 3,
          currentPromptText: '',
        };
      }
      return {
        steps: [
          { type: 'output', text: `Changing password for ${currentUser}.` },
          { type: 'password', prompt: 'Current password:' },
          { type: 'password', prompt: 'New password:' },
          { type: 'password', prompt: 'Retype new password:' },
          { type: 'set-password', username: currentUser },
          { type: 'output', text: 'passwd: password updated successfully' },
        ],
        stepIndex: 0, originalCommand: trimmed, attemptsLeft: 3,
        currentPromptText: '',
      };
    }

    // passwd <username> as root — change another user's password without current password
    if (parts[0] === 'passwd' && parts.length >= 2 && !parts[1].startsWith('-') && isRoot) {
      const targetUser = parts[parts.length - 1];
      return {
        steps: [
          { type: 'password', prompt: 'New password:' },
          { type: 'password', prompt: 'Retype new password:' },
          { type: 'set-password', username: targetUser },
          { type: 'output', text: 'passwd: password updated successfully' },
        ],
        stepIndex: 0, originalCommand: trimmed, attemptsLeft: 3,
        currentPromptText: '',
      };
    }

    // adduser <username> as root (without sudo) — needs password + GECOS prompts
    if (parts[0] === 'adduser' && parts.length >= 2 && isRoot) {
      const targetUser = parts.slice(1).filter(a => !a.startsWith('-') && a !== '--gecos' && a !== '--disabled-password' && a !== '--disabled-login')[0];
      const hasDisabledPassword = parts.includes('--disabled-password') || parts.includes('--disabled-login');
      const hasGecos = parts.indexOf('--gecos') >= 0;

      if (hasDisabledPassword && hasGecos) {
        // No interactive steps needed — just execute
        return null;
      }

      const passwordSteps: InteractiveStep[] = hasDisabledPassword ? [] : [
        { type: 'password', prompt: 'New password:' },
        { type: 'password', prompt: 'Retype new password:' },
        { type: 'set-password', username: targetUser },
        { type: 'output', text: 'passwd: password updated successfully' },
      ];
      const chfnSteps: InteractiveStep[] = hasGecos ? [] : [
        { type: 'output', text: `Changing the user information for ${targetUser}` },
        { type: 'output', text: 'Enter the new value, or press ENTER for the default' },
        { type: 'input', prompt: '\tFull Name []: ', field: 'fullName' },
        { type: 'input', prompt: '\tRoom Number []: ', field: 'room' },
        { type: 'input', prompt: '\tWork Phone []: ', field: 'workPhone' },
        { type: 'input', prompt: '\tHome Phone []: ', field: 'homePhone' },
        { type: 'input', prompt: '\tOther []: ', field: 'other' },
        { type: 'confirm', prompt: 'Is the information correct? [Y/n] ' },
        { type: 'set-gecos', username: targetUser },
      ];

      return {
        steps: [
          { type: 'adduser-info', command: trimmed },
          ...passwordSteps,
          ...chfnSteps,
        ],
        stepIndex: 0, originalCommand: trimmed, attemptsLeft: 3,
        currentPromptText: '',
        targetUser,
        gecosFields: { fullName: '', room: '', workPhone: '', homePhone: '', other: '' },
      };
    }

    return null;
  }

  // ── Interactive step processing ─────────────────────────────────

  private async processInteractiveSteps(state: InteractiveState): Promise<void> {
    let idx = state.stepIndex;
    while (idx < state.steps.length) {
      const step = state.steps[idx];

      if (step.type === 'password') {
        this.interactive = { ...state, stepIndex: idx, currentPromptText: step.prompt };
        this.inputMode = { type: 'password', promptText: step.prompt };
        this.addLine(step.prompt);
        return;
      }
      if (step.type === 'output') { this.addLine(step.text); idx++; continue; }
      if (step.type === 'execute') {
        // Check if the command is `sudo sqlplus ...` — enter SQL*Plus sub-shell after sudo auth
        const cmdForExec = step.command;
        const noSudo = cmdForExec.startsWith('sudo ') ? cmdForExec.slice(5).trim() : cmdForExec;
        const execParts = noSudo.split(/\s+/);
        if (execParts[0] === 'sqlplus') {
          this.interactive = null;
          this.passwordBuf = '';
          this.inputBuf = '';
          this.inputMode = { type: 'normal' };
          this.enterSqlPlus(execParts.slice(1));
          return;
        }

        try {
          const result = await this.executeOnDevice(step.command);
          if (result) {
            if (result.includes('\x1b[2J') || result.includes('\x1b[H')) this.clear();
            else this.addLine(result);
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'DeviceOfflineError') {
            this.addLine('Connection lost: device is powered off', 'error');
            this.interactive = null; this.inputMode = { type: 'normal' }; this.notify(); return;
          }
          this.addLine(`Error: ${err}`, 'error');
        }
        this.syncDeviceState();
        idx++; continue;
      }
      if (step.type === 'set-password') {
        if (state.collectedPassword) this.device.setUserPassword(step.username, state.collectedPassword);
        idx++; continue;
      }
      if (step.type === 'adduser-info') {
        try {
          const result = await this.executeOnDevice(step.command);
          if (result) this.addLine(result);
        } catch (err) {
          if (err instanceof Error && err.name === 'DeviceOfflineError') {
            this.addLine('Connection lost: device is powered off', 'error');
            this.interactive = null; this.inputMode = { type: 'normal' }; this.notify(); return;
          }
          this.addLine(`Error: ${err}`, 'error');
        }
        idx++; continue;
      }
      if (step.type === 'input' || step.type === 'confirm') {
        this.interactive = { ...state, stepIndex: idx, currentPromptText: step.prompt };
        this.inputMode = { type: 'interactive-text', promptText: step.prompt };
        // Prompt text is displayed by the interactive-text input's prefix in the UI
        return;
      }
      if (step.type === 'set-gecos') {
        if (state.gecosFields && 'setUserGecos' in this.device) {
          const g = state.gecosFields;
          (this.device as any).setUserGecos(step.username, g.fullName, g.room, g.workPhone, g.homePhone, g.other);
        }
        idx++; continue;
      }
      idx++;
    }

    // All steps done
    this.syncDeviceState();
    this.interactive = null;
    this.passwordBuf = '';
    this.inputBuf = '';
    this.inputMode = { type: 'normal' };
    this.notify();
  }

  private handlePasswordSubmit(password: string): void {
    if (!this.interactive) return;
    const step = this.interactive.steps[this.interactive.stepIndex] as { type: 'password'; prompt: string };

    const isSudoPrompt = step.prompt.startsWith('[sudo]');
    const isSuPrompt = step.prompt === 'Password:' && this.interactive.originalCommand.startsWith('su');
    const isCurrentPassword = step.prompt === 'Current password:';
    const isNewPassword = step.prompt === 'New password:';
    const isRetypePassword = step.prompt === 'Retype new password:';

    if (isSudoPrompt) {
      const currentUser = this.device.getCurrentUser();
      if (!this.device.checkPassword(currentUser, password)) {
        const left = this.interactive.attemptsLeft - 1;
        if (left <= 0) {
          this.addLine('sudo: 3 incorrect password attempts');
          this.interactive = null; this.passwordBuf = ''; this.inputMode = { type: 'normal' };
          this.notify(); return;
        }
        this.addLine('Sorry, try again.');
        this.addLine(step.prompt);
        this.passwordBuf = '';
        this.interactive = { ...this.interactive, attemptsLeft: left };
        this.notify(); return;
      }
      this.processInteractiveSteps({ ...this.interactive, stepIndex: this.interactive.stepIndex + 1 });
      return;
    }

    if (isSuPrompt) {
      const targetUser = this.interactive.targetUser || 'root';
      if (!this.device.checkPassword(targetUser, password)) {
        const left = this.interactive.attemptsLeft - 1;
        if (left <= 0) {
          this.addLine('su: Authentication failure');
          this.interactive = null; this.passwordBuf = ''; this.inputMode = { type: 'normal' };
          this.notify(); return;
        }
        this.addLine('su: Authentication failure');
        this.addLine('Password:');
        this.passwordBuf = '';
        this.interactive = { ...this.interactive, attemptsLeft: left };
        this.notify(); return;
      }
      this.processInteractiveSteps({ ...this.interactive, stepIndex: this.interactive.stepIndex + 1 });
      return;
    }

    if (isCurrentPassword) {
      const currentUser = this.device.getCurrentUser();
      if (!this.device.checkPassword(currentUser, password)) {
        this.addLine('passwd: Authentication token manipulation error');
        this.addLine('passwd: password unchanged');
        this.interactive = null; this.inputMode = { type: 'normal' };
        this.notify(); return;
      }
      this.processInteractiveSteps({ ...this.interactive, stepIndex: this.interactive.stepIndex + 1 });
      return;
    }

    if (isNewPassword) {
      this.processInteractiveSteps({
        ...this.interactive, stepIndex: this.interactive.stepIndex + 1,
        collectedPassword: password,
      });
      return;
    }

    if (isRetypePassword) {
      if (password !== this.interactive.collectedPassword) {
        this.addLine('Sorry, passwords do not match.');
        this.addLine('passwd: Authentication token manipulation error');
        this.addLine('passwd: password unchanged');
        this.interactive = null; this.inputMode = { type: 'normal' };
        this.notify(); return;
      }
      this.processInteractiveSteps({ ...this.interactive, stepIndex: this.interactive.stepIndex + 1 });
      return;
    }
  }

  private handleInputSubmit(value: string): void {
    if (!this.interactive) return;
    const step = this.interactive.steps[this.interactive.stepIndex];

    if (step.type === 'input') {
      const field = (step as { field: string }).field;
      const gecosFields = {
        ...(this.interactive.gecosFields || { fullName: '', room: '', workPhone: '', homePhone: '', other: '' }),
      };
      if (field === 'fullName') gecosFields.fullName = value;
      else if (field === 'room') gecosFields.room = value;
      else if (field === 'workPhone') gecosFields.workPhone = value;
      else if (field === 'homePhone') gecosFields.homePhone = value;
      else if (field === 'other') gecosFields.other = value;

      this.processInteractiveSteps({ ...this.interactive, stepIndex: this.interactive.stepIndex + 1, gecosFields });
      return;
    }

    if (step.type === 'confirm') {
      const answer = value.trim().toLowerCase();
      if (answer === 'n') {
        this.addLine('Aborted.');
        this.interactive = null; this.inputMode = { type: 'normal' };
        this.notify(); return;
      }
      this.processInteractiveSteps({ ...this.interactive, stepIndex: this.interactive.stepIndex + 1 });
      return;
    }
  }

  // ── lsnrctl (Listener Control) ─────────────────────────────────

  private handleLsnrctl(args: string[]): void {
    initOracleFilesystem(this.device);
    const deviceId = this.device.id || 'default';
    const db = getOracleDatabase(deviceId);
    const subcommand = (args[0] || '').toUpperCase();

    this.addLine('');
    this.addLine('LSNRCTL for Linux: Version 19.0.0.0.0 - Production on ' + new Date().toDateString());
    this.addLine('');
    this.addLine(`Copyright (c) 1991, 2019, Oracle.  All rights reserved.`);
    this.addLine('');

    switch (subcommand) {
      case 'START': {
        db.instance.startListener();
        this.addLine('Starting /u01/app/oracle/product/19c/dbhome_1/bin/tnslsnr: please wait...');
        this.addLine('');
        this.addLine('TNSLSNR for Linux: Version 19.0.0.0.0 - Production');
        this.addLine(`Log messages written to /u01/app/oracle/diag/tnslsnr/${this.device.hostname}/listener/alert/log.xml`);
        this.addLine('Listening on: (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=1521)))');
        this.addLine('');
        this.addLine(`Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=1521)))`);
        this.addLine(`STATUS of the LISTENER`);
        this.addLine('------------------------');
        this.addLine('Alias                     LISTENER');
        this.addLine('Version                   TNSLSNR for Linux: Version 19.0.0.0.0 - Production');
        this.addLine('Start Date                ' + new Date().toLocaleString());
        this.addLine('Uptime                    0 days 0 hr. 0 min. 0 sec');
        this.addLine('Trace Level               off');
        this.addLine('Security                  ON: Local OS Authentication');
        this.addLine('SNMP                      OFF');
        this.addLine(`Listener Log File         /u01/app/oracle/diag/tnslsnr/${this.device.hostname}/listener/alert/log.xml`);
        this.addLine('Listening Endpoints Summary...');
        this.addLine('  (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=1521)))');
        this.addLine('The command completed successfully');
        break;
      }
      case 'STOP': {
        db.instance.stopListener();
        this.addLine('Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=1521)))');
        this.addLine('The command completed successfully');
        break;
      }
      case 'STATUS': {
        const status = db.instance.getListenerStatus();
        this.addLine('Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=1521)))');
        if (status.running) {
          this.addLine('STATUS of the LISTENER');
          this.addLine('------------------------');
          this.addLine('Alias                     LISTENER');
          this.addLine('Version                   TNSLSNR for Linux: Version 19.0.0.0.0 - Production');
          this.addLine('Start Date                ' + (status.startedAt ? new Date(status.startedAt).toLocaleString() : 'N/A'));
          this.addLine('Trace Level               off');
          this.addLine('Security                  ON: Local OS Authentication');
          this.addLine('SNMP                      OFF');
          this.addLine('Listening Endpoints Summary...');
          this.addLine('  (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=1521)))');
          this.addLine('Services Summary...');
          this.addLine(`  Service "${db.getSid()}" has 1 instance(s).`);
          this.addLine(`    Instance "${db.getSid()}", status READY, has 1 handler(s) for this service...`);
          this.addLine('The command completed successfully');
        } else {
          this.addLine('TNS-12541: TNS:no listener');
          this.addLine(' TNS-12560: TNS:protocol adapter error');
          this.addLine('  TNS-00511: No listener');
        }
        break;
      }
      case 'SERVICES': {
        const status = db.instance.getListenerStatus();
        this.addLine('Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=1521)))');
        if (status.running) {
          this.addLine('Services Summary...');
          this.addLine(`  Service "${db.getSid()}" has 1 instance(s).`);
          this.addLine(`    Instance "${db.getSid()}", status READY, has 1 handler(s) for this service...`);
          this.addLine(`      Handler(s):`);
          this.addLine(`        "DEDICATED" established:0 refused:0 state:ready`);
          this.addLine(`           LOCAL SERVER`);
          this.addLine('The command completed successfully');
        } else {
          this.addLine('TNS-12541: TNS:no listener');
        }
        break;
      }
      case 'RELOAD': {
        this.addLine('Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=1521)))');
        this.addLine('The command completed successfully');
        break;
      }
      default: {
        if (!subcommand) {
          this.addLine('The following operations are available');
          this.addLine('An asterisk (*) denotes a modifier or extended command:');
          this.addLine('');
          this.addLine('start             stop              status');
          this.addLine('services          reload            version');
          this.addLine('');
        } else {
          this.addLine(`LSNRCTL-00112: Unknown command "${subcommand}"`);
        }
        break;
      }
    }
    this.notify();
  }

  // ── tnsping ───────────────────────────────────────────────────────

  private handleTnsping(args: string[]): void {
    initOracleFilesystem(this.device);
    const deviceId = this.device.id || 'default';
    const db = getOracleDatabase(deviceId);
    const serviceName = args[0] || '';

    this.addLine('');
    this.addLine('TNS Ping Utility for Linux: Version 19.0.0.0.0 - Production on ' + new Date().toDateString());
    this.addLine('');
    this.addLine(`Copyright (c) 1997, 2019, Oracle.  All rights reserved.`);
    this.addLine('');
    this.addLine('Used parameter files:');
    this.addLine('/u01/app/oracle/product/19c/dbhome_1/network/admin/sqlnet.ora');
    this.addLine('');

    if (!serviceName) {
      this.addLine('TNS-03505: Failed to resolve name');
      this.notify();
      return;
    }

    // Check if service matches known SID/service names
    const upper = serviceName.toUpperCase();
    const status = db.instance.getListenerStatus();

    if (upper === db.getSid().toUpperCase() || upper === db.getServiceName().toUpperCase() || upper === 'LOCALHOST') {
      if (status.running) {
        this.addLine(`Used TNSNAMES adapter to resolve the alias`);
        this.addLine(`Attempting to contact (DESCRIPTION = (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521)) (CONNECT_DATA = (SERVER = DEDICATED) (SERVICE_NAME = ${db.getServiceName()})))`);
        const latency = Math.floor(Math.random() * 5) + 1;
        this.addLine(`OK (${latency} msec)`);
      } else {
        this.addLine(`Used TNSNAMES adapter to resolve the alias`);
        this.addLine(`Attempting to contact (DESCRIPTION = (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521)) (CONNECT_DATA = (SERVER = DEDICATED) (SERVICE_NAME = ${db.getServiceName()})))`);
        this.addLine('TNS-12541: TNS:no listener');
        this.addLine(' TNS-12560: TNS:protocol adapter error');
      }
    } else {
      this.addLine(`TNS-03505: Failed to resolve name`);
    }

    this.notify();
  }

  // ── SQL*Plus sub-shell ──────────────────────────────────────────

  private enterSqlPlus(args: string[]): void {
    initOracleFilesystem(this.device);
    try {
      const deviceId = this.device.id || 'default';
      const { session, banner, loginOutput } = createSQLPlusSession(deviceId, args);

      this.sqlPlusSession = session;
      this.sqlPlusPrompt = session.getPrompt();

      // Display banner
      for (const line of banner) this.addLine(line);
      // Display login output
      for (const line of loginOutput) this.addLine(line);
      this.addLine('');

      this.inputBuf = '';
      this.notify();
    } catch (err) {
      this.addLine(`bash: sqlplus: ${err instanceof Error ? err.message : String(err)}`, 'error');
      this.notify();
    }
  }

  private handleSqlPlusKey(e: KeyEvent): boolean {
    if (e.key === 'Enter') {
      const line = this.inputBuf;
      this.inputBuf = '';
      // Echo the input with prompt
      this.addLine(`${this.sqlPlusPrompt}${line}`);
      this.processSqlPlusLine(line);
      this.notify();
      return true;
    }
    if (e.key === 'c' && e.ctrlKey) {
      // Ctrl+C — cancel current input, but stay in sqlplus
      this.inputBuf = '';
      this.addLine(`${this.sqlPlusPrompt}^C`);
      this.notify();
      return true;
    }
    if (e.key === 'd' && e.ctrlKey) {
      // Ctrl+D — exit sqlplus
      this.exitSqlPlus();
      return true;
    }
    // Let the view handle other keys (typing into the interactive-text input)
    return false;
  }

  private processSqlPlusLine(line: string): void {
    if (!this.sqlPlusSession) return;

    const result = this.sqlPlusSession.processLine(line);

    for (const outputLine of result.output) {
      this.addLine(outputLine);
    }

    if (result.exit) {
      this.exitSqlPlus();
      return;
    }

    this.sqlPlusPrompt = result.prompt;
    this.notify();
  }

  private exitSqlPlus(): void {
    if (this.sqlPlusSession) {
      this.sqlPlusSession.disconnect();
      this.sqlPlusSession = null;
    }
    this.sqlPlusPrompt = 'SQL> ';
    this.inputBuf = '';
    this.inputMode = { type: 'normal' };
    this.notify();
  }
}
