/**
 * SSH LAN — `ssh -t` PTY allocation + persistent shell channel (P4).
 *
 * Scope:
 *  - T1..T4 : parser support for `-t`, `-T`, `-tt`, default.
 *  - T5     : SshConnectOptionsBuilder propagates requestTty + forceTty.
 *  - T6     : SshShellChannel opens via `op:'shell_open'` and the server
 *             allocates a persistent shell session keyed by channelId.
 *  - T7     : `op:'shell_input'` dispatches to ctx.getShell().execute()
 *             and emits the result back.
 *  - T8     : Closing the shell channel emits a `channel_closed` event.
 *  - T9     : Inline `ssh -t host cmd` prints the OpenSSH-style
 *             "Pseudo-terminal will be allocated…" notice.
 *
 * Reference: SSH-IMPLEMENTATION-ANALYSIS.md §5 P4.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { parseSshArgs } from '@/terminal/sessions/sshArgs';
import {
  SshConnectOptionsBuilder,
} from '@/network/protocols/ssh/SshConnectOptions';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import {
  buildLan,
  assignIps,
  openSshSession,
  type SshLan,
  PC2_IP,
} from './ssh-lan-fixtures';
import { isOk } from '@/network/protocols/ssh/Result';

describe('SSH LAN — PTY shell channel (`ssh -t`)', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    Equipment.clearRegistry();
    lan = buildLan();
    await assignIps(lan);
  });

  // ─── parser ───────────────────────────────────────────────────

  // T1
  it('T1 — `-t` flips requestTty to true (force pseudo-terminal)', () => {
    expect(parseSshArgs(['-t', 'user@h'])!.requestTty).toBe('yes');
  });

  // T2
  it('T2 — `-T` disables PTY allocation explicitly', () => {
    expect(parseSshArgs(['-T', 'user@h'])!.requestTty).toBe('no');
  });

  // T3
  it('T3 — `requestTty` defaults to undefined when neither flag is set', () => {
    expect(parseSshArgs(['user@h'])!.requestTty).toBeUndefined();
  });

  // T4
  it('T4 — `-tt` forces a TTY even when stdin is not interactive', () => {
    expect(parseSshArgs(['-tt', 'user@h'])!.requestTty).toBe('force');
  });

  // T5
  it('T5 — SshConnectOptionsBuilder propagates requestTty / forceTty', () => {
    const opts = SshConnectOptionsBuilder.create()
      .host('h').user('u').port(22).requestTty('force').build();
    expect(opts.requestTty).toBe('force');
  });

  // ─── server-side persistent shell channel ─────────────────────

  // T6
  it('T6 — opening a shell channel registers a persistent session on the server', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const channelResult = session.openShellChannel();
    expect(isOk(channelResult)).toBe(true);
    if (isOk(channelResult)) {
      channelResult.value.close();
    }
    session.disconnect();
  });

  // T7
  it('T7 — shell input is dispatched server-side and the output flows back', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const channelResult = session.openShellChannel();
    if (!isOk(channelResult)) throw new Error('shell channel failed');
    const channel = channelResult.value;
    const received: string[] = [];
    channel.onData((d) => received.push(d));
    await channel.runLine('whoami');
    expect(received.join('')).toMatch(/user/);
    channel.close();
    session.disconnect();
  });

  // T8
  it('T8 — closing a shell channel emits a `channel_closed` event with shell type', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const events: Array<{ kind: string; channelType?: string }> = [];
    const handler = lan.pc2 as unknown as {
      getSshServerContext(): { events: { on(kind: string, fn: (e: unknown) => void): () => void } };
    };
    const ctx = handler.getSshServerContext();
    ctx.events.on('channel_closed', (e) =>
      events.push(e as { kind: string; channelType?: string }),
    );
    const channelResult = session.openShellChannel();
    if (!isOk(channelResult)) throw new Error('shell channel failed');
    channelResult.value.close();
    session.disconnect();
    expect(events.some((e) => e.channelType === 'shell')).toBe(true);
  });

  // ─── inline-command notice ────────────────────────────────────

  // T9
  it('T9 — `ssh -t host cmd` prints the "Pseudo-terminal will be allocated" notice', async () => {
    const term = new LinuxTerminalSession('term-1', lan.pc1);
    const t = term as unknown as {
      executeCommand(s: string): Promise<void>;
      pendingSshIO: { isWaitingForInput: boolean; submitInput(v: string): void } | null;
    };
    // Kick off (without awaiting) — the reactive SSH IO will queue a
    // password prompt that we satisfy below.
    const finished = t.executeCommand(`ssh -t user@${PC2_IP} whoami`);
    for (let i = 0; i < 50; i++) {
      if (t.pendingSshIO?.isWaitingForInput) {
        t.pendingSshIO.submitInput('admin');
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    await finished;
    const text = term.lines.map((l) => l.text).join('\n');
    expect(text).toMatch(
      /Pseudo-terminal will be allocated because a request was made\./,
    );
  });
});
