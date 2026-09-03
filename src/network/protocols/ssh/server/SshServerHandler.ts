/**
 * SshServerHandler — server-side endpoint registered on TCP port 22.
 *
 * Orchestrates the protocol negotiation, authentication and channel dispatch.
 * Depends only on ISshServerContext (Linux/Windows adapters provide it).
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.
 */

import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import { TimerSet } from '@/events/TimerSet';
import { getDefaultScheduler } from '@/events/Scheduler';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorSession } from '@/network/devices/linux/editors/EditorView';
import type { ChannelType } from '../channels/ISshChannel';
import type { AccountLifecycleVerdict } from '../auth/ISshAuthMethod';
import {
  encodeSftpChannelFrame,
  decodeSftpChannelFrame,
  isSftpChannelFrame,
} from '../channels/SftpChannelFraming';
import { isErr, isOk } from '../Result';
import { PermissionCheckingFSDecorator } from '../sftp/PermissionCheckingFSDecorator';
import { SftpCommandDispatcher } from '../sftp/SftpCommandDispatcher';
import type { SftpRequestPayload } from '../sftp/ISftpCommand';
import { SftpWireSession } from '../sftp/SftpWireSession';
import { encodeSftpWirePacket, decodeSftpWirePacket } from '../sftp/SftpWireCodec';
import { SshUserContext } from '../SshUserContext';
import { SSH_SERVER_IDENTIFICATION } from '../serverIdentification';
import type { ILinuxShell, ISshServerContext } from './ISshServerContext';
import type { SshInteractiveShell } from './SshInteractiveShell';
import {
  type ISshServerEventBus,
  SshServerEventBus,
} from './SshServerEvent';

interface ProtocolInfo {
  readonly clientVersion: string;
}

interface OpenChannelInfo {
  readonly type: ChannelType;
  readonly userCtx: SshUserContext;
  cwd: string;
  readonly openedAt: number;
  /** Real-time job runtime (streaming ping, Ctrl+C) — shell channels only. */
  interactiveShell?: SshInteractiveShell | null;
  /**
   * Persistent per-channel shell (real per-session identity/cwd — see
   * LinuxSshServerContext.getShell()), created once at shell_open and
   * reused for every shell_input line so cwd/su-stack/user genuinely
   * survive across the channel's lifetime, and disposed when it closes.
   */
  shell?: ILinuxShell;
  /**
   * Detaches this channel from the shell's unprompted output stream
   * (`debug`, `terminal monitor`). Set at shell_open for a remote that
   * publishes one, and called once the channel or the connection goes.
   */
  offAsyncOutput?: () => void;
  /**
   * The editor currently holding this channel, if any. While it is set
   * every keystroke goes to the engine instead of the shell
   * (docs/PRD-SSH-Unification.md §4bis B3).
   */
  editor?: EditorSession;
}

const PREAUTH_COUNT = new WeakMap<object, { value: number }>();

function preauthSlot(ctx: object): { value: number } {
  let s = PREAUTH_COUNT.get(ctx);
  if (!s) { s = { value: 0 }; PREAUTH_COUNT.set(ctx, s); }
  return s;
}

export class SshServerHandler {
  private readonly dispatcher = SftpCommandDispatcher.defaults();

  private readonly eventBus: ISshServerEventBus;

  constructor(
    private readonly ctx: ISshServerContext,
    eventBus?: ISshServerEventBus,
  ) {
    // Prefer the bus the context owns (so reactive subscribers attached to
    // the context — logger, throttler — see every event). Fall back to the
    // explicit bus, or allocate a fresh one for self-contained tests.
    this.eventBus = eventBus ?? ctx.events ?? new SshServerEventBus();
  }

  get events(): ISshServerEventBus {
    return this.eventBus;
  }

  register(conn: TcpConnection, clientIp: string): void {
    const ms = this.ctx.config.maxStartups;
    if (ms && ms.start > 0) {
      const slot = preauthSlot(this.ctx);
      const n = slot.value;
      let refuse = false;
      if (n >= ms.full) refuse = true;
      else if (n >= ms.start) {
        const p = ms.rate / 100;
        refuse = Math.random() < p;
      }
      if (refuse) {
        conn.write(JSON.stringify({ op: 'disconnect', reason: 'max_startups' }));
        conn.close();
        this.eventBus.emit({
          kind: 'client_disconnected',
          user: '', ip: clientIp,
          reason: 'too_many_failures',
          timestamp: Date.now(),
        });
        return;
      }
    }
    this.eventBus.emit({
      kind: 'client_connected',
      ip: clientIp,
      timestamp: Date.now(),
    });
    // Reactive guard: throttled IPs are dropped at connect time. The bus
    // already carries the auth_throttled event, so the logger has written
    // an entry; here we just refuse the handshake.
    if (this.ctx.isClientBlocked?.(clientIp)) {
      conn.write(
        JSON.stringify({ op: 'disconnect', reason: 'throttled' }),
      );
      conn.close();
      this.eventBus.emit({
        kind: 'client_disconnected',
        user: '',
        ip: clientIp,
        reason: 'throttled',
        timestamp: Date.now(),
      });
      return;
    }
    this.handleConnection(conn, clientIp);
  }

  private handleConnection(conn: TcpConnection, clientIp: string): void {
    const channels = new Map<number, OpenChannelInfo>();
    const sftpWireSessions = new Map<number, SftpWireSession>();
    let userCtx: SshUserContext | null = null;
    let authFailures = 0;
    const preauth = preauthSlot(this.ctx);
    preauth.value += 1;
    let preauthDecremented = false;
    const decPreauth = () => { if (!preauthDecremented) { preauth.value = Math.max(0, preauth.value - 1); preauthDecremented = true; } };

    const timers = new TimerSet(() => getDefaultScheduler());
    let keepaliveTimer: symbol | null = null;
    let graceTimer: symbol | null = null;
    let missedAcks = 0;
    const intervalSec = this.ctx.config.clientAliveInterval ?? 0;
    const maxMissed = this.ctx.config.clientAliveCountMax ?? 0;
    const graceSec = this.ctx.config.loginGraceTime ?? 0;
    if (graceSec > 0) {
      graceTimer = timers.setTimeout(() => {
        if (userCtx) return;
        this.eventBus.emit({
          kind: 'client_disconnected',
          user: '',
          ip: clientIp,
          reason: 'auth_grace_timeout',
          timestamp: Date.now(),
        });
        conn.close();
      }, graceSec * 1000);
    }
    if (intervalSec > 0 && maxMissed > 0) {
      keepaliveTimer = timers.setInterval(() => {
        missedAcks += 1;
        if (missedAcks > maxMissed) {
          this.eventBus.emit({
            kind: 'client_disconnected',
            user: userCtx?.username ?? '',
            ip: clientIp,
            reason: 'client-alive-timeout',
            timestamp: Date.now(),
          });
          conn.close();
          return;
        }
        try { conn.write(JSON.stringify({ op: 'keepalive', seq: missedAcks })); }
        catch { /* socket closed mid-tick */ }
      }, intervalSec * 1000);
    }

    // `exec-timeout` on a network CLI's VTY line: the SERVER hangs an idle
    // EXEC session up, exactly as IOS does — the client only ever learns
    // of it by having its socket closed under it. Re-armed on every line,
    // so activity keeps the line alive.
    let idleTimer: ReturnType<TimerSet['setTimeout']> | null = null;
    const rearmExecIdle = (): void => {
      if (idleTimer !== null) timers.clear(idleTimer);
      idleTimer = null;
      const ms = this.ctx.execIdleTimeoutMs?.() ?? null;
      if (ms == null || ms <= 0) return;
      idleTimer = timers.setTimeout(() => {
        this.eventBus.emit({
          kind: 'client_disconnected',
          user: userCtx?.username ?? '',
          ip: clientIp,
          reason: 'exec_timeout',
          timestamp: Date.now(),
        });
        try { conn.write(JSON.stringify({ op: 'disconnect', reason: 'exec-timeout' })); }
        catch { /* socket already gone */ }
        conn.close();
      }, ms);
    };

    conn.onClose?.((reason) => {
      timers.clearAll();
      idleTimer = null;
      keepaliveTimer = null;
      decPreauth();
      for (const info of channels.values()) {
        info.offAsyncOutput?.();
        info.interactiveShell?.dispose();
        info.shell?.dispose?.();
      }
      channels.clear();
      sftpWireSessions.clear();
      this.eventBus.emit({
        kind: 'client_disconnected',
        user: userCtx?.username ?? '',
        ip: clientIp,
        reason: reason === 'rst' ? 'reset' : 'closed',
        timestamp: Date.now(),
      });
      userCtx = null;
    });

    // §2.1.20/P19 — real SSH_FXP_* wire frames arrive as a `\0`-tagged
    // binary sub-channel message (SftpChannelFraming.ts), which can never
    // collide with the JSON `{op, ...}` control messages every other case
    // below still uses (JSON.stringify always starts with `{`). Handled
    // first, before any JSON.parse is attempted, and short-circuits.
    const handleSftpWireFrame = (data: string): void => {
      const { channelId, wireBytes } = decodeSftpChannelFrame(data);
      const pkt = decodeSftpWirePacket(wireBytes);
      if (!pkt || !userCtx) return;
      let session = sftpWireSessions.get(channelId);
      if (!session) {
        const fs = new PermissionCheckingFSDecorator(this.ctx.getFilesystem(userCtx), userCtx);
        session = new SftpWireSession({ vfs: fs, userCtx, rootPath: userCtx.homeDirectory });
        sftpWireSessions.set(channelId, session);
        // A real sshd logs the subsystem request as the channel opens.
        // This session is built on the first frame rather than by an
        // `open_channel` message, so this is the only place that can say
        // so — without it the REAL sftp channel was the unlogged one.
        this.eventBus.emit({
          kind: 'channel_opened',
          user: userCtx.username,
          channelType: 'sftp',
        });
      }
      const reply = session.handle(pkt);
      conn.write(encodeSftpChannelFrame(channelId, encodeSftpWirePacket(reply)));
    };

    conn.onData((data) => {
      if (isSftpChannelFrame(data)) {
        handleSftpWireFrame(data);
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      const op = parsed.op as string | undefined;
      if (!op) return;
      if (op === 'keepalive_ack') { missedAcks = 0; return; }

      switch (op) {
        case 'hello': {
          const protocolInfo = this.negotiateProtocol(parsed);
          const preAuthBanner = this.ctx.getBanner?.() ?? null;
          conn.write(
            JSON.stringify({
              hostKey: {
                algorithm: this.ctx.hostKey.algorithm,
                publicKey: this.ctx.hostKey.publicKey,
              },
              serverVersion: SSH_SERVER_IDENTIFICATION,
              clientVersion: protocolInfo.clientVersion,
              ...(preAuthBanner ? { preAuthBanner } : {}),
            }),
          );
          break;
        }

        case 'auth': {
          const cap = this.ctx.config.maxAuthTries;
          if (authFailures >= cap) {
            conn.write(JSON.stringify({ ok: false, ended: true, error: 'too many authentication failures' }));
            this.eventBus.emit({
              kind: 'auth_failure',
              user: (parsed.user as string | undefined) ?? '',
              reason: 'max_auth_tries',
              ip: clientIp,
              method: parsed.method as string | undefined,
            });
            conn.close();
            return;
          }
          void this.handleAuth(parsed, clientIp).then((result) => {
            if (result.ok) {
              conn.write(JSON.stringify({ ok: true }));
              userCtx = result.userCtx;
              this.ctx.recordLogin(result.userCtx.username, clientIp);
              timers.clear(graceTimer);
              graceTimer = null;
              decPreauth();
              return;
            }
            authFailures += 1;
            conn.write(JSON.stringify({ ok: false, ended: authFailures >= cap }));
            if (authFailures >= cap) {
              this.eventBus.emit({
                kind: 'auth_failure',
                user: (parsed.user as string | undefined) ?? '',
                reason: 'max_auth_tries',
                ip: clientIp,
                method: parsed.method as string | undefined,
              });
              conn.close();
            }
          });
          break;
        }

        case 'open_channel': {
          if (!userCtx) {
            conn.write(JSON.stringify({ ok: false, error: 'not authenticated' }));
            return;
          }
          if (channels.size >= this.ctx.config.maxSessions) {
            conn.write(JSON.stringify({ ok: false, error: 'open failed: administratively prohibited: too many open sessions' }));
            this.eventBus.emit({
              kind: 'auth_failure',
              user: userCtx.username,
              reason: 'max_sessions',
              ip: clientIp,
              method: 'open_channel',
            });
            return;
          }
          const channelType = parsed.channelType as ChannelType;
          const channelId = parsed.channelId as number;
          channels.set(channelId, {
            type: channelType,
            userCtx,
            cwd: userCtx.homeDirectory,
            openedAt: Date.now(),
          });
          this.eventBus.emit({
            kind: 'channel_opened',
            user: userCtx.username,
            channelType,
          });
          conn.write(JSON.stringify({ ok: true, channelId }));
          break;
        }

        case 'close_channel': {
          const channelId = parsed.channelId as number;
          const info = channels.get(channelId);
          if (info && userCtx) {
            this.eventBus.emit({
              kind: 'channel_closed',
              user: userCtx.username,
              channelType: info.type,
              durationMs: Date.now() - info.openedAt,
            });
          }
          info?.offAsyncOutput?.();
          info?.interactiveShell?.dispose();
          info?.shell?.dispose?.();
          channels.delete(channelId);
          sftpWireSessions.delete(channelId);
          break;
        }

        case 'exec': {
          // BRD SSH-05: non-interactive command execution. Also used by the
          // interactive shell sub-shell, which routes one exec per line.
          if (!userCtx) {
            conn.write(
              JSON.stringify({
                stdout: '',
                stderr: 'not authenticated',
                exitCode: 255,
              }),
            );
            return;
          }
          const command = (parsed.command as string | undefined) ?? '';
          const channelId = parsed.channelId as number | undefined;
          const cwd =
            (channelId !== undefined && channels.get(channelId)?.cwd) ||
            userCtx.homeDirectory;
          // A fresh, self-contained session per exec call (real ssh
          // exec-mode is its own one-shot session too) — disposed right
          // after so it doesn't leak a phantom `-bash` process-table entry.
          const shell = this.ctx.getShell(userCtx, cwd);
          // Real sshd treats every exec as a session: emit open/close so the
          // syslogger produces `session opened`/`session closed` lines.
          const sessionStart = Date.now();
          this.eventBus.emit({
            kind: 'channel_opened',
            user: userCtx.username,
            channelType: 'exec',
          });
          const userForClose = userCtx;
          void shell.execute(command).then((result) => {
            conn.write(JSON.stringify(result));
            shell.dispose?.();
            this.eventBus.emit({
              kind: 'channel_closed',
              user: userForClose.username,
              channelType: 'exec',
              durationMs: Date.now() - sessionStart,
            });
          });
          break;
        }

        case 'shell_open': {
          // Analysis doc §5 P4 — allocate a persistent shell session.
          if (!userCtx) {
            conn.write(JSON.stringify({ ok: false, error: 'not authenticated' }));
            return;
          }
          const channelId = parsed.channelId as number;
          const cwd =
            channels.get(channelId)?.cwd ?? userCtx.homeDirectory;
          channels.set(channelId, {
            type: 'shell',
            userCtx,
            cwd,
            openedAt: Date.now(),
            interactiveShell: this.ctx.createInteractiveShell?.(userCtx) ?? null,
            // One real per-channel shell (session-isolated identity/cwd),
            // created once here and reused for every shell_input line —
            // see LinuxSshServerContext.getShell(). `interactive: true`
            // since this is a real pty-like session (colorized output,
            // hung up on close), unlike a one-shot `exec`.
            shell: this.ctx.getShell(userCtx, cwd, { interactive: true }),
          });
          // A router talks back without being asked: `debug` traces and,
          // under `terminal monitor`, syslog. Pushing them as they happen
          // is the whole point — buffering them until the next keypress
          // is what made a `debug` over SSH look like it did nothing.
          const opened = channels.get(channelId);
          opened!.offAsyncOutput = opened?.shell?.subscribeAsyncOutput?.((text) => {
            try {
              conn.write(JSON.stringify({
                op: 'shell_output',
                channelId,
                chunk: text.endsWith('\n') ? text : `${text}\n`,
              }));
            } catch { /* socket closed under the subscription */ }
          });
          this.eventBus.emit({
            kind: 'channel_opened',
            user: userCtx.username,
            channelType: 'shell',
          });
          rearmExecIdle();
          conn.write(JSON.stringify({
            ok: true,
            channelId,
            // Capability advertised at open time: `?` is a help key on a
            // network CLI, an ordinary glob character on a POSIX shell.
            inlineHelp: channels.get(channelId)?.shell?.supportsInlineHelp === true,
            // The remote's prompt before a single line has run, so a
            // client shows `R1>` or `C:\Users\User>` from the moment it
            // lands rather than guessing a bash shape
            // (docs/PRD-SSH-Unification.md §4bis B4).
            prompt: channels.get(channelId)?.shell?.getPrompt?.(),
            posixShell: channels.get(channelId)?.shell?.posixShell !== false,
          }));
          break;
        }

        case 'shell_input': {
          if (!userCtx) {
            conn.write(
              JSON.stringify({
                stdout: '',
                stderr: 'not authenticated',
                exitCode: 255,
                channelId: parsed.channelId,
              }),
            );
            return;
          }
          const channelId = parsed.channelId as number;
          const info = channels.get(channelId);
          const line = (parsed.data as string | undefined) ?? '';
          rearmExecIdle();

          // Try the real-time job runtime first (e.g. `ping`): output
          // streams over the wire as `shell_output` pushes while the job
          // runs, and the final `shell_input` reply (empty stdout/stderr)
          // is sent only once the job completes or is Ctrl+C-interrupted.
          const started = info?.interactiveShell?.tryStartStreaming(line, {
            onChunk: (text) => {
              try {
                conn.write(JSON.stringify({ op: 'shell_output', channelId, chunk: text }));
              } catch { /* socket closed mid-job */ }
            },
            onDone: () => {
              try {
                conn.write(JSON.stringify({ stdout: '', stderr: '', exitCode: 0, channelId }));
              } catch { /* socket closed mid-job */ }
            },
          }) ?? false;
          if (started) break;

          // Reuse the channel's own persistent shell (real per-session
          // identity/cwd) rather than calling getShell() fresh — a fresh
          // call would allocate a brand-new session every line, losing
          // cwd/su-stack continuity. Falls back to a fresh one-shot shell
          // only if shell_input somehow arrives without a prior shell_open.
          const shell = info?.shell ?? this.ctx.getShell(userCtx, info?.cwd ?? userCtx.homeDirectory);
          void shell.execute(line).then((result) => {
            // Read the prompt AFTER the line ran: `cd`, `enable` and
            // `configure terminal` all change it.
            const prompt = shell.getPrompt?.();
            const nested = shell.isNested?.() ?? false;
            conn.write(JSON.stringify({ ...result, prompt, nested, channelId }));
          });
          break;
        }

        case 'shell_input_value': {
          const channelId = parsed.channelId as number;
          const info = channels.get(channelId);
          const shell = info?.shell;
          if (!userCtx || !shell?.provideInput) {
            conn.write(JSON.stringify({ stdout: '', stderr: '', exitCode: 0, channelId }));
            break;
          }
          void shell.provideInput(typeof parsed.data === 'string' ? parsed.data : '')
            .then((result) => {
              conn.write(JSON.stringify({
                ...result,
                prompt: shell.getPrompt?.(),
                nested: shell.isNested?.() ?? false,
                channelId,
              }));
            });
          break;
        }

        case 'shell_complete': {
          const channelId = parsed.channelId as number;
          const info = channels.get(channelId);
          if (!userCtx) {
            conn.write(JSON.stringify({ op: 'shell_complete_result', channelId, candidates: [] }));
            break;
          }
          // Answered by the channel's own shell so candidates carry its
          // cwd / CLI mode; a channel without one simply offers nothing.
          const line = typeof parsed.data === 'string' ? parsed.data : '';
          const candidates = info?.shell?.getCompletions?.(line) ?? [];
          conn.write(JSON.stringify({ op: 'shell_complete_result', channelId, candidates }));
          break;
        }

        case 'editor_open': {
          const channelId = parsed.channelId as number;
          const info = channels.get(channelId);
          const commandLine = typeof parsed.data === 'string' ? parsed.data : '';
          const session = userCtx ? info?.shell?.openEditor?.(commandLine) ?? null : null;
          if (info) info.editor = session ?? undefined;
          conn.write(JSON.stringify({
            op: 'editor_view', channelId, view: session ? session.view : null,
          }));
          break;
        }

        case 'editor_key': {
          const channelId = parsed.channelId as number;
          const info = channels.get(channelId);
          const editor = info?.editor;
          if (!editor) {
            conn.write(JSON.stringify({ op: 'editor_view', channelId, view: null }));
            break;
          }
          const view = editor.applyKey(parsed.key as EditorKeyInput);
          // The buffer is gone once the engine exits: drop the session so
          // the next line goes back to the shell.
          if (view.exited) info.editor = undefined;
          conn.write(JSON.stringify({ op: 'editor_view', channelId, view }));
          break;
        }

        case 'editor_paste':
        case 'editor_cursor': {
          const channelId = parsed.channelId as number;
          const editor = channels.get(channelId)?.editor;
          const view = parsed.op === 'editor_paste'
            ? editor?.applyPaste?.(typeof parsed.data === 'string' ? parsed.data : '')
            : editor?.moveCursorToDisplayOffset?.(
                typeof parsed.offset === 'number' ? parsed.offset : 0,
              );
          conn.write(JSON.stringify({ op: 'editor_view', channelId, view: view ?? null }));
          break;
        }

        case 'editor_close': {
          const channelId = parsed.channelId as number;
          const info = channels.get(channelId);
          info?.editor?.close();
          if (info) info.editor = undefined;
          break;
        }

        case 'shell_close': {
          const channelId = parsed.channelId as number;
          const info = channels.get(channelId);
          if (info && userCtx) {
            this.eventBus.emit({
              kind: 'channel_closed',
              user: userCtx.username,
              channelType: info.type,
              durationMs: Date.now() - info.openedAt,
            });
            // Pair with the recordLogin fired in `auth` — once the last
            // channel closes the session is over from the user's point
            // of view, so record the logout. Linux uses this to append
            // wtmp; Windows turns it into a 4634 (Logoff) Security event.
            this.ctx.recordLogout?.(userCtx.username, clientIp);
          }
          info?.offAsyncOutput?.();
          info?.interactiveShell?.dispose();
          info?.shell?.dispose?.();
          channels.delete(channelId);
          conn.write(JSON.stringify({ ok: true, channelId }));
          break;
        }

        case 'shell_signal': {
          // Ctrl+C over the wire: interrupt the channel's running
          // foreground job, if any (no-op otherwise).
          const channelId = parsed.channelId as number;
          channels.get(channelId)?.interactiveShell?.interruptForeground();
          break;
        }

        case 'shell_resize': {
          // Cosmetic — we don't model a real PTY but emit a hook event
          // so subscribers (syslogger, tests) can see resize traffic.
          break;
        }

        default: {
          // Treat as SFTP command if user is authenticated.
          if (!userCtx) {
            conn.write(JSON.stringify({ ok: false, error: 'not authenticated' }));
            return;
          }
          const channelId = (parsed.channelId as number | undefined) ?? -1;
          let info = channels.get(channelId);
          if (!info && channelId >= 0) {
            info = { type: 'sftp', userCtx, cwd: userCtx.homeDirectory, openedAt: Date.now() };
            channels.set(channelId, info);
          }
          const cwd = info?.cwd ?? userCtx.homeDirectory;
          const fs = new PermissionCheckingFSDecorator(
            this.ctx.getFilesystem(userCtx),
            userCtx,
          );
          const result = this.dispatcher.dispatch(
            op,
            parsed as unknown as SftpRequestPayload,
            { vfs: fs, userCtx, cwd },
          );
          if (isOk(result)) {
            const payload = (result.value as object) ?? {};
            const newCwd = (payload as { cwd?: unknown }).cwd;
            if (info && typeof newCwd === 'string') info.cwd = newCwd;
            conn.write(JSON.stringify({ ok: true, ...payload }));
          } else if (isErr(result)) {
            conn.write(
              JSON.stringify({ ok: false, error: errorToMessage(result.error) }),
            );
          }
        }
      }
    });
  }

  private negotiateProtocol(payload: Record<string, unknown>): ProtocolInfo {
    return {
      clientVersion:
        (payload.clientVersion as string | undefined) ?? 'SSH-2.0-Unknown',
    };
  }

  private async handleAuth(
    payload: Record<string, unknown>,
    clientIp: string,
  ): Promise<
    | { ok: false }
    | { ok: true; userCtx: SshUserContext }
  > {
    const method = payload.method as string | undefined;
    const user = (payload.user as string | undefined) ?? '';
    const password = (payload.password as string | undefined) ?? '';

    // Reactive throttler check: refuse before consulting auth.
    if (this.ctx.isClientBlocked?.(clientIp, user)) {
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: 'throttled',
        ip: clientIp,
        method,
      });
      return { ok: false };
    }

    // Root-login policy is a separate reason from a generic auth failure.
    if (user === 'root' && !this.ctx.config.permitRootLogin) {
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: 'root_login_disabled',
        ip: clientIp,
        method,
      });
      this.ctx.recordAuthFailure?.(user, clientIp, 'root login disabled');
      return { ok: false };
    }

    // OpenSSH emits a distinct "Invalid user" line when the principal does
    // not exist on the system. We mirror that by checking buildUserContext
    // before any credential validation.
    const userExists = this.ctx.buildUserContext(user) !== null;
    if (!userExists) {
      this.eventBus.emit({
        kind: 'auth_invalid_user',
        user,
        ip: clientIp,
        timestamp: Date.now(),
      });
      // We still consult the auth context so the throttler counts the
      // failure and the response timing matches a real bad password attempt.
      // (Real sshd does the same for the same reason: side-channel hardening.)
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: 'invalid_user',
        ip: clientIp,
        method,
      });
      return { ok: false };
    }

    // PermitEmptyPasswords gate (cheaper than calling the user DB).
    if (
      method === 'password' &&
      password.length === 0 &&
      this.ctx.permitEmptyPasswords?.() === false
    ) {
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: 'empty_password_disabled',
        ip: clientIp,
        method,
      });
      return { ok: false };
    }

    let success = false;
    if (method === 'password') {
      success = this.ctx.config.passwordAuthentication && (
        this.ctx.auth.checkPasswordAsync
          ? await this.ctx.auth.checkPasswordAsync(user, password)
          : this.ctx.auth.checkPassword(user, password)
      );
    } else if (method === 'publickey') {
      success =
        this.ctx.config.pubkeyAuthentication &&
        this.ctx.auth.checkPublicKey(user, (payload.publicKey as string) ?? '');
    }
    if (!success) {
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: method === 'password' ? 'wrong_password' : 'wrong_key',
        ip: clientIp,
        method,
      });
      this.ctx.recordAuthFailure?.(user, clientIp, method ?? 'unknown');
      return { ok: false };
    }

    const lifecycle: AccountLifecycleVerdict =
      this.ctx.auth.checkAccountLifecycle?.(user) ?? { ok: true };
    if (!lifecycle.ok) {
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: lifecycle.kind === 'account-expired' ? 'account_expired' : 'password_expired',
        ip: clientIp,
        method,
      });
      if (lifecycle.kind === 'password-expired') {
        this.eventBus.emit({ kind: 'auth_account_phase', user, ip: clientIp });
      }
      this.ctx.recordAuthFailure?.(user, clientIp, lifecycle.kind);
      return { ok: false };
    }

    this.eventBus.emit({
      kind: 'auth_success',
      user,
      method: method ?? 'unknown',
      ip: clientIp,
      timestamp: Date.now(),
    });
    const userCtx =
      this.ctx.buildUserContext(user) ??
      new SshUserContext(user, 1000, 1000, [], `/home/${user}`);
    return { ok: true, userCtx };
  }
}

/**
 * BRD SFTP-07: normalise underlying errors into OpenSSH-style short
 * messages. The client (`SftpSession`) wraps those into the full
 * "Couldn't … : <msg>" / "remote open(\"<path>\"): <msg>" sentences.
 */
function errorToMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const e = error as { kind?: string; message?: string; path?: string };

  if (e.kind === 'PERMISSION_DENIED') return 'Permission denied';
  if (e.kind === 'NOT_AUTHENTICATED') return 'not authenticated';
  if (e.kind === 'INVALID_ARGUMENT') return e.message ?? 'invalid argument';
  if (e.kind === 'UNKNOWN_OP') return 'Unknown SFTP op';

  if (e.kind === 'IO_ERROR') {
    const msg = (e.message ?? '').toLowerCase();
    if (msg.includes('no such') || msg.includes('not found') || msg.includes('cannot read')) {
      return 'No such file or directory';
    }
    if (msg.includes('parent') && msg.includes('does not exist')) {
      return 'No such file or directory';
    }
    if (msg.includes('is a directory') || msg.includes('not a directory')) {
      return 'Failure';
    }
    if (msg.includes('already exists') || msg.includes('file exists')) {
      return 'File exists';
    }
    if (msg.includes('write failed') || msg.includes('permission')) {
      return 'Permission denied';
    }
    if (msg.includes('rmdir failed') || msg.includes('rm failed')) {
      return 'Failure';
    }
    if (msg.includes('rename')) return 'Failure';
    return e.message ?? 'Failure';
  }

  return e.message ?? e.kind ?? 'error';
}
