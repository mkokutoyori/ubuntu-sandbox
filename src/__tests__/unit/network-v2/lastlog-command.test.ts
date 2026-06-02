/**
 * lastlog(8) — dedicated behavioural spec (10 scenarios).
 *
 * The command surfaces the LinuxLastlogRegistry the SSH/console login
 * flow populates. These tests drive the command the way a sysadmin would
 * (`lastlog …`), arranging login state through the same registry the SSH
 * server writes to. Scope is limited to the lastlog command on a single
 * LinuxCommandExecutor — no cross-project wiring.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

interface LastlogSlot {
  current?: { when: number; sourceHost: string; tty: string };
  previous?: { when: number; sourceHost: string; tty: string };
}

describe('lastlog command', () => {
  let exec: LinuxCommandExecutor;

  beforeEach(() => {
    exec = new LinuxCommandExecutor(false);
  });

  function setEntryAge(user: string, daysAgo: number, host = '10.0.0.9', tty = 'pts/3'): void {
    const entries = (exec.lastlog as unknown as { entries: Map<string, LastlogSlot> }).entries;
    entries.set(user, { current: { when: Date.now() - daysAgo * 86400_000, sourceHost: host, tty } });
  }

  it('1. prints the canonical Username/Port/From/Latest header', () => {
    const out = exec.execute('lastlog');
    expect(out.split('\n')[0]).toMatch(/^Username\s+Port\s+From\s+Latest$/);
  });

  it('2. reports "**Never logged in**" for a user with no recorded login', () => {
    exec.userMgr.useradd('alice', { uid: 1001 });
    const out = exec.execute('lastlog -u alice');
    expect(out).toContain('alice');
    expect(out).toContain('**Never logged in**');
  });

  it('3. renders user, From host, Port (tty) and a Latest date after a login', () => {
    exec.userMgr.useradd('alice', { uid: 1001 });
    exec.lastlog.record('alice', '192.168.1.50', 'pts/2');
    const out = exec.execute('lastlog -u alice');
    const row = out.split('\n').find(l => l.startsWith('alice'))!;
    expect(row).toContain('192.168.1.50');
    expect(row).toContain('pts/2');
    expect(row).not.toContain('**Never logged in**');
    expect(row).toMatch(/\b\d{4}\b/);
  });

  it('4. -u <user> restricts the output to that single user', () => {
    exec.userMgr.useradd('alice', { uid: 1001 });
    exec.userMgr.useradd('bob', { uid: 1002 });
    exec.lastlog.record('alice', '10.0.0.5', 'pts/0');
    exec.lastlog.record('bob', '10.0.0.6', 'pts/1');
    const out = exec.execute('lastlog -u alice');
    expect(out).toMatch(/^alice\b/m);
    expect(out).not.toMatch(/^bob\b/m);
  });

  it('5. -u <unknown> reports an unknown-user error', () => {
    const out = exec.execute('lastlog -u ghost');
    expect(out).toMatch(/Unknown user or range: ghost/);
  });

  it('6. -t DAYS shows only logins more recent than the cutoff', () => {
    exec.userMgr.useradd('recent', { uid: 1001 });
    exec.userMgr.useradd('stale', { uid: 1002 });
    exec.lastlog.record('recent', '10.0.0.5', 'pts/0');
    setEntryAge('stale', 30);
    const out = exec.execute('lastlog -t 7');
    expect(out).toMatch(/^recent\b/m);
    expect(out).not.toMatch(/^stale\b/m);
  });

  it('7. -b DAYS shows only logins older than the cutoff', () => {
    exec.userMgr.useradd('recent', { uid: 1001 });
    exec.userMgr.useradd('stale', { uid: 1002 });
    exec.lastlog.record('recent', '10.0.0.5', 'pts/0');
    setEntryAge('stale', 30);
    const out = exec.execute('lastlog -b 7');
    expect(out).toMatch(/^stale\b/m);
    expect(out).not.toMatch(/^recent\b/m);
  });

  it('8. -C -u <user> as root clears the record (back to Never logged in)', () => {
    exec.userMgr.useradd('alice', { uid: 1001 });
    exec.lastlog.record('alice', '10.0.0.5', 'pts/0');
    exec.userMgr.currentUid = 0;
    exec.execute('lastlog -C -u alice');
    const out = exec.execute('lastlog -u alice');
    expect(out).toContain('**Never logged in**');
  });

  it('9. -S -u <user> as root stamps the record with the current time', () => {
    exec.userMgr.useradd('alice', { uid: 1001 });
    exec.userMgr.currentUid = 0;
    exec.execute('lastlog -S -u alice');
    const out = exec.execute('lastlog -u alice');
    expect(out).not.toContain('**Never logged in**');
    expect(out).toMatch(/^alice\b.*\b\d{4}\b/m);
  });

  it('10. rejects -C/-S without -u and when not root', () => {
    exec.userMgr.useradd('alice', { uid: 1001 });
    exec.userMgr.currentUid = 0;
    expect(exec.execute('lastlog -C')).toMatch(/option requires -u|--user/);
    exec.userMgr.currentUid = 1001;
    expect(exec.execute('lastlog -C -u alice')).toMatch(/must be root/);
  });
});
