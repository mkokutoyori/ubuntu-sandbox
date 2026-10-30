import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { runAureport } from '@/network/devices/linux/audit/tools/AureportTool';
import { hostClock } from '@/network/devices/linux/audit/tools/AuditHostClock';
import type { AuditToolHost } from '@/network/devices/linux/audit/tools/AuditToolHost';

interface Case { log: string; args: string[]; tz?: string; stdout: string; stderr: string; code: number }
interface Fixture { logs: Record<string, string>; cases: Case[] }
const FIXTURES = ['aureport-3.1.2.json', 'aureport-enriched-3.1.2.json'];
let fixture!: Fixture;

function labHost(c: Case): AuditToolHost {
  const clock = hostClock(c.tz ?? 'UTC');
  return {
    readFile: (path) => fixture.logs[path.replace(/\.log$/, '')] ?? null,
    isDirectory: () => false,
    userName: (uid) => (uid === 0 ? 'root' : null),
    groupName: (gid) => (gid === 0 ? 'root' : null),
    localTime: clock.localTime,
    mktime: clock.mktime,
    nowSec: () => 1760000000,
    uptimeSec: () => 3600,
    auditConfig: () => null,
    dateStyle: () => 'mdy2',
  };
}

function replay(c: Case): string | null {
  const result = runAureport(labHost(c), [...c.args, '-if', `${c.log}.log`]);
  const stderr = result.stderr.replace("Config file /etc/audit/auditd.conf doesn't exist, skipping\n", '');
  const want = c.stderr.replace("Config file /etc/audit/auditd.conf doesn't exist, skipping\n", '');
  if (result.stdout !== c.stdout || result.exitCode !== c.code || stderr !== want) {
    return `${c.log} ${c.tz ?? ''} ${JSON.stringify(c.args)}: code ${result.exitCode}/${c.code}\n--- got\n${result.stdout}\n--- want\n${c.stdout}\n${stderr}|${want}`;
  }
  return null;
}

describe.each(FIXTURES)('aureport against the real 3.1.2 binary (%s)', (file) => {
  beforeAll(() => {
    fixture = JSON.parse(readFileSync(`src/__tests__/support/oracle/audit-tools/${file}`, 'utf8')) as Fixture;
  });

  it('replays', () => {
    const failures = fixture.cases.map(replay).filter((f): f is string => f !== null);
    expect(failures).toEqual([]);
  });
});
