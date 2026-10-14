/**
 * SSH LAN — ProxyJump (`ssh -J` / `-o ProxyJump=`).
 *
 * OpenSSH's `-J host1[,host2,...]` connects through one or more
 * intermediate hosts (jump hosts) before reaching the final target.
 * Each hop is a real SSH session; the next connection rides a
 * `direct-tcpip` channel opened on it (OpenSSH `ProxyJump` is
 * `ProxyCommand ssh -W`), so the final server sees the jump host's
 * address as the client and the jump host's sshd logs the tunnel.
 *
 * Scope:
 *  - J1..J3 : parser recognises `-J host`, `-J h1,h2`, `-o ProxyJump=`.
 *  - J4..J5 : end-to-end connection through the jump host, asked for a
 *             password per hop, tunnelled on the wire; `exit` closes both.
 *  - J6     : explicit error path — empty `-J` value.
 *  - J7     : per-hop user prefix `user@host` is preserved.
 *

 * Discriminee par `git stash push -- src/network src/terminal src/shell` :
 * avant, J4, J5 et J8 tombent (3 sur 8) ; J1-J3, J6, J7 sont des
 * parseurs, TEMOINS qui passent des deux cotes.
 *
 * Avant la bascule sur le fil, J4 et J5 testaient `pushSshChain`, qui
 * empilait les OBJETS des hotes de rebond en memoire : aucune trame ne
 * partait vers eux et le serveur final voyait le poste d'origine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
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
    EquipmentRegistry.getInstance().clear();
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

  // ─── end-to-end (real tunnel through the jump host) ──────────

  // J4
  it('J4 — the final server sees the jump host as the client, and asks for each password', async () => {
    await runLine(term, `ssh -o StrictHostKeyChecking=no -J user@${PC2_IP} user@${PC3_IP}`, ['admin', 'admin']);
    await runLine(term, 'hostname', []);
    expect(term.lines.map((l) => l.text)).toContain('PC3');
    const authLog = await lan.pc3.executeCommand('sudo cat /var/log/auth.log');
    expect(authLog).toMatch(new RegExp(`Accepted password for user from ${PC2_IP.replace(/\./g, '\\.')} `));
    expect(authLog).not.toMatch(new RegExp(`Accepted password for user from 10\\.0\\.0\\.1 `));
    expect(await lan.pc2.executeCommand('sudo cat /var/log/auth.log')).toMatch(/Accepted password for user from 10\.0\.0\.1 /);
  });

  // J5
  it('J5 — `exit` closes the final session and the tunnel, back on the local prompt', async () => {
    await runLine(term, `ssh -o StrictHostKeyChecking=no -J user@${PC2_IP} user@${PC3_IP}`, ['admin', 'admin']);
    await runLine(term, 'exit', []);
    await runLine(term, 'hostname', []);
    expect(term.lines.map((l) => l.text).filter((t) => t === 'PC1').length).toBeGreaterThan(0);
    expect(term.isInsideSshSession).toBe(false);
  });

  // J8
  it('J8 — a wrong password on the jump host stops the chain before the final host', async () => {
    await runLine(term, `ssh -o StrictHostKeyChecking=no -J user@${PC2_IP} user@${PC3_IP}`, ['bad', 'bad', 'bad']);
    expect(term.isInsideSshSession).toBe(false);
    expect(await lan.pc3.executeCommand('sudo cat /var/log/auth.log')).not.toMatch(/Accepted|Failed/);
  });
});

// ─── test helpers ───────────────────────────────────────────────

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

async function runLine(term: LinuxTerminalSession, line: string, passwords: string[]): Promise<void> {
  const host = term as unknown as TerminalSession;
  const target = (host.foreground ?? host) as TerminalSession;
  target.setInput(line);
  target.setInputBuf(line);
  target.handleKey(key('Enter'));
  for (const password of passwords) {
    for (let i = 0; i < 60 && target.currentInputMode.type !== 'password'; i++) await tick();
    if (target.currentInputMode.type !== 'password') break;
    target.setPasswordBuf(password);
    target.handleKey(key('Enter'));
  }
  for (let i = 0; i < 20; i++) await tick();
}
