/**
 * Measured against ausearch 3.1.2 -i / --format interpret (scripts/oracle/record_ausearch_interpret.py): 386 cases on
 * nine logs, among them three generated syscall corpora (audit_log_gen.gen_syscalls) that exercise every argument
 * interpreter of auparse/interpret.c, sockaddr families, modes, capabilities, signals, errno names, tty data, proctitle,
 * escape modes and the keys separator.  The uid, gid and protocol databases of the lab host are part of the fixture.
 * Before the port the module did not interpret anything: all 386 fall.  The ax25 sockaddr case pins the real
 * truncation of the output at the first NUL byte of the callsign.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { runAusearch } from '@/network/devices/linux/audit/tools/AusearchTool';
import { hostClock } from '@/network/devices/linux/audit/tools/AuditHostClock';
import type { AuditSearchHost } from '@/network/devices/linux/audit/tools/AuditToolHost';

interface Case { log: string; args: string[]; tz?: string; stdout: string; stderr: string; code: number }
const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/ausearch-interpret-3.1.2.json', 'utf8')) as {
  logs: Record<string, string>; cases: Case[]; hostdb: { passwd: string; group: string; protocols: string };
};

const users = new Map<number, string>();
const userIds = new Map<string, number>();
for (const line of fixture.hostdb.passwd.split('\n')) {
  const f = line.split(':');
  if (f.length > 2) { if (!users.has(Number(f[2]))) users.set(Number(f[2]), f[0]); userIds.set(f[0], Number(f[2])); }
}
const groups = new Map<number, string>();
const groupIds = new Map<string, number>();
for (const line of fixture.hostdb.group.split('\n')) {
  const f = line.split(':');
  if (f.length > 2) { if (!groups.has(Number(f[2]))) groups.set(Number(f[2]), f[0]); groupIds.set(f[0], Number(f[2])); }
}
const protocols = new Map<number, string>();
for (const line of fixture.hostdb.protocols.split('\n')) {
  const f = line.replace(/#.*/, '').trim().split(/\s+/);
  if (f.length >= 2 && /^\d+$/.test(f[1]) && !protocols.has(Number(f[1]))) protocols.set(Number(f[1]), f[0]);
}

function labHost(c: Case): AuditSearchHost {
  const clock = hostClock(c.tz ?? 'UTC');
  return {
    readFile: (path) => fixture.logs[path.replace(/\.log$/, '')] ?? null,
    isDirectory: () => false,
    userName: (uid) => users.get(uid) ?? null,
    groupName: (gid) => groups.get(gid) ?? null,
    userUid: (name) => userIds.get(name) ?? null,
    groupGid: (name) => groupIds.get(name) ?? null,
    protocolName: (number) => protocols.get(number) ?? null,
    deviceAndInode: () => null,
    writeFile: () => false,
    localTime: clock.localTime,
    mktime: clock.mktime,
    nowSec: () => 1760000000,
    uptimeSec: () => 3600,
    auditConfig: () => null,
    dateStyle: () => 'mdy2',
  };
}

function replay(c: Case): string | null {
  const result = runAusearch(labHost(c), c.args);
  if (result.stdout !== c.stdout || result.exitCode !== c.code || result.stderr !== c.stderr) {
    const a = result.stdout.split('\n');
    const b = c.stdout.split('\n');
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return `${c.log} ${c.tz ?? ''} ${JSON.stringify(c.args)}: code ${result.exitCode}/${c.code}\n--- got line ${i}\n${a[i]}\n--- want\n${b[i]}\n`;
  }
  return null;
}

describe('ausearch -i against the real 3.1.2 binary', () => {
  it('replays', () => {
    const failures = fixture.cases.map(replay).filter((f): f is string => f !== null);
    writeFileSync('/tmp/claude-0/scratch/ausearch-interpret-failures.txt', `${failures.length}/${fixture.cases.length}\n` + failures.join('\n=====\n'));
    expect(failures.length).toBe(0);
  });
});
