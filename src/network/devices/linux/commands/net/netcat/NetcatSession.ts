import type { LinuxCommandContext } from '../../LinuxCommandContext';
import { listenForInterruption } from '../../CommandInterruption';
import type { NetcatOptions } from './NetcatArguments';

type Stream = 'stdout' | 'stderr';

export interface NcResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly combined: string;
  readonly exitCode: number;
}

export class NcOutput {
  private readonly chunks: { stream: Stream; text: string; raw: boolean }[] = [];

  write(stream: Stream, text: string): void {
    this.chunks.push({ stream, text, raw: false });
  }

  writeRaw(text: string): void {
    this.chunks.push({ stream: 'stdout', text, raw: true });
  }

  finish(exitCode: number): NcResult {
    const stderr = this.chunks.filter((c) => c.stream === 'stderr').map((c) => c.text).join('\n');
    const stdout = this.chunks.filter((c) => c.stream === 'stdout').map((c) => (c.raw ? c.text : `${c.text}\n`)).join('');
    const combined = this.chunks.map((c) => (c.raw ? c.text.replace(/\r?\n$/, '') : c.text)).join('\n');
    return { stdout, stderr, combined, exitCode };
  }
}

export function wireText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  return chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : '';
}

export function linesOf(payload: string): string[] {
  return payload.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

export interface Peer {
  write(text: string): void;
  close(): void;
  shutdownWrite?(): void;
  refused?(): boolean;
  onData?(handler: (text: string) => void): () => void;
  onEnd?(handler: () => void): () => void;
  onClose?(handler: () => void): () => void;
}

export function converse(
  ctx: LinuxCommandContext, pid: number, peer: Peer, opts: NetcatOptions, stdin: string | undefined, out: NcOutput,
): Promise<number | null> {
  const background = ctx.executor.isBackgroundJob(pid);
  const terminal = stdin === undefined && !background;
  const payload = opts.detach ? '' : (opts.crlf ? (stdin ?? '').replace(/\n/g, '\r\n') : stdin ?? '');
  const interruption = listenForInterruption(ctx);
  let received = '';
  return new Promise<number | null>((resolve) => {
    const timers: Array<() => void> = [];
    const watchers: Array<() => void> = [];
    let idle: (() => void) | null = null;
    let settled = false;
    let quitting = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      idle?.();
      for (const cancel of timers) cancel();
      for (const stop of watchers) stop();
      interruption.release();
      peer.close();
      if (!background && received !== '') out.writeRaw(received);
      if (background) ctx.executor.processMgr.exit(pid, interruption.exitStatus() ?? 0);
      resolve(interruption.exitStatus());
    };
    const after = (ms: number, then: () => void): (() => void) => {
      const cancel = ctx.executor.scheduleAfter(ms, then);
      timers.push(cancel);
      return cancel;
    };
    const armIdle = (): void => {
      if (opts.timeoutMs <= 0 || settled) return;
      idle?.();
      idle = after(opts.timeoutMs, finish);
    };
    interruption.signal.addEventListener('abort', finish, { once: true });
    if (peer.onData) {
      watchers.push(peer.onData((text) => {
        if (background) ctx.executor.emitLateStdout(pid, text);
        else received += text;
        armIdle();
      }));
    }
    const peerGone = (): void => { if (!quitting) finish(); };
    if (peer.onEnd) watchers.push(peer.onEnd(peerGone));
    if (peer.onClose) watchers.push(peer.onClose(peerGone));
    if (settled) return;
    armIdle();
    if (background) ctx.executor.announceBackgroundRunning(pid);
    void (async () => {
      const pieces = opts.intervalSeconds > 0 ? linesOf(payload) : payload === '' ? [] : [payload];
      for (const piece of pieces) {
        if (opts.intervalSeconds > 0) await new Promise<void>((resume) => { after(opts.intervalSeconds * 1000, resume); });
        if (settled) return;
        peer.write(piece);
        armIdle();
      }
      if (settled) return;
      if (terminal || (peer.refused?.() === true && opts.quitSeconds < 0)) {
        finish();
        return;
      }
      quitting = opts.quitSeconds > 0;
      if (opts.shutdownWrite) (peer.shutdownWrite ?? peer.close).call(peer);
      if (opts.quitSeconds === 0) finish();
      else if (quitting) after(opts.quitSeconds * 1000, finish);
    })();
  });
}

export function announceListening(ctx: LinuxCommandContext, out: NcOutput, line: string): void {
  const pid = ctx.executor.currentPid();
  if (ctx.executor.isBackgroundJob(pid)) ctx.executor.emitLateStderr(pid, `${line}\n`);
  else out.write('stderr', line);
}
