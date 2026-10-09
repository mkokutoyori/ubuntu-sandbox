/*
 * Oracle: ausearch 3.1.2 --format csv and --format text, with every --extra-* column option, on nine synthetic logs (the five of
 * ausearch-oracle.test.ts and the four syscall corpora of ausearch-interpret-oracle.test.ts) recorded by
 * scripts/oracle/record_ausearch_formats.py from the extracted Ubuntu 24.04 .deb, 809 cases in all.  The auparse event normalizer
 * (auparse/normalize.c) is ported with its cursor semantics, and the feed state machine that splits one ausearch event into several
 * auparse events (completion on the last record type, PROCTITLE ends an event) is ported with it.  The uid, gid and protocol databases
 * of the lab host are part of the fixture.  Measured before the port (git stash push -u -- src/network): 782 of the 809 cases fall,
 * the 27 that pass are usage and option errors that never reach the normalizer.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { runAusearch } from '@/network/devices/linux/audit/tools/AusearchTool';
import { hostClock } from '@/network/devices/linux/audit/tools/AuditHostClock';
import type { AuditSearchHost } from '@/network/devices/linux/audit/tools/AuditToolHost';

interface Case { log: string; args: string[]; tz?: string; stdout: string; stderr: string; code: number }
const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/ausearch-formats-3.1.2.json', 'utf8')) as {
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
    protocolName: (number) => protocols.get(number) ?? null,
    groupGid: (name) => groupIds.get(name) ?? null,
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
  const got = result.stderr;
  const want = c.stderr;
  if (result.stdout !== c.stdout || result.exitCode !== c.code || got !== want) {
    return `${c.log} ${c.tz ?? ''} ${JSON.stringify(c.args)}: code ${result.exitCode}/${c.code}\n--- got\n${result.stdout}|${got}\n--- want\n${c.stdout}|${want}`;
  }
  return null;
}

describe('ausearch --format csv and text against the real 3.1.2 binary', () => {
  it('replays', () => {
    const failures = fixture.cases.map(replay).filter((f): f is string => f !== null);
    expect(failures.length, `${failures.length}/${fixture.cases.length}\n${failures.slice(0, 2).join('\n=====\n')}`).toBe(0);
  });
});
