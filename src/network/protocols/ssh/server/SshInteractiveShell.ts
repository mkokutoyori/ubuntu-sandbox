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
import type { LinuxShellSession } from '@/network/devices/linux/shell/LinuxShellSession';
import { planLinuxStream } from '@/terminal/streams/LinuxStreamPlans';
import { SCREEN_REPAINT_MARK } from './SshScreenRepaint';

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
  session?: unknown;
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
    if (/[|<>&;]/.test(line)) return false;
    const session = hooks.session as LinuxShellSession | undefined;
    if (session === undefined) return false;
    const plan = planLinuxStream(this.device, session, line, {
      mark: () => {},
      beginFrame: () => hooks.onChunk(SCREEN_REPAINT_MARK),
    });
    if (plan === null) return false;
    this.hooks = hooks;
    if (plan.kind === 'notice') {
      for (const text of plan.lines) hooks.onChunk(text);
      hooks.onDone();
      return true;
    }
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      hooks.onDone();
    };
    const started = this.runtime.start({
      mode: 'foreground',
      kind: plan.jobKind,
      command: line,
      prepare: plan.prepare,
      run: async (ctx) => {
        try { await plan.run(ctx); } finally { finish(); }
      },
      onInterrupt: plan.onInterrupt,
    });
    return started !== null;
  }
}
