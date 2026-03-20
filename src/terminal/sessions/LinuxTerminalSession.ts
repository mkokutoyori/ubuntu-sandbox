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
import { createSQLPlusSession } from '@/terminal/commands/database';
import { InteractiveFlowEngine } from '@/terminal/core/InteractiveFlow';
import { AnsiOutputFormatter } from '@/terminal/core/OutputFormatter';
import { LinuxFlowBuilder } from '@/terminal/flows/LinuxFlowBuilder';
import type { FlowContext, TerminalResponse, InteractiveStep } from '@/terminal/core/types';

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
  /** The new interactive flow engine — replaces the old InteractiveState */
  private flowEngine: InteractiveFlowEngine | null = null;
  private flowFormatter = new AnsiOutputFormatter();
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
    // Flow engine active — derive InputMode from the last response directive
    if (this.flowEngine && !this.flowEngine.isComplete) {
      return this.inputMode; // already set by advanceFlow()
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

    // Flow engine active — route based on current input mode
    if (this.flowEngine && !this.flowEngine.isComplete) {
      if (this.inputMode.type === 'password') return this.handlePasswordKey(e);
      if (this.inputMode.type === 'interactive-text') return this.handleInteractiveTextKey(e);
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
      this.advanceFlow(pw);
      return true;
    }
    if (e.key === 'c' && e.ctrlKey) {
      this.flowEngine = null;
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
      this.advanceFlow(val);
      return true;
    }
    if (e.key === 'c' && e.ctrlKey) {
      this.flowEngine = null;
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
    // No notify needed — the view manages this input's own React state
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
    }

    // Check if this command needs interactive prompts
    // (handles sudo password for `sudo sqlplus`, sudo passwd, su, etc.)
    if (this.startInteractiveFlow(trimmed)) {
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

  // ── Interactive flow (new engine-based architecture) ──────────────

  /**
   * Check if a command needs interactive prompts and start the flow if so.
   * Returns true if a flow was started, false otherwise.
   */
  private startInteractiveFlow(command: string): boolean {
    const currentUser = this.device.getCurrentUser();
    const currentUid = this.device.getCurrentUid();

    // Check for sudo sqlplus — special case: enter SQL*Plus sub-shell after sudo auth
    const noSudo = command.startsWith('sudo ') ? command.slice(5).trim() : command;
    const cmdParts = noSudo.split(/\s+/);
    if (cmdParts[0] === 'sqlplus' && command.startsWith('sudo ')) {
      // Need sudo auth first, then enter sqlplus
      const steps = LinuxFlowBuilder.build(command, currentUser, currentUid, this.device);
      if (steps) {
        // Replace the generic execute step with sqlplus entry
        const sqlplusArgs = cmdParts.slice(1);
        const patchedSteps: InteractiveStep[] = steps.map(step => {
          if (step.type === 'execute' && step.action) {
            return {
              ...step,
              action: async (ctx: FlowContext) => {
                // After sudo auth, enter sqlplus instead of running the command
                ctx.metadata.set('enter_sqlplus', JSON.stringify(sqlplusArgs));
              },
            };
          }
          return step;
        });
        this.createAndAdvanceFlow(patchedSteps, command, currentUser, currentUid);
        return true;
      }
    }

    const steps = LinuxFlowBuilder.build(command, currentUser, currentUid, this.device);
    if (!steps) return false;

    this.createAndAdvanceFlow(steps, command, currentUser, currentUid);
    return true;
  }

  /** Create a FlowContext, start the InteractiveFlowEngine, and advance. */
  private createAndAdvanceFlow(
    steps: InteractiveStep[],
    command: string,
    currentUser: string,
    currentUid: number,
  ): void {
    const ctx: FlowContext = {
      values: new Map(),
      device: this.device,
      currentUser,
      currentUid,
      metadata: new Map([['original_command', command]]),
      executeCommand: async (cmd: string) => this.executeOnDevice(cmd),
      onOutput: (text: string, lineType?: string) => {
        this.addLine(text, lineType || 'normal');
      },
      onClearScreen: () => this.clear(),
    };

    this.flowEngine = new InteractiveFlowEngine(
      steps,
      ctx,
      this.flowFormatter,
      this.getPrompt(),
    );
    this.passwordBuf = '';
    this.inputBuf = '';

    this.advanceFlow();
  }

  /**
   * Advance the flow engine with optional user input.
   * Maps the TerminalResponse to the session's existing API.
   */
  private async advanceFlow(userInput?: string): Promise<void> {
    if (!this.flowEngine) return;

    const response = await this.flowEngine.advance(userInput);

    // Map response lines to addLine() calls (for lines produced by the engine itself,
    // e.g. validation errors, output steps). Note: execute steps use ctx.onOutput()
    // to display results directly, so they won't appear in response.lines.
    for (const line of response.lines) {
      const text = line.segments.map(s => s.text).join('');
      this.addLine(text, line.lineType || 'normal');
    }

    if (this.flowEngine.isComplete) {
      // Check for special post-flow actions
      const ctx = this.flowEngine.getContext();
      const sqlplusArgs = ctx.metadata.get('enter_sqlplus') as string | undefined;
      if (sqlplusArgs) {
        this.flowEngine = null;
        this.passwordBuf = '';
        this.inputBuf = '';
        this.inputMode = { type: 'normal' };
        this.enterSqlPlus(JSON.parse(sqlplusArgs));
        return;
      }

      this.flowEngine = null;
      this.passwordBuf = '';
      this.inputBuf = '';
      this.inputMode = { type: 'normal' };
      this.syncDeviceState();
      this.notify();
    } else {
      // Map InputDirective to InputMode for the view
      const directive = response.inputDirective;
      switch (directive.type) {
        case 'password':
          this.inputMode = { type: 'password', promptText: directive.prompt };
          break;
        case 'text-prompt':
          this.inputMode = { type: 'interactive-text', promptText: directive.prompt };
          break;
        case 'confirmation':
          this.inputMode = { type: 'interactive-text', promptText: directive.prompt };
          break;
        default:
          this.inputMode = { type: 'normal' };
      }
      this.notify();
    }
  }

  // ── SQL*Plus sub-shell ──────────────────────────────────────────

  private enterSqlPlus(args: string[]): void {
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
