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

  override get currentInputMode(): InputMode {
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
      const pw = this._passwordBuf;
      this._passwordBuf = '';
      this.advanceFlow(pw);
      return true;
    }
    if (e.key === 'c' && e.ctrlKey) {
      this.flowEngine = null;
      this._passwordBuf = '';
      this.addLine('^C');
      this.inputMode = { type: 'normal' };
      this.notify();
      return true;
    }
    // All other keys are captured by the hidden password input in the view
    return false;
  }

  // ── Interactive text mode keys ──────────────────────────────────

  private handleInteractiveTextKey(e: KeyEvent): boolean {
    if (e.key === 'Enter') {
      const val = this._inputBuf;
      this._inputBuf = '';
      this.advanceFlow(val);
      return true;
    }
    if (e.key === 'c' && e.ctrlKey) {
      this.flowEngine = null;
      this._inputBuf = '';
      this.inputMode = { type: 'normal' };
      this.addLine('^C');
      return true;
    }
    return false;
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
    this._passwordBuf = '';
    this._inputBuf = '';

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
        this._passwordBuf = '';
        this._inputBuf = '';
        this.inputMode = { type: 'normal' };
        this.enterSqlPlus(JSON.parse(sqlplusArgs));
        return;
      }

      this.flowEngine = null;
      this._passwordBuf = '';
      this._inputBuf = '';
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

      this._inputBuf = '';
      this.notify();
    } catch (err) {
      this.addLine(`bash: sqlplus: ${err instanceof Error ? err.message : String(err)}`, 'error');
      this.notify();
    }
  }

  private handleSqlPlusKey(e: KeyEvent): boolean {
    if (e.key === 'Enter') {
      const line = this._inputBuf;
      this._inputBuf = '';
      // Echo the input with prompt
      this.addLine(`${this.sqlPlusPrompt}${line}`);
      this.processSqlPlusLine(line);
      this.notify();
      return true;
    }
    if (e.key === 'c' && e.ctrlKey) {
      // Ctrl+C — cancel current input, but stay in sqlplus
      this._inputBuf = '';
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
    this._inputBuf = '';
    this.inputMode = { type: 'normal' };
    this.notify();
  }
}
