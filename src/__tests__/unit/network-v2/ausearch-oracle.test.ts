/**
 * Measured against ausearch 3.1.2 (Ubuntu 24.04 audit 1:3.1.2-2.1build1, built from the .deb), 1170 cases recorded by
 * scripts/oracle/record_ausearch.py on five synthetic audit.log files: every match option, message type lists, event ids,
 * time windows, uid/gid by number and by name, exit by number and errno, escape modes, --just-one, --debug, errors and
 * usage.  Before the port the module did not exist, so all 1170 cases fall; the previous cmdAusearch answered none of the
 * option grammar.  Witness: the cases with no filter-specific option that pass through the same record assembler as
 * aureport.  Time-of-day dependent cases (-te DATE, -ts TIME) are not recorded because the real tool reads the clock.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { runAusearch } from '@/network/devices/linux/audit/tools/AusearchTool';
import { hostClock } from '@/network/devices/linux/audit/tools/AuditHostClock';
import type { AuditSearchHost } from '@/network/devices/linux/audit/tools/AuditToolHost';

interface Case { log: string; args: string[]; tz?: string; stdout: string; stderr: string; code: number }
const CONFIG_NOTICE = "Config file /etc/audit/auditd.conf doesn't exist, skipping\n";
interface Fixture { logs: Record<string, string>; cases: Case[] }
const FIXTURES = ['ausearch-3.1.2.json', 'ausearch-enriched-3.1.2.json'];
let fixture!: Fixture;

function labHost(c: Case): AuditSearchHost {
  const clock = hostClock(c.tz ?? 'UTC');
  return {
    readFile: (path) => fixture.logs[path.replace(/\.log$/, '')] ?? null,
    isDirectory: () => false,
    userName: (uid) => (uid === 0 ? 'root' : null),
    groupName: (gid) => (gid === 0 ? 'root' : null),
    userUid: (name) => (name === 'root' ? 0 : null),
    protocolName: () => null,
    groupGid: (name) => (name === 'root' ? 0 : null),
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
  const got = result.stderr.replace(CONFIG_NOTICE, '');
  const want = c.stderr.replace(CONFIG_NOTICE, '');
  if (result.stdout !== c.stdout || result.exitCode !== c.code || got !== want) {
    return `${c.log} ${c.tz ?? ''} ${JSON.stringify(c.args)}: code ${result.exitCode}/${c.code}\n--- got\n${result.stdout}|${got}\n--- want\n${c.stdout}|${want}`;
  }
  return null;
}

describe.each(FIXTURES)('ausearch against the real 3.1.2 binary (%s)', (file) => {
  beforeAll(() => {
    fixture = JSON.parse(readFileSync(`src/__tests__/support/oracle/audit-tools/${file}`, 'utf8')) as Fixture;
  });

  it('replays', () => {
    const failures = fixture.cases.map(replay).filter((f): f is string => f !== null);
    expect(failures).toEqual([]);
  });
});
