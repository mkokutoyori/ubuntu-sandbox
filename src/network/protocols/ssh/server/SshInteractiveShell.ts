/**
 * SshInteractiveShell — server-side per-channel state for a real
 * interactive SSH shell (RFC 4254 §6.5/6.7 "shell" channel, simplified
 * to this simulator's line-oriented wire protocol).
 *
 * Before this, `shell_input` was a single request/response round trip:
 * one line in, one `{stdout, stderr, exitCode}` reply out — so a command
 * like `ping` (which streams replies over time and is meant to keep
 * running until Ctrl+C) could never be driven interactively over SSH;
 * only the in-memory `createSessionForDevice()` bypass could do that.
 *
 * This class reuses the SAME `TerminalAsyncRuntime` the local terminal
 * uses for streaming/backgroundable commands, just with bindings that
 * push each line over the wire (`shell_output`) instead of appending to
 * a UI session's own `lines` array — so `ping`/`ping6` now stream for
 * real over an authenticated SSH channel, and Ctrl+C (`shell_signal`)
 * genuinely interrupts the remote job rather than only clearing local
 * input. Every other command still goes through the existing
 * `ILinuxShell.execute()` single-round-trip path, unchanged.
 */

import { LinuxMachine } from '@/network/devices/LinuxMachine';
import { TerminalAsyncRuntime } from '@/terminal/async/TerminalAsyncRuntime';
import type { AsyncJobContext } from '@/terminal/async/types';
import type { PingResult } from '@/network/devices/EndHost';
import { parsePingArgs } from '@/network/devices/linux/commands/net/Ping';
import {
  formatPingHeader, formatPing6Header, formatPingReplyLine, formatPingStats,
} from '@/network/devices/linux/LinuxFormatHelpers';

export interface SshInteractiveShellHooks {
  /** A line of output produced while a streaming job is running. */
  onChunk: (text: string) => void;
  /**
   * The job has finished (naturally or via `interruptForeground()`) and
   * produced its last `onChunk`. The caller uses this to send the final
   * wire reply that resolves the client's still-pending `runLine()`
   * promise — every chunk has already been delivered by this point, so
   * that reply carries empty stdout/stderr.
   */
  onDone: () => void;
}

/**
 * One instance per open `shell` channel. `device` may be any Equipment;
 * streaming is only attempted for `LinuxMachine` targets (Cisco/Huawei/
 * Windows remote shells don't go through this path at all yet).
 */
export class SshInteractiveShell {
  private readonly runtime: TerminalAsyncRuntime;
  private hooks: SshInteractiveShellHooks | null = null;

  constructor(private readonly device: unknown) {
    this.runtime = new TerminalAsyncRuntime({
      addLine: (text) => this.hooks?.onChunk(text),
      addLines: (texts) => { for (const t of texts) this.hooks?.onChunk(t); },
      notify: () => { /* no UI to notify server-side */ },
      attachStream: (opts) => ({ id: 'ssh-shell', description: opts.description, active: true, cancel: () => {} }),
    });
  }

  get hasForegroundJob(): boolean {
    return this.runtime.hasForegroundJob;
  }

  /** Ctrl+C over the wire (`shell_signal`): interrupt the running foreground job, if any. */
  interruptForeground(): boolean {
    return this.runtime.interruptForeground();
  }

  dispose(): void {
    this.runtime.cancelAll();
  }

  /**
   * Attempt to start `line` as a real-time streaming job (currently:
   * `ping`/`ping6`). Returns true if recognized and started — output
   * will arrive via `hooks.onChunk` until the job completes or is
   * interrupted. Returns false for every other command, so the caller
   * should fall back to the plain `ILinuxShell.execute(line)` round trip.
   */
  tryStartStreaming(line: string, hooks: SshInteractiveShellHooks): boolean {
    if (this.runtime.hasForegroundJob) return false;
    if (!(this.device instanceof LinuxMachine)) return false;
    const toks = line.trim().split(/\s+/);
    if (toks[0] !== 'ping') return false;
    if (/[|<>&]/.test(line)) return false;
    const parsed = parsePingArgs(toks.slice(1), 'ping');
    if (!parsed.targetStr) return false;

    this.hooks = hooks;
    const dev = this.device;
    // Same "no -c given => unbounded" convention as the local terminal's
    // tryStartPingStream() (LinuxTerminalSession.ts) — real Linux ping has
    // no Windows-style -t; an omitted -c means continuous until Ctrl+C.
    const streamCount = parsed.countGiven ? parsed.count : 0;
    const deadlineAtMs = parsed.deadlineMs !== undefined ? Date.now() + parsed.deadlineMs : null;
    const deadlineHit = () => deadlineAtMs !== null && Date.now() >= deadlineAtMs;

    let targetLabel = parsed.targetStr;
    const results: PingResult[] = [];
    const emitStats = (ctx: AsyncJobContext) => {
      for (const l of formatPingStats(targetLabel, results.length, results)) ctx.sink.line(l);
    };

    const job = this.runtime.start({
      mode: 'foreground',
      kind: 'streaming',
      command: line,
      run: async (ctx) => {
        const outcome = parsed.v6
          ? await dev.ping6StreamInSession(parsed.targetStr, {
              count: streamCount, timeoutMs: parsed.timeoutMs, intervalMs: parsed.intervalMs,
              onResolved: (ip) => { targetLabel = ip.toString(); ctx.sink.line(formatPing6Header(ip, parsed.size, parsed.targetStr !== ip.toString() ? parsed.targetStr : undefined)); },
              onResult: (r) => { results.push(r); const l = formatPingReplyLine(r, parsed.size); if (l !== null) ctx.sink.line(l); },
              shouldStop: () => ctx.cancelled() || deadlineHit(),
              sleep: (ms) => ctx.delay(ms),
            })
          : await dev.pingStreamInSession(parsed.targetStr, {
              count: streamCount, timeoutMs: parsed.timeoutMs, ttl: parsed.ttl, intervalMs: parsed.intervalMs,
              onResolved: (ip) => { targetLabel = ip.toString(); ctx.sink.line(formatPingHeader(ip, parsed.size, parsed.targetStr !== ip.toString() ? parsed.targetStr : undefined)); },
              onResult: (r) => { results.push(r); const l = formatPingReplyLine(r, parsed.size); if (l !== null) ctx.sink.line(l); },
              shouldStop: () => ctx.cancelled() || deadlineHit(),
              sleep: (ms) => ctx.delay(ms),
            });
        if (ctx.cancelled()) return;
        if (!outcome.resolved && results.length === 0) {
          const cmdName = parsed.v6 ? 'ping6' : 'ping';
          ctx.sink.error(outcome.reason === 'name'
            ? `${cmdName}: ${parsed.targetStr}: Name or service not known`
            : (parsed.v6 ? 'connect: Network is unreachable' : 'ping: connect: Network is unreachable'));
          hooks.onDone();
          return;
        }
        emitStats(ctx);
        hooks.onDone();
      },
      onInterrupt: (ctx) => { emitStats(ctx); hooks.onDone(); },
    });
    return job !== null;
  }
}
