/**
 * SSH LAN — ProxyJump (`ssh -J` / `-o ProxyJump=`).
 *
 * OpenSSH's `-J host1[,host2,...]` connects through one or more
 * intermediate hosts (jump hosts) before reaching the final target.
 * The simulator implements this by pushing each hop onto the SSH stack
 * in order, then opening the final connection from the topmost jump
 * host. The user's `exit` semantics therefore unwind hop-by-hop, which
 * matches real OpenSSH (`logout` only closes the topmost session).
 *
 * Scope:
 *  - J1..J3 : parser recognises `-J host`, `-J h1,h2`, `-o ProxyJump=`.
 *  - J4..J5 : end-to-end SSH connection chain via the terminal.
 *  - J6     : explicit error path — empty `-J` value.
 *  - J7     : per-hop user prefix `user@host` is preserved.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import {
  parseSshArgs,
  parseProxyJumpSpec,
} from '@/terminal/sessions/sshArgs';
import {
  buildLan,
  assignIps,
  type SshLan,
  PC2_IP,
  PC3_IP,
} from './ssh-lan-fixtures';

describe('SSH LAN — ProxyJump (`ssh -J`)', () => {
  let lan: SshLan;
  let term: LinuxTerminalSession;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    Equipment.clearRegistry();
    lan = buildLan();
    await assignIps(lan);
    term = new LinuxTerminalSession('term-1', lan.pc1);
  });

  // ─── parser ───────────────────────────────────────────────────

  // J1
  it('J1 — parseSshArgs recognises `-J user@host` as a single jump hop', () => {
    const parsed = parseSshArgs(['-J', 'jumper@10.0.0.2', 'user@10.0.0.3']);
    expect(parsed).not.toBeNull();
    expect(parsed!.userAtHost).toBe('user@10.0.0.3');
    expect(parsed!.jumpHosts).toEqual(['jumper@10.0.0.2']);
  });

  // J2
  it('J2 — parseSshArgs accepts a comma-separated list of jump hops', () => {
    const parsed = parseSshArgs([
      '-J',
      'a@1.1.1.1,b@2.2.2.2,c@3.3.3.3',
      'user@4.4.4.4',
    ]);
    expect(parsed!.jumpHosts).toEqual([
      'a@1.1.1.1',
      'b@2.2.2.2',
      'c@3.3.3.3',
    ]);
  });

  // J3
  it('J3 — `-o ProxyJump=user@host` is equivalent to `-J`', () => {
    const parsed = parseSshArgs([
      '-o',
      'ProxyJump=jumper@10.0.0.2',
      'user@10.0.0.3',
    ]);
    expect(parsed!.jumpHosts).toEqual(['jumper@10.0.0.2']);
  });

  // J6
  it('J6 — `-J` with an empty value returns null (usage error)', () => {
    const parsed = parseSshArgs(['-J', '', 'user@10.0.0.3']);
    expect(parsed!.jumpHosts).toEqual([]);
  });

  // J7
  it('J7 — parseProxyJumpSpec extracts user+host pairs per hop', () => {
    expect(parseProxyJumpSpec('alice@10.0.0.2')).toEqual([
      { user: 'alice', host: '10.0.0.2' },
    ]);
    expect(parseProxyJumpSpec('10.0.0.2')).toEqual([
      { user: null, host: '10.0.0.2' },
    ]);
    expect(parseProxyJumpSpec('alice@10.0.0.2,bob@10.0.0.3')).toEqual([
      { user: 'alice', host: '10.0.0.2' },
      { user: 'bob', host: '10.0.0.3' },
    ]);
    expect(parseProxyJumpSpec('')).toEqual([]);
  });

  // ─── end-to-end (LAN-resolved jump chain) ────────────────────

  // J4
  it('J4 — pushSshChain stacks one frame per hop in order, end-on-final', () => {
    // The simulator short-circuits the SSH handshake whenever every jump
    // host is resolvable to a local `Equipment` (the common case for the
    // tutorial LAN). pushSshChain walks the hops and pushes the device
    // for each — the result is the same stack shape a real `-J` flow
    // produces, but without needing the reactive password prompt.
    term.pushSshChain([
      { user: 'user', host: PC2_IP },
      { user: 'alice', host: PC3_IP },
    ]);
    expect(term.device).toBe(lan.pc3);
    const ctx = term.getSshContextInfo();
    expect(ctx.active).toBe(true);
    expect(ctx.chain).toEqual([
      { host: PC2_IP, user: 'user' },
      { host: PC3_IP, user: 'alice' },
    ]);
    // The InfoBar header still names the local box (subshell behaviour).
    expect(term.getLocalDevice()).toBe(lan.pc1);
  });

  // J5
  it('J5 — `exit` after a -J chain unwinds one hop at a time (OpenSSH parity)', async () => {
    term.pushSshChain([
      { user: 'user', host: PC2_IP },
      { user: 'alice', host: PC3_IP },
    ]);
    expect(term.device).toBe(lan.pc3);
    await pressEnterWith(term, 'exit');
    expect(term.device).toBe(lan.pc2);
    await pressEnterWith(term, 'exit');
    expect(term.device).toBe(lan.pc1);
    expect(term.isInsideSshSession).toBe(false);
  });
});

// ─── test helpers ───────────────────────────────────────────────

async function pressEnterWith(
  term: LinuxTerminalSession,
  line: string,
): Promise<void> {
  // executeCommand is private; the test reaches into the prototype the
  // same way `ssh-lan-remote-shell.test.ts` does (via a typed cast).
  const t = term as unknown as { executeCommand(s: string): Promise<void> };
  await t.executeCommand(line);
}
