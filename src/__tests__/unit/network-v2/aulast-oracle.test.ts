/*
 * Oracle: aulast and aulastlog 3.1.2 (Ubuntu 24.04 audit 1:3.1.2 binaries).  scripts/oracle/record_aulast.py runs both tools on six
 * synthetic login logs (full sessions, failed logins, sessions without login or logout, reboots, crashes, duplicate session ids, kernel
 * 3.13 style LOGIN records, truncated records, junk lines) through -f FILE, --stdin and the AUSOURCE_LOGS path (auditd.conf pointing at
 * a three-file rotated set), with every option, in two time zones, plus argument errors and the no-log case.  stdout, stderr, exit
 * status and the aulast.log written by --extract are compared.  aulastlog enumerates the passwd database of the lab host, which is part
 * of the fixture.  Measured before the port (modules absent, git stash push -u -- src/network): every case falls.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { runAulast } from '@/network/devices/linux/audit/tools/AulastTool';
import { runAulastlog } from '@/network/devices/linux/audit/tools/AulastlogTool';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { hostClock } from '@/network/devices/linux/audit/tools/AuditHostClock';
import type { AuditLoginHost } from '@/network/devices/linux/audit/tools/AuditLoginHost';

interface Case { tool: string; args: string[]; log: string | null; source: string; stdout: string; stderr: string; code: number; tz: string; extracted?: string; files?: Record<string, string> }
const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/aulast-3.1.2.json', 'utf8')) as { logs: Record<string, string>; hostdb: { passwd: string }; cases: Case[] };

const accounts = fixture.hostdb.passwd.split('\n').map((line) => line.split(':')).filter((fields) => fields.length > 2).map((fields) => ({ name: fields[0], uid: Number(fields[2]) }));
const BASE = '/tmp/aulast-oracle-set';

function hostFor(c: Case, written: Map<string, string>): AuditLoginHost {
  const clock = hostClock(c.tz);
  const files = new Map<string, string>();
  if (c.source === 'file' && c.log !== null) for (const [index, value] of c.args.entries()) if (c.args[index - 1] === '-f') files.set(value, fixture.logs[c.log]);
  if (c.source === 'logs') for (const [name, text] of Object.entries(c.files ?? {})) files.set(`${BASE}/${name}`, text);
  const config = c.source === 'no-config-no-log' ? null : { logFile: c.source === 'logs' ? `${BASE}/audit.log` : '/tmp/audit-oracle/log/audit.log', eoeTimeout: 2 };
  return {
    readFile: (path) => files.get(path) ?? null,
    isDirectory: () => false,
    userName: (uid) => accounts.find((entry) => entry.uid === uid)?.name ?? null,
    groupName: () => null,
    localTime: clock.localTime,
    mktime: clock.mktime,
    nowSec: () => 1760000000,
    uptimeSec: () => 3600,
    auditConfig: () => config,
    dateStyle: () => 'mdy2',
    protocolName: () => null,
    userUid: (name) => accounts.find((entry) => entry.name === name)?.uid ?? null,
    groupGid: () => null,
    deviceAndInode: () => null,
    writeFile: (path, content) => { written.set(path, content); return true; },
    uid: () => 0,
    passwdEntries: () => accounts,
  };
}

function inputFor(c: Case): { args: string[]; stdin: string | null } {
  if (c.source === 'file') return { args: c.args, stdin: null };
  if (c.source === 'stdin') return { args: c.args, stdin: c.log === null ? '' : fixture.logs[c.log] };
  return { args: c.args, stdin: c.tool === 'aulastlog' && c.source === 'args' ? '' : null };
}

describe('aulast and aulastlog against the real 3.1.2 binaries', () => {
  it('replays every recorded invocation', () => {
    const failures: string[] = [];
    for (const c of fixture.cases) {
      const written = new Map<string, string>();
      const host = hostFor(c, written);
      const { args, stdin } = inputFor(c);
      const result = c.tool === 'aulast' ? runAulast(host, args, stdin) : runAulastlog(host, args, stdin);
      const extractedOk = c.extracted === undefined || written.get('aulast.log') === c.extracted;
      if (result.stdout !== c.stdout || result.stderr !== c.stderr || result.exitCode !== c.code || !extractedOk) {
        const got = `${result.stdout}|${result.stderr}|${result.exitCode}`.split('\n');
        const want = `${c.stdout}|${c.stderr}|${c.code}`.split('\n');
        let at = 0;
        while (at < Math.max(got.length, want.length) && got[at] === want[at]) at++;
        failures.push(`${c.tool} ${c.source} ${c.log} ${JSON.stringify(c.args.filter((a) => !a.startsWith('/tmp')))} tz=${c.tz} line ${at}\n got: ${got[at]}\nwant: ${want[at]}`);
      }
    }
    expect(failures.length, `${failures.length}/${fixture.cases.length}\n${failures.slice(0, 14).join('\n=====\n')}`).toBe(0);
    expect(fixture.cases.length).toBeGreaterThan(200);
  });

  it('WITNESS -- both commands are reachable from the host shell and read the audit log of the machine', async () => {
    const server = new LinuxServer('linux-server', 'S1');
    await server.executeCommand(`printf "%s\\n" "type=USER_LOGIN msg=audit(1760000000.000:10): pid=5 uid=0 auid=0 ses=1 msg='op=login id=0 hostname=10.1.1.1 addr=10.1.1.1 terminal=/dev/pts/0 res=success'" > /tmp/one.log`);
    expect(await server.executeCommand('aulastlog --stdin --user root < /tmp/one.log')).toMatch(/root +\/dev\/pts\/0 +10\.1\.1\.1 +10\/09\/25 08:53:20/);
    expect(await server.executeCommand('aulast -f /tmp/one.log')).toBe('');
    expect(await server.executeCommand('aulast -f /no/such/file')).toContain('Error - No such file or directory');
  });
});
