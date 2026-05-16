/**
 * SSH LAN — analysis-doc remediations (priorities P1..P3).
 *
 * Mirrors the priorities listed in `docs/SSH-IMPLEMENTATION-ANALYSIS.md`:
 *
 *  - P1 UI banner: `LinuxTerminalSession.getSshContextInfo()` + the
 *    React component that consumes it. The component is verified via
 *    its observable surface here (the React render itself is unit-tested
 *    in TerminalView's own test file when one exists).
 *  - P2 Windows public-key authentication: a key dropped in the right
 *    `~/.ssh/authorized_keys` location authenticates over SSH.
 *  - P3 /var/log/auth.log: each Accept / Failed event now lands in
 *    /var/log/auth.log on the target server, matching OpenSSH's
 *    "Accepted password for <user> from <ip> port 0 ssh2" wording.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import { WindowsUserManager } from '@/network/devices/windows/WindowsUserManager';
import { WindowsSshServerContext } from '@/network/protocols/ssh/server/WindowsSshServerContext';
import { SshHostKey } from '@/network/protocols/ssh/SshHostKey';
import {
  buildLan,
  assignIps,
  openSshSession,
  sshExec,
  type SshLan,
  PC2_IP,
  PC3_IP,
} from './ssh-lan-fixtures';

describe('SSH analysis-doc remediations', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    Equipment.clearRegistry();
    lan = buildLan();
    await assignIps(lan);
  });

  // ─── P1 — UI banner state ────────────────────────────────────

  // F1
  it('F1 — getSshContextInfo() reflects nested ssh chains for the UI banner', () => {
    const term = new LinuxTerminalSession('t-banner', lan.pc1);
    expect(term.getSshContextInfo()).toEqual({
      active: false,
      chain: [],
      current: null,
    });
    term.pushRemoteDevice(lan.pc2, 'user', `user@${PC2_IP}`, () => undefined);
    term.pushRemoteDevice(lan.pc3, 'alice', `alice@${PC3_IP}`, () => undefined);
    const info = term.getSshContextInfo();
    expect(info.active).toBe(true);
    expect(info.current).toBe(PC3_IP);
    expect(info.chain).toEqual([
      { host: PC2_IP, user: 'user' },
      { host: PC3_IP, user: 'alice' },
    ]);
    term.popRemoteDevice();
    term.popRemoteDevice();
    expect(term.getSshContextInfo().active).toBe(false);
  });

  // ─── P2 — Windows public-key authentication ──────────────────

  // F2
  it('F2 — Windows ssh server accepts a public key listed in the user authorized_keys', async () => {
    const wfs = new WindowsFileSystem('WPC');
    const userMgr = new WindowsUserManager();
    const userEntry = userMgr.getUser('User');
    expect(userEntry).toBeTruthy();
    // Drop a public key into C:\Users\User\.ssh\authorized_keys with the
    // OpenSSH-for-Windows path convention.
    wfs.mkdirp('C:\\Users\\User\\.ssh');
    const PUB_MATERIAL = 'AAAAC3NzaC1lZDI1NTE5AAAAEUSER-PUB';
    wfs.createFile(
      'C:\\Users\\User\\.ssh\\authorized_keys',
      `ssh-ed25519 ${PUB_MATERIAL} user@local\n`,
    );
    const ctx = new WindowsSshServerContext(wfs, userMgr, 'WPC', {
      pubkeyAuthentication: true,
    });
    expect(ctx.auth.checkPublicKey('User', PUB_MATERIAL)).toBe(true);
    expect(ctx.auth.checkPublicKey('User', 'AAAA-WRONG')).toBe(false);
    expect(ctx.auth.getAvailableMethods()).toContain('publickey');
  });

  // F3
  it('F3 — Windows pubkey rejects when authorized_keys is missing', () => {
    const wfs = new WindowsFileSystem('WPC');
    const userMgr = new WindowsUserManager();
    const ctx = new WindowsSshServerContext(wfs, userMgr, 'WPC', {
      pubkeyAuthentication: true,
    });
    expect(ctx.auth.checkPublicKey('User', 'AAAA')).toBe(false);
  });

  // F4
  it('F4 — Windows pubkey rejects when PubkeyAuthentication=no', () => {
    const wfs = new WindowsFileSystem('WPC');
    const userMgr = new WindowsUserManager();
    wfs.mkdirp('C:\\Users\\User\\.ssh');
    wfs.createFile(
      'C:\\Users\\User\\.ssh\\authorized_keys',
      `ssh-ed25519 AAAA-OK user@local\n`,
    );
    // Even with a matching key, the directive must dominate.
    const ctx = new WindowsSshServerContext(wfs, userMgr, 'WPC', {
      pubkeyAuthentication: false,
    });
    expect(ctx.auth.checkPublicKey('User', 'AAAA-OK')).toBe(false);
    expect(ctx.auth.getAvailableMethods()).not.toContain('publickey');
    // Unused vars to silence linter.
    void SshHostKey;
  });

  // ─── P3 — /var/log/auth.log reflects SSH activity ────────────

  // F5
  it('F5 — successful SSH login appends an "Accepted password" line to /var/log/auth.log', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP, 'user', 'admin');
    session.disconnect();
    const log = await lan.pc2.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/sshd\[\d+\]: Accepted password for user from /);
  });

  // F6
  it('F6 — `tail` over SSH retrieves the auth.log entry the server just wrote', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP, 'user', 'admin');
    session.disconnect();
    // A second connection to fetch the log lets us validate the round-trip.
    const out = await sshExec(
      lan.pc1,
      PC2_IP,
      'tail -n 5 /var/log/auth.log',
      'user',
      'admin',
    );
    expect(out.stdout).toMatch(/Accepted password for user/);
  });

  // F7
  it('F7 — auth.log accumulates across multiple successful logins', async () => {
    for (let i = 0; i < 3; i++) {
      const session = await openSshSession(lan.pc1, PC2_IP, 'user', 'admin');
      session.disconnect();
    }
    const log = await lan.pc2.executeCommand('cat /var/log/auth.log');
    const matches = log.match(/Accepted password/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});
