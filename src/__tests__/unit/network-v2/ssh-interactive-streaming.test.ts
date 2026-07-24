/**
 * SSH interactive shell — real-wire streaming + Ctrl+C interrupt (P1).
 *
 * Before this, `shell_input` was a single request/response round trip:
 * the server ran `shell.execute(line)` once and sent back one
 * `{stdout, stderr, exitCode}` reply — so a streaming command like `ping`
 * could never behave interactively over SSH; only the in-memory
 * `createSessionForDevice()` bypass in
 * `LinuxTerminalSession.connectAndEnterSsh()` could fake that richness by
 * skipping the wire entirely. `SshInteractiveShell` (server, per-channel
 * job runtime) + `SshInteractiveSubShell` (client `ISubShell`) replace
 * that bypass for Linux↔Linux sessions: `ping` output now streams over
 * real `shell_output` wire pushes while the job runs server-side, and
 * Ctrl+C sends a real `shell_signal` message that actually stops it.
 *
 * T1: `ping -c N` streams multiple onData chunks before runLine() resolves.
 * T2: sendSignal('SIGINT') interrupts an in-flight unbounded ping —
 *     runLine() resolves and ping statistics are pushed.
 * T3: plain one-shot commands still round-trip correctly, and cwd
 *     persists server-side across calls on the same persistent channel
 *     (no client-side `cd`-prefixing trick involved).
 * T4: LinuxTerminalSession.connectAndEnterSsh() lands Linux targets on
 *     SshInteractiveSubShell (not the in-memory bypass), and driving it
 *     through real keystrokes streams ping and honours Ctrl+C.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { isOk } from '@/network/protocols/ssh/Result';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { SshInteractiveSubShell } from '@/terminal/subshells/SshInteractiveSubShell';
import {
  buildLan,
  assignIps,
  openSshSession,
  type SshLan,
  PC2_IP,
  PC3_IP,
} from './ssh-lan-fixtures';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await tick();
  }
}

describe('SSH interactive shell — real-wire streaming + Ctrl+C', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    Equipment.clearRegistry();
    lan = buildLan();
    await assignIps(lan);
  });

  it('T1 — ping streams multiple reply chunks over the wire before runLine() resolves', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const channelResult = session.openShellChannel();
    if (!isOk(channelResult)) throw new Error('shell channel failed');
    const channel = channelResult.value;
    const chunks: string[] = [];
    channel.onData((d) => chunks.push(d));

    await channel.runLine(`ping -c 3 ${PC3_IP}`);

    const replies = chunks.filter((c) => /bytes from/.test(c));
    // Real streaming means each reply arrived as its own wire push, not
    // batched into a single final message.
    expect(replies.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => /ping statistics/.test(c))).toBe(true);

    channel.close();
    session.disconnect();
  }, 15000);

  it('T2 — sendSignal(SIGINT) interrupts an in-flight ping and resolves runLine()', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const channelResult = session.openShellChannel();
    if (!isOk(channelResult)) throw new Error('shell channel failed');
    const channel = channelResult.value;
    const chunks: string[] = [];
    channel.onData((d) => chunks.push(d));

    const donePromise = channel.runLine(`ping ${PC3_IP}`);
    await waitFor(() => chunks.some((c) => /bytes from/.test(c)));
    channel.sendSignal('SIGINT');
    await donePromise;

    expect(chunks.some((c) => /ping statistics/.test(c))).toBe(true);

    channel.close();
    session.disconnect();
  }, 15000);

  it('T3 — plain commands still round-trip, and cwd persists server-side across calls', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const channelResult = session.openShellChannel();
    if (!isOk(channelResult)) throw new Error('shell channel failed');
    const channel = channelResult.value;

    const whoami = await channel.runLine('whoami');
    expect(whoami.stdout + whoami.stderr).toMatch(/user/);

    await channel.runLine('cd /tmp');
    const pwd = await channel.runLine('pwd');
    expect((pwd.stdout || '').trim()).toBe('/tmp');

    channel.close();
    session.disconnect();
  });

  it('T4 — connectAndEnterSsh() lands Linux targets on the real-wire subshell, and ping streams + Ctrl+C works', async () => {
    const host = new LinuxTerminalSession('term-1', lan.pc1);
    await host.init?.();

    host.setInput(`ssh user@${PC2_IP}`);
    host.handleKey(key('Enter'));
    for (let i = 0; i < 40 && host.currentInputMode.type !== 'password'; i++) await tick();
    expect(host.currentInputMode.type).toBe('password');
    host.setPasswordBuf('admin');
    host.handleKey(key('Enter'));

    await waitFor(() => {
      const sub = (host as unknown as { activeSubShell: unknown }).activeSubShell;
      return sub instanceof SshInteractiveSubShell;
    });
    // The real-wire subshell replaces the old in-memory bypass — no child
    // session is pushed, so `foreground` stays the host itself.
    expect(host.foreground).toBe(host);

    host.setInput(`ping ${PC3_IP}`);
    host.setInputBuf(`ping ${PC3_IP}`);
    host.handleKey(key('Enter'));
    await waitFor(() => host.lines.some((l) => /bytes from/.test(l.text)));

    host.handleKey(key('c', { ctrlKey: true }));
    await waitFor(() => host.lines.some((l) => /ping statistics/.test(l.text)));
  }, 15000);
});
