/**
 * Password-policy coherence across ssh / scp / sftp.
 *
 * Every vendor now enforces some form of password policy (lockout after
 * N failed attempts, password expiration) — see:
 *   - Linux:   `/etc/security/faillock.conf` (LinuxUserManager.checkPassword)
 *   - Windows: `net accounts /lockoutthreshold` + `/maxpwage` (WindowsUserManager.checkPassword)
 *   - Cisco:   `aaa local authentication attempts max-fail` (NetworkOsCredentialStore)
 *
 * The risk with three independent enforcement points is that only ONE
 * transport gets wired up (typically interactive `ssh`) while `scp`/`sftp`
 * quietly keep trusting a locked-out or expired account. These tests drive
 * all three transports against the SAME locked/expired account and assert
 * they are rejected identically — closing exactly that class of bug.
 *
 * Two real bugs were found and fixed while writing this suite:
 *   1. LinuxUserManager.checkPassword never consulted isAccountLockedOut()
 *      before comparing the password — a locked account could still log in
 *      with the CORRECT password.
 *   2. LinuxSshClient's verifyOfferedPassword() trusted any connection that
 *      didn't explicitly offer a password (the convenience shortcut used by
 *      every non-interactive `ssh`/`scp`/`sftp` in these tests) — meaning a
 *      locked-out account's non-interactive scp/sftp silently succeeded
 *      even though a real `ssh` attempt with the same (correct) password,
 *      offered via sshpass, was correctly rejected.
 *   3. WindowsUserManagerAuthority (the adapter CrossVendorSshHost uses for
 *      Linux/Cisco/Huawei → Windows ssh/scp/sftp) read non-existent fields
 *      (`lockedOut`/`passwordExpired`) instead of the real ones, so the
 *      lifecycle gate never reported "account locked"/"password expired"
 *      for a Windows target even though WindowsUserManager itself already
 *      knew the account was locked/expired.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function sftpBatch(dest: string, verbs: string[]): string {
  return `sftp ${dest} <<'EOF'\n${verbs.join('\n')}\nbye\nEOF`;
}

// ═══════════════════════════════════════════════════════════════════
// §1 — Linux: faillock lockout rejects ssh, scp AND sftp alike
// ═══════════════════════════════════════════════════════════════════

describe('§1 — Linux faillock lockout is coherent across ssh/scp/sftp', () => {
  async function buildPair() {
    const client = new LinuxPC('linux-pc', 'client', 0, 0);
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    new Cable('c').connect(client.getPorts()[0], srv.getPorts()[0]);
    client.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
    srv.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
    const um = (srv as unknown as { executor: { userMgr: {
      useradd(u: string, o?: object): void;
      setPassword(u: string, p: string): void;
    } } }).executor.userMgr;
    um.useradd('alice', { m: true, s: '/bin/bash' });
    um.setPassword('alice', 'correct-horse-battery-staple');
    return { client, srv };
  }

  async function tripLockout(client: LinuxPC) {
    // Default faillock policy: deny = 3.
    for (let i = 0; i < 3; i++) {
      await client.executeCommand('sshpass -p WRONG ssh alice@10.0.0.10 whoami');
    }
  }

  it('sanity: the account authenticates fine before any failures', async () => {
    const { client } = await buildPair();
    const out = await client.executeCommand('sshpass -p correct-horse-battery-staple ssh alice@10.0.0.10 whoami');
    expect(out).toMatch(/^alice\s*$/m);
  });

  it('three wrong sshpass attempts trip the lockout', async () => {
    const { client, srv } = await buildPair();
    await tripLockout(client);
    const um = (srv as unknown as { executor: { userMgr: { isAccountLockedOut(u: string): boolean } } }).executor.userMgr;
    expect(um.isAccountLockedOut('alice')).toBe(true);
  });

  it('ssh with the CORRECT password is rejected once locked out', async () => {
    const { client } = await buildPair();
    await tripLockout(client);
    const out = await client.executeCommand('sshpass -p correct-horse-battery-staple ssh alice@10.0.0.10 whoami');
    expect(out).toMatch(/Permission denied/i);
    expect(out).not.toMatch(/^alice\s*$/m);
  });

  it('a non-interactive ssh (no sshpass) is also rejected once locked out', async () => {
    const { client } = await buildPair();
    await tripLockout(client);
    const out = await client.executeCommand('ssh alice@10.0.0.10 whoami');
    expect(out).toMatch(/Permission denied/i);
  });

  it('scp is rejected once locked out (probe fails before any transfer)', async () => {
    const { client } = await buildPair();
    await client.executeCommand('echo hello > /tmp/payload.txt');
    await tripLockout(client);
    const out = await client.executeCommand('scp /tmp/payload.txt alice@10.0.0.10:/tmp/payload.txt');
    expect(out).toMatch(/Permission denied/i);
  });

  it('sftp is rejected once locked out (same probe as scp)', async () => {
    const { client } = await buildPair();
    await tripLockout(client);
    const out = await client.executeCommand(sftpBatch('alice@10.0.0.10', ['pwd']));
    expect(out).toMatch(/Permission denied/i);
    expect(out).not.toMatch(/Connected to/);
  });

  it('scp is not silently accepted just because no password was offered', async () => {
    // Regression guard for the "trust when no password offered" shortcut:
    // that convenience must not survive past an actual lockout.
    const { client, srv } = await buildPair();
    await tripLockout(client);
    const before = (srv as unknown as { executor: { vfs: { exists(p: string): boolean } } }).executor.vfs;
    const out = await client.executeCommand('scp /etc/hostname alice@10.0.0.10:/tmp/should-not-land.txt');
    expect(out).toMatch(/Permission denied/i);
    expect(before.exists('/tmp/should-not-land.txt')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §2 — Windows: net accounts lockout is coherent across ssh/scp/sftp
//      (reached from Linux via the cross-vendor bypass — Windows has
//      no listening TCP sshd of its own in this simulator).
// ═══════════════════════════════════════════════════════════════════

describe('§2 — Windows net accounts lockout is coherent across ssh/scp/sftp', () => {
  async function buildPair() {
    const client = new LinuxPC('linux-pc', 'client', 0, 0);
    const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
    new Cable('c').connect(client.getPorts()[0], win.getPorts()[0]);
    client.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
    win.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
    await win.executeCommand('net accounts /lockoutthreshold:3');
    return { client, win };
  }

  function tripLockout(win: WindowsPC) {
    for (let i = 0; i < 3; i++) win.checkPassword('User', 'WRONG');
  }

  it('sanity: ssh/scp/sftp reach the Windows account before any failures', async () => {
    const { client } = await buildPair();
    const out = await client.executeCommand('ssh User@10.0.0.10 hostname');
    expect(out).toMatch(/WIN1/i);
  });

  it('three wrong logons trip the Windows lockout', async () => {
    const { win } = await buildPair();
    tripLockout(win);
    const userMgr = (win as unknown as { userMgr: { isLockedOut(u: string): boolean } }).userMgr;
    expect(userMgr.isLockedOut('User')).toBe(true);
  });

  it('ssh is rejected once the Windows account is locked out', async () => {
    const { client, win } = await buildPair();
    tripLockout(win);
    const out = await client.executeCommand('ssh User@10.0.0.10 hostname');
    expect(out).toMatch(/Permission denied/i);
  });

  it('scp is rejected once the Windows account is locked out', async () => {
    const { client, win } = await buildPair();
    tripLockout(win);
    const out = await client.executeCommand('scp /etc/hostname User@10.0.0.10:/C:/Users/User/should-not-land.txt');
    expect(out).toMatch(/Permission denied/i);
  });

  it('sftp is rejected once the Windows account is locked out', async () => {
    const { client, win } = await buildPair();
    tripLockout(win);
    const out = await client.executeCommand(sftpBatch('User@10.0.0.10', ['pwd']));
    expect(out).toMatch(/Permission denied/i);
    expect(out).not.toMatch(/Connected to/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §3 — Windows: an expired password (net accounts /maxpwage) is
//      coherent across ssh/scp/sftp too.
// ═══════════════════════════════════════════════════════════════════

describe('§3 — Windows password expiration is coherent across ssh/scp/sftp', () => {
  async function buildExpiredPair() {
    const client = new LinuxPC('linux-pc', 'client', 0, 0);
    const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
    new Cable('c').connect(client.getPorts()[0], win.getPorts()[0]);
    client.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
    win.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
    await win.executeCommand('net accounts /maxpwage:1');
    // Back-date the account's password-last-set past the 1-day policy.
    const user = (win as unknown as {
      userMgr: { getUser(u: string): { passwordLastSet: Date } | undefined };
    }).userMgr.getUser('User')!;
    user.passwordLastSet = new Date(Date.now() - 2 * 86_400_000);
    return { client, win };
  }

  it('the account is reported expired', async () => {
    const { win } = await buildExpiredPair();
    const userMgr = (win as unknown as { userMgr: { isPasswordExpired(u: string): boolean } }).userMgr;
    expect(userMgr.isPasswordExpired('User')).toBe(true);
  });

  it('ssh is rejected once the Windows password has expired', async () => {
    const { client } = await buildExpiredPair();
    const out = await client.executeCommand('ssh User@10.0.0.10 hostname');
    expect(out).toMatch(/Permission denied/i);
  });

  it('scp is rejected once the Windows password has expired', async () => {
    const { client } = await buildExpiredPair();
    const out = await client.executeCommand('scp /etc/hostname User@10.0.0.10:/C:/Users/User/should-not-land.txt');
    expect(out).toMatch(/Permission denied/i);
  });

  it('sftp is rejected once the Windows password has expired', async () => {
    const { client } = await buildExpiredPair();
    const out = await client.executeCommand(sftpBatch('User@10.0.0.10', ['pwd']));
    expect(out).toMatch(/Permission denied/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §4 — Cisco: aaa local authentication attempts max-fail is coherent
//      across ssh and sftp (Cisco ships a read-only SFTP server).
// ═══════════════════════════════════════════════════════════════════

describe('§4 — Cisco per-account lockout is coherent across ssh and sftp', () => {
  async function buildPair() {
    const client = new LinuxPC('linux-pc', 'client', 0, 0);
    const r1 = new CiscoRouter('ciscoR1', 0, 0);
    new Cable('c').connect(client.getPorts()[0], r1.getPorts()[0]);
    client.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 10.0.0.10 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('exit');
    await r1.executeCommand('aaa new-model');
    await r1.executeCommand('aaa local authentication attempts max-fail 3');
    await r1.executeCommand('username admin privilege 15 secret Admin@123');
    await r1.executeCommand('crypto key generate rsa modulus 2048');
    await r1.executeCommand('line vty 0 4');
    await r1.executeCommand('login local');
    await r1.executeCommand('transport input ssh');
    await r1.executeCommand('ip scp server enable');
    await r1.executeCommand('end');
    return { client, r1 };
  }

  function tripLockout(r1: CiscoRouter) {
    const store = r1.getCredentialStore();
    for (let i = 0; i < 3; i++) store.recordLoginFailure('admin', '10.0.0.20', 'bad password');
  }

  it('sanity: ssh reaches the Cisco account before any failures', async () => {
    const { client } = await buildPair();
    const out = await client.executeCommand('sshpass -p Admin@123 ssh admin@10.0.0.10 "show version | include uptime"');
    expect(out).not.toMatch(/Permission denied/i);
  });

  it('ssh is rejected once the Cisco account is locked out, even with the right secret', async () => {
    const { client, r1 } = await buildPair();
    tripLockout(r1);
    const out = await client.executeCommand('sshpass -p Admin@123 ssh admin@10.0.0.10 "show version"');
    expect(out).toMatch(/Permission denied/i);
  });

  it('sftp is rejected once the Cisco account is locked out', async () => {
    const { client, r1 } = await buildPair();
    tripLockout(r1);
    const out = await client.executeCommand(sftpBatch('admin@10.0.0.10', ['ls']));
    expect(out).toMatch(/Permission denied/i);
    expect(out).not.toMatch(/Connected to/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §5 — Huawei ships no SCP/SFTP server surface (documented gap, not a
//      coherence bug): pinned here so an SFTP client is only wired up
//      alongside the lockout gate that §1-§4 hold every other vendor to.
// ═══════════════════════════════════════════════════════════════════

describe('§5 — Huawei has no SCP/SFTP server (out of scope, not a coherence bug)', () => {
  it('a Huawei router does not expose getSftpFileSource', () => {
    const r1 = new HuaweiRouter('hwR1', 0, 0);
    expect((r1 as unknown as { getSftpFileSource?: unknown }).getSftpFileSource).toBeUndefined();
  });
});
