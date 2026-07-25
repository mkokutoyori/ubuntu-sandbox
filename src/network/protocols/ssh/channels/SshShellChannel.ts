/**
 * SshShellChannel — interactive shell channel.
 *
 * Wire protocol (simulator):
 *   client → server  { op: 'shell_open',  channelId }
 *   server → client  { ok: true, channelId }
 *   client → server  { op: 'shell_input', channelId, data: '<line>' }
 *   server → client  { stdout, stderr, exitCode }
 *   client → server  { op: 'shell_close', channelId }
 *
 * Real OpenSSH uses an arbitrary byte stream; the simulator slices on
 * line boundaries because every shell call is line-oriented. The
 * server allocates one persistent `ShellSession` per channelId so cwd
 * / env / shell history survive across calls.
 *
 * Reference: DESIGN-SSH-SFTP.md section 7 ; analysis doc §5 P4.
 */

import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import { AbstractSshChannel } from './AbstractSshChannel';
import type { ExecResult, ISshShellChannel } from './ISshChannel';

export class SshShellChannel
  extends AbstractSshChannel
  implements ISshShellChannel
{
  readonly type = 'shell' as const;

  private dataHandlers: Array<(d: string) => void> = [];
  private offConn: (() => void) | null = null;
  private cols = 80;
  private rows = 24;
  private pendingLine: ((r: ExecResult) => void) | null = null;
  private pendingComplete: ((c: string[]) => void) | null = null;
  private inlineHelp = false;

  /** True when the remote treats `?` as a help key (network CLI). */
  supportsInlineHelp(): boolean { return this.inlineHelp; }

  constructor(conn: TcpConnection, channelId: number) {
    super(conn, channelId, 'shell');
  }

  protected handleOpen(): void {
    this.offConn = this.conn.onData((data) => this.onWire(data));
    // Announce the channel to the server so it can spin up the
    // persistent shell session.
    this.conn.write(
      JSON.stringify({ op: 'shell_open', channelId: this.channelId }),
    );
  }

  protected handleClose(): void {
    if (this.offConn) {
      this.conn.write(
        JSON.stringify({ op: 'shell_close', channelId: this.channelId }),
      );
    }
    this.offConn?.();
    this.offConn = null;
    this.dataHandlers = [];
  }

  send(data: string): void {
    if (!this._isOpen) return;
    void this.runLine(data);
  }

  onData(handler: (data: string) => void): () => void {
    this.dataHandlers.push(handler);
    return () => {
      this.dataHandlers = this.dataHandlers.filter((h) => h !== handler);
    };
  }

  runLine(line: string): Promise<ExecResult> {
    if (!this._isOpen) {
      return Promise.resolve({ stdout: '', stderr: 'channel closed', exitCode: 255 });
    }
    return new Promise<ExecResult>((resolve) => {
      this.pendingLine = resolve;
      this.conn.write(
        JSON.stringify({
          op: 'shell_input',
          channelId: this.channelId,
          data: line,
        }),
      );
    });
  }

  complete(line: string): Promise<string[]> {
    if (!this._isOpen) return Promise.resolve([]);
    return new Promise<string[]>((resolve) => {
      this.pendingComplete = resolve;
      this.conn.write(
        JSON.stringify({ op: 'shell_complete', channelId: this.channelId, data: line }),
      );
    });
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this._isOpen) {
      this.conn.write(
        JSON.stringify({ op: 'shell_resize', cols, rows, channelId: this.channelId }),
      );
    }
  }

  sendSignal(signal: 'SIGINT'): void {
    if (!this._isOpen) return;
    this.conn.write(
      JSON.stringify({ op: 'shell_signal', channelId: this.channelId, signal }),
    );
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  // ─── private ────────────────────────────────────────────────────

  private onWire(raw: string): void {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Pass non-JSON traffic to data subscribers unchanged.
      for (const h of this.dataHandlers) h(raw);
      return;
    }
    // Traffic tagged for a different channel on this same connection (e.g.
    // another shell channel, or a keepalive with no channelId at all —
    // those fall through unfiltered below, same as before).
    if (parsed.channelId !== undefined && parsed.channelId !== this.channelId) {
      return;
    }
    if (parsed.ok === true) {
      // shell_open / shell_close ack — surface nothing to onData, but
      // record the capabilities the server advertised on open.
      if (typeof parsed.inlineHelp === 'boolean') this.inlineHelp = parsed.inlineHelp;
      return;
    }
    if (parsed.op === 'shell_complete_result') {
      const candidates = Array.isArray(parsed.candidates)
        ? (parsed.candidates as unknown[]).filter((c): c is string => typeof c === 'string')
        : [];
      this.pendingComplete?.(candidates);
      this.pendingComplete = null;
      return;
    }
    if (parsed.op === 'shell_output') {
      // A line of output pushed while a real-time job (e.g. `ping`) is
      // still running server-side — runLine()'s promise stays pending
      // until the matching stdout/stderr/exitCode reply arrives below.
      const chunk = typeof parsed.chunk === 'string' ? parsed.chunk : '';
      if (chunk) for (const h of this.dataHandlers) h(chunk);
      return;
    }
    if (
      typeof parsed.stdout === 'string' ||
      typeof parsed.stderr === 'string' ||
      typeof parsed.exitCode === 'number'
    ) {
      const result: ExecResult = {
        stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
        stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
        exitCode:
          typeof parsed.exitCode === 'number' ? parsed.exitCode : 0,
        prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
        nested: parsed.nested === true,
      };
      this.pendingLine?.(result);
      this.pendingLine = null;
      const merged = (result.stdout ?? '') + (result.stderr ?? '');
      if (merged) for (const h of this.dataHandlers) h(merged);
      return;
    }
    // Any other JSON payload: pass through verbatim for advanced consumers.
    for (const h of this.dataHandlers) h(raw);
  }
}
