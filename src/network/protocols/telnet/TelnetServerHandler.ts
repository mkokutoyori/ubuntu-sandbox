/**
 * TelnetServerHandler — server-side endpoint registered on TCP port 23.
 *
 * Counterpart of `SshServerHandler`: it owns RFC 854 framing, the option
 * negotiation, the login dialog and the per-connection EXEC session, and
 * asks {@link ITelnetServerContext} for everything device-specific.
 *
 * Before this existed the router's port-23 listener accepted the
 * handshake and did nothing with it, so the connect verdict came from the
 * wire but no session ever followed (docs/PRD-VTY-Transport.md §2.1 item
 * 6). The bytes an operator types now really cross the cabling and the
 * answers really come back from the device's own CLI.
 */

import { TimerSet } from '@/events/TimerSet';
import { getDefaultScheduler } from '@/events/Scheduler';
import type { TcpStream } from '@/network/tcp/types';
import {
  AYT, BRK, IP as TELNET_IP, WILL,
  OPT_ECHO, OPT_NEW_ENVIRON, OPT_SUPPRESS_GO_AHEAD, OPT_TERMINAL_SPEED,
  OPT_TERMINAL_TYPE, OPT_X_DISPLAY_LOCATION,
  encodeSubnegotiation, fromNvtText, parseTelnetChunk, toNvtText,
} from './TelnetCodec';
import { TelnetNegotiator, type TelnetOptionPolicy } from './TelnetNegotiator';
import type { ITelnetServerContext, TelnetVtyShell } from './ITelnetServerContext';

/**
 * What a real Cisco IOS telnet server offers on connect: it drives echo
 * and go-ahead suppression itself, and asks the client to describe its
 * terminal.
 */
export const IOS_TELNET_OPTION_POLICY: TelnetOptionPolicy = {
  offer: [OPT_ECHO, OPT_SUPPRESS_GO_AHEAD],
  request: [OPT_TERMINAL_TYPE, OPT_TERMINAL_SPEED, OPT_X_DISPLAY_LOCATION, OPT_NEW_ENVIRON],
};

type Phase = 'username' | 'password' | 'exec' | 'closed';

const DEFAULT_MAX_AUTH_ATTEMPTS = 3;

/** Sub-option codes of RFC 1091's terminal-type negotiation. */
const TERMINAL_TYPE_IS = 0;
const TERMINAL_TYPE_SEND = 1;

export class TelnetServerHandler {
  constructor(private readonly ctx: ITelnetServerContext) {}

  register(conn: TcpStream, clientIp: string): void {
    const admission = this.ctx.admit(clientIp);
    if (!admission.accept) {
      if (admission.kind === 'line-password' && admission.reason) {
        conn.write(toNvtText(`\n[${admission.reason}]\n\nConnection closed by foreign host.\n`));
      }
      conn.close();
      return;
    }
    new TelnetSession(this.ctx, conn, clientIp).start();
  }
}

class TelnetSession {
  private readonly negotiator = new TelnetNegotiator(IOS_TELNET_OPTION_POLICY);
  private readonly timers = new TimerSet(() => getDefaultScheduler());
  private carry: readonly number[] = [];
  private lineBuffer = '';
  private phase: Phase = 'exec';
  private username: string | null = null;
  private attempts = 0;
  private shell: TelnetVtyShell | null = null;
  private sessionId: string | null = null;
  private offAsyncOutput: (() => void) | null = null;
  private idleTimer: ReturnType<TimerSet['setTimeout']> | null = null;
  private busy: Promise<void> = Promise.resolve();
  private terminalType: string | null = null;

  constructor(
    private readonly ctx: ITelnetServerContext,
    private readonly conn: TcpStream,
    private readonly clientIp: string,
  ) {}

  start(): void {
    this.conn.onData((chunk) => this.onData(chunk));
    this.conn.onClose?.(() => this.teardown('closed'));
    this.send(this.negotiator.openingOffer());

    const banner = this.ctx.banner();
    if (banner) this.write(`\n${banner}\n`);

    const prompt = this.ctx.authPrompt();
    if (prompt === 'none') { this.beginExec(''); return; }

    const header = this.ctx.authHeader?.();
    if (header) this.write(`\n${header}\n`);
    if (prompt === 'username-password') { this.phase = 'username'; this.write('\nUsername: '); }
    else { this.phase = 'password'; this.write('\nPassword: '); }
  }

  private onData(chunk: string): void {
    if (this.phase === 'closed') return;
    const parsed = parseTelnetChunk(chunk, this.carry);
    this.carry = parsed.carry;

    const reply = this.negotiator.respond(parsed.negotiations);
    if (reply) this.send(reply);
    this.askForTerminalType(parsed.negotiations);

    for (const sub of parsed.subnegotiations) this.onSubnegotiation(sub.option, sub.params);
    for (const control of parsed.controls) this.onControl(control);
    if (parsed.data) this.onText(parsed.data);
  }

  /**
   * RFC 1091: once the client agrees to describe its terminal, ask for
   * the value. The answer lands in `show users` / `display users`.
   */
  private askForTerminalType(negotiations: readonly { verb: number; option: number }[]): void {
    for (const n of negotiations) {
      if (n.verb !== WILL || n.option !== OPT_TERMINAL_TYPE) continue;
      if (!this.negotiator.isRemoteEnabled(OPT_TERMINAL_TYPE)) continue;
      this.send(encodeSubnegotiation(OPT_TERMINAL_TYPE, [TERMINAL_TYPE_SEND]));
    }
  }

  private onSubnegotiation(option: number, params: readonly number[]): void {
    if (option !== OPT_TERMINAL_TYPE || params[0] !== TERMINAL_TYPE_IS) return;
    this.terminalType = String.fromCharCode(...params.slice(1)) || null;
    if (this.terminalType && this.sessionId) {
      this.ctx.noteTerminalType?.(this.sessionId, this.terminalType);
    }
  }

  /**
   * RFC 854 §"Telnet Commands". `AYT` must produce visible evidence the
   * session is alive; `IP`/`BRK` abandon what has been typed so far, the
   * same thing Ctrl+C does at an IOS prompt.
   */
  private onControl(command: number): void {
    if (command === AYT) { this.write(`\n[${this.ctx.hostname()}]\n`); this.writePrompt(); return; }
    if (command === TELNET_IP || command === BRK) {
      this.lineBuffer = '';
      if (this.phase === 'exec') { this.write('\n'); this.writePrompt(); }
    }
  }

  private onText(text: string): void {
    const normalized = fromNvtText(text);
    for (const ch of normalized) {
      if (ch === '\n') { const line = this.lineBuffer; this.lineBuffer = ''; this.echo('\n'); this.submit(line); continue; }
      if (ch === '\x7f' || ch === '\b') {
        if (this.lineBuffer.length > 0) { this.lineBuffer = this.lineBuffer.slice(0, -1); this.echo('\b \b'); }
        continue;
      }
      if (ch === '\0' || ch < ' ') continue;
      this.lineBuffer += ch;
      this.echo(ch);
    }
  }

  /**
   * The server drives echo (it answered `WILL ECHO`), so what the operator
   * types only appears because it is sent back — except a password, which
   * a real telnet server deliberately leaves invisible.
   */
  private echo(text: string): void {
    if (this.phase === 'password') return;
    if (!this.negotiator.isLocalEnabled(OPT_ECHO)) return;
    this.send(toNvtText(text));
  }

  private submit(line: string): void {
    this.busy = this.busy.then(() => this.dispatch(line)).catch(() => { /* session already gone */ });
  }

  private async dispatch(line: string): Promise<void> {
    if (this.phase === 'closed') return;
    if (this.phase === 'username') { this.username = line.trim(); this.phase = 'password'; this.write('Password: '); return; }
    if (this.phase === 'password') { await this.verifyPassword(line); return; }
    await this.runCommand(line);
  }

  private async verifyPassword(password: string): Promise<void> {
    const ok = await this.ctx.authenticate(this.username, password);
    if (ok) {
      this.ctx.recordLogin?.(this.username ?? '', this.clientIp);
      this.beginExec(this.username ?? '');
      return;
    }
    this.attempts++;
    this.ctx.recordAuthFailure?.(this.username ?? '', this.clientIp);
    const max = this.ctx.maxAuthAttempts?.() ?? DEFAULT_MAX_AUTH_ATTEMPTS;
    if (this.attempts >= max) {
      this.phase = 'exec';
      this.write('\n% Bad passwords\n\nConnection closed by foreign host.\n');
      this.teardown('bad-passwords');
      this.conn.close();
      return;
    }
    this.write('\n% Login invalid\n');
    if (this.ctx.authPrompt() === 'username-password') { this.phase = 'username'; this.write('\nUsername: '); }
    else { this.phase = 'password'; this.write('\nPassword: '); }
  }

  private beginExec(username: string): void {
    const handle = this.ctx.openSession(username, this.clientIp, this.conn.remotePort);
    if (!handle) {
      this.write('\n% No free vty lines\n\nConnection closed by foreign host.\n');
      this.teardown('no-line');
      this.conn.close();
      return;
    }
    this.sessionId = handle.id;
    if (this.terminalType) this.ctx.noteTerminalType?.(handle.id, this.terminalType);
    this.username = username || null;
    this.shell = this.ctx.createShell(this.username);
    this.phase = 'exec';

    const motd = this.ctx.motd?.();
    if (motd) this.write(`\n${motd}\n`);
    this.offAsyncOutput = this.shell?.subscribeAsyncOutput?.((out) => this.write(`\n${out}\n`)) ?? null;
    this.write('\n');
    this.writePrompt();
    this.rearmIdle();
  }

  private async runCommand(line: string): Promise<void> {
    const shell = this.shell;
    if (!shell) { this.writePrompt(); return; }
    this.ctx.touchSession?.(this.sessionId ?? '', line.length, 0);
    const output = await shell.execute(line);
    if (this.phase === 'closed') return;
    if (output) this.write(`${output}\n`);
    if (shell.lastEndedSession()) {
      this.write('\nConnection closed by foreign host.\n');
      this.teardown('logout');
      this.conn.close();
      return;
    }
    this.writePrompt();
    this.rearmIdle();
  }

  private writePrompt(): void {
    if (this.phase !== 'exec' || !this.shell) return;
    this.send(toNvtText(this.shell.getPrompt()));
  }

  /**
   * `exec-timeout` on the line: the server hangs an idle EXEC up, and the
   * client only learns of it by having its socket closed — same semantics
   * the SSH daemon already applies from the very same line config.
   */
  private rearmIdle(): void {
    if (this.idleTimer !== null) this.timers.clear(this.idleTimer);
    this.idleTimer = null;
    const ms = this.ctx.idleTimeoutMs?.() ?? null;
    if (ms == null || ms <= 0) return;
    this.idleTimer = this.timers.setTimeout(() => {
      this.write('\nConnection closed by foreign host.\n');
      this.teardown('exec-timeout');
      this.conn.close();
    }, ms);
  }

  private write(text: string): void {
    this.send(toNvtText(text));
  }

  private send(raw: string): void {
    if (!raw || this.phase === 'closed') return;
    try { this.conn.write(raw); this.ctx.touchSession?.(this.sessionId ?? '', 0, raw.length); }
    catch { this.teardown('write-failed'); }
  }

  private teardown(reason: string): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.timers.clearAll();
    this.idleTimer = null;
    this.offAsyncOutput?.();
    this.offAsyncOutput = null;
    this.shell?.dispose?.();
    this.shell = null;
    if (this.sessionId) { this.ctx.closeSession(this.sessionId, reason); this.sessionId = null; }
  }
}
