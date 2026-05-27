/**
 * Observability regression suite — fixes the three coherency gaps the
 * recent audit surfaced:
 *
 *  §LL1 `lastlog` command exposes the lastlog registry the SSH server
 *       already populates on every successful login.
 *  §JB1 SSH auth events landing in /var/log/auth.log must ALSO appear
 *       in the journal (`journalctl -u sshd`). Today the syslogger
 *       writes the file directly, bypassing LinuxLogManager — so a
 *       sysadmin sees the file but `journalctl` is empty.
 *  §JB2 Failed auth + invalid-user events go through the same bridge.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

describe('observability: lastlog / journalctl coherency', () => {
  let vfs: VirtualFileSystem;
  let exec: LinuxCommandExecutor;

  beforeEach(() => {
    exec = new LinuxCommandExecutor(false);
    vfs = exec.vfs;
  });

  // ────────────── §LL1 lastlog command exists ──────────────────────
  describe('§LL1 lastlog command', () => {
    it('prints the canonical Username/Port/From/Latest header', async () => {
      const out = exec.execute('lastlog');
      expect(out).toMatch(/^Username\s+Port\s+From\s+Latest/);
    });

    it('shows "**Never logged in**" for users without a lastlog entry', async () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      const out = exec.execute('lastlog');
      expect(out).toContain('alice');
      expect(out).toContain('**Never logged in**');
    });

    it('shows the recorded login when the SSH server populated lastlog', async () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.lastlog.record('alice', '10.0.0.5', 'pts/0');
      const out = exec.execute('lastlog -u alice');
      expect(out).toContain('alice');
      expect(out).toContain('10.0.0.5');
      expect(out).toContain('pts/0');
      expect(out).not.toContain('**Never logged in**');
    });

    it('honours `-u <user>` to filter a single user', async () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.userMgr.useradd('bob', { uid: 1002 });
      exec.lastlog.record('alice', '10.0.0.5', 'pts/0');
      exec.lastlog.record('bob',   '10.0.0.6', 'pts/1');
      const out = exec.execute('lastlog -u alice');
      expect(out).toContain('alice');
      expect(out).not.toContain('bob');
    });
  });

  // ────────────── §JB1/§JB2 journal/auth.log coherency ─────────────
  describe('§JB SSH events reach BOTH /var/log/auth.log and journalctl', () => {
    it('records auth_success in the journal under unit sshd', async () => {
      const { SshServerEventBus } = await import('@/network/protocols/ssh/server/SshServerEvent');
      const { SshSyslogger } = await import('@/network/protocols/ssh/logging/SshSyslogger');
      const bus = new SshServerEventBus();
      new SshSyslogger(vfs, bus, { hostname: 'box', sshdPid: 4242, logMgr: exec.logMgr });

      bus.emit({ kind: 'auth_success', user: 'alice', method: 'password', ip: '10.0.0.2' });

      // /var/log/auth.log path still works (legacy)
      const auth = vfs.readFile('/var/log/auth.log') ?? '';
      expect(auth).toContain('Accepted password for alice from 10.0.0.2');

      // The new bridge: journalctl -u sshd must surface the same event.
      const journal = exec.logMgr.executeJournalctl(['-u', 'ssh']);
      expect(journal).toContain('Accepted password for alice from 10.0.0.2');
    });

    it('records auth_failure in journalctl too', async () => {
      const { SshServerEventBus } = await import('@/network/protocols/ssh/server/SshServerEvent');
      const { SshSyslogger } = await import('@/network/protocols/ssh/logging/SshSyslogger');
      const bus = new SshServerEventBus();
      new SshSyslogger(vfs, bus, { hostname: 'box', sshdPid: 4242, logMgr: exec.logMgr });

      bus.emit({ kind: 'auth_failure', user: 'mallory', method: 'password', ip: '10.0.0.99' });

      const journal = exec.logMgr.executeJournalctl(['-u', 'ssh']);
      expect(journal).toContain('Failed password for mallory from 10.0.0.99');
    });
  });
});
