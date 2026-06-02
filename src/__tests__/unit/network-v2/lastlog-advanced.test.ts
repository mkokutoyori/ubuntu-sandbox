/**
 * lastlog(8) — advanced, multi-layer spec (30 scenarios).
 *
 * Exercises the command across every layer it touches:
 *   §A Command semantics (header, filters, mutations, guards)
 *   §B Filesystem coherence (/var/log/lastlog as the real backing store)
 *   §C Access & identity (UID, UID ranges, root-only mutations)
 *   §D Network / SSH login recording (the real recordLogin seam)
 *
 * The registry is the single source of truth and is projected onto the
 * canonical /var/log/lastlog file; tests assert both the rendered command
 * output and the on-disk projection stay coherent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import { LinuxLastlogRegistry, LASTLOG_PATH } from '@/network/devices/linux/LinuxLastlogRegistry';
import { LinuxSshServerContext } from '@/network/protocols/ssh/server/LinuxSshServerContext';

interface PersistedRow { user: string; when: number; sourceHost: string; tty: string }

function readLastlogFile(exec: LinuxCommandExecutor): PersistedRow[] {
  const raw = exec.vfs.readFile(LASTLOG_PATH);
  return raw ? (JSON.parse(raw) as PersistedRow[]) : [];
}

function rowFor(out: string, user: string): string | undefined {
  return out.split('\n').find(l => l.startsWith(user + ' ') || l === user || l.startsWith(user + '\t'));
}

describe('lastlog — advanced multi-layer', () => {
  let exec: LinuxCommandExecutor;

  beforeEach(() => {
    exec = new LinuxCommandExecutor(false);
  });

  // ─────────────────────────── §A command ───────────────────────────
  describe('§A command semantics', () => {
    it('A1 prints the canonical four-column header', () => {
      expect(exec.execute('lastlog').split('\n')[0]).toMatch(/^Username\s+Port\s+From\s+Latest$/);
    });

    it('A2 lists "**Never logged in**" for a fresh account', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      expect(exec.execute('lastlog -u alice')).toContain('**Never logged in**');
    });

    it('A3 renders host, tty and a year once a login is recorded', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.lastlog.record('alice', '192.168.1.50', 'pts/2');
      const row = rowFor(exec.execute('lastlog -u alice'), 'alice')!;
      expect(row).toContain('192.168.1.50');
      expect(row).toContain('pts/2');
      expect(row).toMatch(/\b\d{4}\b/);
    });

    it('A4 -u filters to a single account', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.userMgr.useradd('bob', { uid: 1002 });
      exec.lastlog.record('alice', '10.0.0.5', 'pts/0');
      exec.lastlog.record('bob', '10.0.0.6', 'pts/1');
      const out = exec.execute('lastlog -u alice');
      expect(out).toMatch(/^alice\b/m);
      expect(out).not.toMatch(/^bob\b/m);
    });

    it('A5 -u on an unknown name is an error', () => {
      expect(exec.execute('lastlog -u ghost')).toMatch(/Unknown user or range: ghost/);
    });

    it('A6 -t DAYS keeps only recent logins', () => {
      exec.userMgr.useradd('recent', { uid: 1001 });
      exec.userMgr.useradd('stale', { uid: 1002 });
      exec.lastlog.record('recent', '10.0.0.5', 'pts/0');
      exec.lastlog.record('stale', '10.0.0.6', 'pts/1', Date.now() - 30 * 86400_000);
      const out = exec.execute('lastlog -t 7');
      expect(out).toMatch(/^recent\b/m);
      expect(out).not.toMatch(/^stale\b/m);
    });

    it('A7 -b DAYS keeps only old logins', () => {
      exec.userMgr.useradd('recent', { uid: 1001 });
      exec.userMgr.useradd('stale', { uid: 1002 });
      exec.lastlog.record('recent', '10.0.0.5', 'pts/0');
      exec.lastlog.record('stale', '10.0.0.6', 'pts/1', Date.now() - 30 * 86400_000);
      const out = exec.execute('lastlog -b 7');
      expect(out).toMatch(/^stale\b/m);
      expect(out).not.toMatch(/^recent\b/m);
    });

    it('A8 -h prints usage', () => {
      expect(exec.execute('lastlog -h')).toMatch(/Usage:[\s\S]*--user/);
    });

    it('A9 -V prints the util-linux version', () => {
      expect(exec.execute('lastlog -V')).toMatch(/util-linux/);
    });

    it('A10 plain lastlog lists every account exactly once', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      const out = exec.execute('lastlog');
      const aliceRows = out.split('\n').filter(l => /^alice\b/.test(l));
      expect(aliceRows).toHaveLength(1);
      expect(out).toMatch(/^root\b/m);
    });
  });

  // ───────────────────────── §B filesystem ──────────────────────────
  describe('§B filesystem coherence', () => {
    it('B1 seeds /var/log/lastlog at construction', () => {
      expect(exec.vfs.exists(LASTLOG_PATH)).toBe(true);
    });

    it('B2 the seeded file is owned root:root, mode 0644', () => {
      const inode = exec.vfs.resolveInode(LASTLOG_PATH)!;
      expect(inode.uid).toBe(0);
      expect(inode.gid).toBe(0);
      expect((inode.permissions & 0o777).toString(8)).toBe('644');
    });

    it('B3 a recorded login is projected to the file', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.lastlog.record('alice', '10.0.0.5', 'pts/0');
      const rows = readLastlogFile(exec);
      const alice = rows.find(r => r.user === 'alice');
      expect(alice).toBeDefined();
      expect(alice!.sourceHost).toBe('10.0.0.5');
      expect(alice!.tty).toBe('pts/0');
    });

    it('B4 reading the file back via cat yields valid JSON of the entries', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.lastlog.record('alice', '10.0.0.5', 'pts/0');
      const out = exec.execute('cat /var/log/lastlog');
      expect(() => JSON.parse(out)).not.toThrow();
      expect(out).toContain('alice');
    });

    it('B5 -C removes the user from the on-disk projection', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.lastlog.record('alice', '10.0.0.5', 'pts/0');
      exec.userMgr.currentUid = 0;
      exec.execute('lastlog -C -u alice');
      expect(readLastlogFile(exec).some(r => r.user === 'alice')).toBe(false);
    });

    it('B6 -S writes a fresh stamp to the file', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.userMgr.currentUid = 0;
      const before = Date.now() - 1000;
      exec.execute('lastlog -S -u alice');
      const alice = readLastlogFile(exec).find(r => r.user === 'alice');
      expect(alice).toBeDefined();
      expect(alice!.when).toBeGreaterThanOrEqual(before);
    });

    it('B7 a fresh registry re-hydrates from an existing file', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.lastlog.record('alice', '10.0.0.42', 'pts/9');
      const reborn = new LinuxLastlogRegistry();
      reborn.attachVfs(exec.vfs);
      expect(reborn.getCurrent('alice')?.sourceHost).toBe('10.0.0.42');
    });

    it('B8 the command output and the file projection agree', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.lastlog.record('alice', '172.16.0.9', 'pts/4');
      const fileHost = readLastlogFile(exec).find(r => r.user === 'alice')!.sourceHost;
      expect(rowFor(exec.execute('lastlog -u alice'), 'alice')).toContain(fileHost);
    });
  });

  // ─────────────────────────── §C access ────────────────────────────
  describe('§C access & identity', () => {
    it('C1 -u accepts a numeric UID', () => {
      exec.userMgr.useradd('zoe', { u: 1777 });
      exec.lastlog.record('zoe', '10.0.0.5', 'pts/0');
      const out = exec.execute('lastlog -u 1777');
      expect(out).toMatch(/^zoe\b/m);
    });

    it('C2 -u LO-HI selects an inclusive UID range', () => {
      exec.userMgr.useradd('zoe', { u: 1200 });
      exec.userMgr.useradd('yan', { u: 2200 });
      const out = exec.execute('lastlog -u 1000-1500');
      expect(out).toMatch(/^zoe\b/m);
      expect(out).not.toMatch(/^yan\b/m);
    });

    it('C3 -u 0-999 targets the system-account range', () => {
      const out = exec.execute('lastlog -u 0-999');
      expect(out).toMatch(/^root\b/m);
    });

    it('C4 an unknown numeric UID is an error', () => {
      expect(exec.execute('lastlog -u 4242')).toMatch(/Unknown user or range: 4242/);
    });

    it('C5 a non-root user may still read lastlog', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.lastlog.record('alice', '10.0.0.5', 'pts/0');
      exec.userMgr.currentUid = 1001;
      const out = exec.execute('lastlog -u alice');
      expect(out).toMatch(/^alice\b/m);
      expect(out).not.toMatch(/must be root/);
    });

    it('C6 -C and -S are refused to non-root', () => {
      exec.userMgr.useradd('alice', { uid: 1001 });
      exec.userMgr.currentUid = 1001;
      expect(exec.execute('lastlog -C -u alice')).toMatch(/must be root/);
      expect(exec.execute('lastlog -S -u alice')).toMatch(/must be root/);
    });

    it('C7 -C/-S without -u is rejected', () => {
      exec.userMgr.currentUid = 0;
      expect(exec.execute('lastlog -C')).toMatch(/requires -u|--user/);
      expect(exec.execute('lastlog -S')).toMatch(/requires -u|--user/);
    });
  });

  // ─────────────────────── §D network / SSH ─────────────────────────
  describe('§D network / SSH login recording', () => {
    let exec2: LinuxCommandExecutor;

    function sshContext(): LinuxSshServerContext {
      return new LinuxSshServerContext(
        exec2.vfs,
        exec2.userMgr,
        'lxsrv',
        {} as unknown as ConstructorParameters<typeof LinuxSshServerContext>[3],
        exec2,
      );
    }

    beforeEach(() => {
      exec2 = new LinuxCommandExecutor(true);
      exec2.userMgr.useradd('alice', { m: true, s: '/bin/bash' });
    });

    it('D1 a real SSH recordLogin updates the lastlog registry', () => {
      sshContext().recordLogin('alice', '10.0.0.77');
      expect(exec2.lastlog.getCurrent('alice')?.sourceHost).toBe('10.0.0.77');
    });

    it('D2 the SSH login is reflected by the lastlog command', () => {
      sshContext().recordLogin('alice', '10.0.0.77');
      expect(rowFor(exec2.execute('lastlog -u alice'), 'alice')).toContain('10.0.0.77');
    });

    it('D3 a second login surfaces the previous one as the "Last login:" banner', () => {
      const reg = exec2.lastlog;
      reg.record('alice', '10.0.0.1', 'pts/0', Date.now() - 3600_000);
      reg.record('alice', '10.0.0.2', 'pts/1');
      const prev = reg.getPrevious('alice');
      expect(prev?.sourceHost).toBe('10.0.0.1');
      expect(LinuxLastlogRegistry.format(prev!)).toMatch(/^Last login: .* from 10\.0\.0\.1$/);
    });

    it('D4 the very first login has no previous banner', () => {
      exec2.lastlog.record('alice', '10.0.0.9', 'pts/0');
      expect(exec2.lastlog.getPrevious('alice')).toBeUndefined();
    });

    it('D5 the SSH source IP propagates to the on-disk projection', () => {
      sshContext().recordLogin('alice', '203.0.113.8');
      const rows = JSON.parse(exec2.vfs.readFile(LASTLOG_PATH) ?? '[]') as PersistedRow[];
      expect(rows.find(r => r.user === 'alice')?.sourceHost).toBe('203.0.113.8');
    });

    it('D6 distinct source hosts across logins keep the most recent', () => {
      const reg = exec2.lastlog;
      reg.record('alice', '10.0.0.1', 'pts/0', Date.now() - 10_000);
      reg.record('alice', '10.0.0.2', 'pts/1');
      expect(reg.getCurrent('alice')?.sourceHost).toBe('10.0.0.2');
      expect(rowFor(exec2.execute('lastlog -u alice'), 'alice')).toContain('10.0.0.2');
    });
  });
});
