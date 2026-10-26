/**
 * WinRmClient — outbound WinRM dialer used by `Invoke-Command
 * -ComputerName`, `Enter-PSSession`, `Test-WSMan` (PRD-Windows-Server.md
 * §5 P4). Real TCP/5985 dial through the device's `TcpStack` — genuine
 * routing/cables/firewalls, not a topology-wide lookup — replacing the
 * `findHostByAddress` shortcut the pre-P4 remoting provider used.
 */

import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import { bytesToBase64 } from '@/crypto/encoding';
import { JsonMessageAssembler } from '../JsonMessageAssembler';
import type { WinRmShellReply, WinRmShellCompletion } from './WinRmShell';

export interface WinRmDialResult {
  ok: boolean;
  error?: string;
}

const WINRM_PORT = 5985;
const SERVICE_NOT_RUNNING = 'WinRM cannot complete the operation. Verify that the WinRM service is running on the destination.';
export const WINRM_UNREACHABLE = 'WinRM cannot complete the operation. Verify that the specified computer name is valid, that the computer '
  + 'is accessible over the network, and that a firewall exception for the WinRM service is enabled and allows '
  + 'access from this computer.';

function roundTrip(socket: TcpSocket, payload: Record<string, unknown>): Record<string, unknown> | null {
  const assembler = new JsonMessageAssembler();
  let response: Record<string, unknown> | null = null;
  const unsubscribe = socket.onData((data) => {
    response ??= assembler.push(String(data))[0] ?? null;
  });
  socket.write(JSON.stringify(payload));
  unsubscribe();
  return response;
}

interface WinRmChannelRequest {
  tcpStack: TcpStack;
  targetIp: string;
  credential?: { username: string; password: string };
  apReq?: Uint8Array;
  unreachable?: string;
}

type WinRmChannel = { ok: true; socket: TcpSocket } | { ok: false; error: string };

function openWinRmChannel(opts: WinRmChannelRequest): WinRmChannel {
  const socket = opts.tcpStack.connect(opts.targetIp, WINRM_PORT);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: opts.unreachable ?? WINRM_UNREACHABLE };
  }
  const negotiate = roundTrip(socket, { op: 'negotiate' });
  if (!negotiate?.ok) {
    socket.close();
    return { ok: false, error: SERVICE_NOT_RUNNING };
  }
  const auth = opts.apReq
    ? roundTrip(socket, { op: 'krbAuth', apReq: bytesToBase64(opts.apReq) })
    : roundTrip(socket, { op: 'auth', username: opts.credential?.username ?? '', password: opts.credential?.password ?? '' });
  if (!auth?.ok) {
    socket.close();
    return { ok: false, error: (auth as { message?: string } | null)?.message ?? 'Access is denied.' };
  }
  return { ok: true, socket };
}

/** Dial WinRM on `targetIp`, negotiate, and authenticate. Always closes the probe socket. */
export function dialWinRm(opts: {
  tcpStack: TcpStack;
  targetIp: string;
  username: string;
  password: string;
}): WinRmDialResult {
  const channel = openWinRmChannel({
    tcpStack: opts.tcpStack,
    targetIp: opts.targetIp,
    credential: { username: opts.username, password: opts.password },
    unreachable: 'Connecting to remote server failed: WinRM cannot complete the operation. '
      + 'Verify that the specified computer name is valid, that the computer is accessible over the network, '
      + 'and that a firewall exception for the WinRM service is enabled and allows access from this computer.',
  });
  if (channel.ok === false) return { ok: false, error: channel.error };
  channel.socket.close();
  return { ok: true };
}

/**
 * Windows Event Forwarding push (PRD-Wecutil.md §2.1 P4) — dial + real
 * negotiate/auth (same wire path as `dialWinRm`), then a `wecPush` op
 * carrying the matching event. Authenticates as the SOURCE machine's own
 * computer account (`<hostname>$` + its domain secret) — a computer
 * account is a first-class Kerberos principal in this simulator's KDC
 * already (`KdcSession.handleAsReq`), so no new server-side credential
 * path is needed. One real dial per forwarded event (same one-shot
 * pattern as `Send-MailMessage`), not a persistent channel.
 */
export function pushForwardedEvent(opts: {
  tcpStack: TcpStack;
  targetIp: string;
  username: string;
  password: string;
  subscriptionId: string;
  sourceMachine: string;
  event: { eventId: number; timeGenerated: string; message: string; sourceLogName: string };
}): WinRmDialResult {
  const channel = openWinRmChannel({
    tcpStack: opts.tcpStack,
    targetIp: opts.targetIp,
    credential: { username: opts.username, password: opts.password },
    unreachable: 'WinRM cannot complete the operation: the collector is not reachable.',
  });
  if (channel.ok === false) return { ok: false, error: channel.error };

  const push = roundTrip(channel.socket, {
    op: 'wecPush', subscriptionId: opts.subscriptionId, sourceMachine: opts.sourceMachine, event: opts.event,
  });
  channel.socket.close();
  if (!push?.ok) {
    return { ok: false, error: (push as { message?: string } | null)?.message ?? 'The event could not be forwarded.' };
  }
  return { ok: true };
}

export interface WinRmRunResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export function runWinRmRequest(opts: {
  tcpStack: TcpStack;
  targetIp: string;
  request: Record<string, unknown>;
  credential?: { username: string; password: string };
  apReq?: Uint8Array;
}): WinRmRunResult {
  const channel = openWinRmChannel(opts);
  if (channel.ok === false) return { ok: false, error: channel.error };
  const run = roundTrip(channel.socket, opts.request);
  channel.socket.close();
  if (!run?.ok) return { ok: false, error: (run as { message?: string } | null)?.message ?? 'Access is denied.' };
  return { ok: true, output: String(run.output ?? '') };
}

export function runWinRmCommand(opts: {
  tcpStack: TcpStack;
  targetIp: string;
  line: string;
  credential?: { username: string; password: string };
  apReq?: Uint8Array;
}): WinRmRunResult {
  return runWinRmRequest({ ...opts, request: { op: 'run', line: opts.line } });
}

export type WinRmRunspaceOpening =
  | { readonly ok: true; readonly runspace: WinRmRunspace }
  | { readonly ok: false; readonly error: string };

export class WinRmRunspace {
  private readonly assembler = new JsonMessageAssembler();
  private waiting: { resolve(reply: Record<string, unknown>): void; reject(error: Error): void } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private currentPrompt = '';

  private constructor(
    private readonly socket: TcpSocket,
    private readonly pathAlive: () => boolean,
  ) {
    socket.onData((chunk) => {
      for (const reply of this.assembler.push(String(chunk))) {
        const pending = this.waiting;
        this.waiting = null;
        pending?.resolve(reply);
      }
    });
    socket.onClose(() => this.lose());
  }

  static async open(opts: WinRmChannelRequest & { pathAlive: () => boolean }): Promise<WinRmRunspaceOpening> {
    const channel = openWinRmChannel(opts);
    if (channel.ok === false) return channel;
    const runspace = new WinRmRunspace(channel.socket, opts.pathAlive);
    let reply: Record<string, unknown>;
    try {
      reply = await runspace.request({ op: 'shell_open' });
    } catch (error) {
      runspace.close();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!reply.ok) {
      runspace.close();
      return { ok: false, error: String(reply.message ?? 'Access is denied.') };
    }
    runspace.currentPrompt = String(reply.prompt ?? '');
    return { ok: true, runspace };
  }

  get prompt(): string {
    return this.currentPrompt;
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.state === 'established' && this.pathAlive();
  }

  async run(line: string): Promise<WinRmShellReply> {
    const reply = await this.request({ op: 'shell_run', line });
    if (!reply.ok) throw new Error(String(reply.message ?? 'Access is denied.'));
    this.currentPrompt = String(reply.prompt ?? this.currentPrompt);
    return { output: String(reply.output ?? ''), prompt: this.currentPrompt, ended: reply.ended === true };
  }

  async complete(line: string): Promise<WinRmShellCompletion> {
    const reply = await this.request({ op: 'shell_complete', line });
    if (!reply.ok) throw new Error(String(reply.message ?? 'Access is denied.'));
    const candidates = Array.isArray(reply.candidates) ? reply.candidates.map(String) : [];
    return { candidates, start: typeof reply.start === 'number' ? reply.start : null };
  }

  close(): void {
    if (this.closed) return;
    const wasOpen = this.isOpen;
    this.closed = true;
    if (wasOpen) this.socket.write(JSON.stringify({ op: 'shell_close' }));
    this.socket.close();
  }

  private lose(): void {
    this.closed = true;
    const pending = this.waiting;
    this.waiting = null;
    pending?.reject(new Error(WINRM_UNREACHABLE));
  }

  private request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const turn = this.tail.then(() => this.exchange(payload));
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  private exchange(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        reject(new Error(WINRM_UNREACHABLE));
        return;
      }
      this.waiting = { resolve, reject };
      this.socket.write(JSON.stringify(payload));
    });
  }
}
