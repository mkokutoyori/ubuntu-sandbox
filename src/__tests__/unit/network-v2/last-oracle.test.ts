/*
 * Oracle: last and lastb 2.39.3 (util-linux, Ubuntu 24.04 binaries) run over generated binary utmp files
 * (scripts/oracle/record_last.py; time, boot time, getpwnam, /proc/PID/loginuid and the /dev line owner are
 * pinned by scripts/oracle/last_shim.c).  260 scenarios, 14 invocations each (3640), compared on stdout,
 * stderr and exit status with runLast over the same bytes.  Measured before the port (module absent,
 * git stash push -u -- src/network): every invocation falls.  The invocations that print only an error or the
 * usage text pass whatever the file holds; they are kept because the argument handling is the point.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { runLast, type LastFile, type LastHost } from '@/network/devices/linux/login/LastTool';
import { hostClock } from '@/network/devices/linux/audit/tools/AuditHostClock';

interface Run { argv: string[]; stdout: string; stderr: string; code: number }
interface Scenario {
  program: 'last' | 'lastb';
  env: { TZ: string; now: number; boot: number; users: Record<string, number>; loginuids: Record<string, number | string>; ttyowners: Record<string, number> };
  ctime: number;
  data: string;
  runs: Run[];
}

const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/last-2.39.3.json', 'utf8')) as { scenarios: Scenario[] };

function hostFor(scenario: Scenario): LastHost {
  const bytes = Uint8Array.from(Buffer.from(scenario.data, 'base64'));
  const dataPath = `/data/${scenario.program === 'lastb' ? 'btmp' : 'wtmp'}`;
  return {
    openFile: (path): LastFile => (path === dataPath
      ? { kind: 'file', bytes, ctime: scenario.ctime }
      : { kind: 'error', message: 'No such file or directory' }),
    nowSec: () => scenario.env.now,
    bootTimeSec: () => scenario.env.boot,
    clock: hostClock(scenario.env.TZ),
    userExists: (name) => (name in scenario.env.users ? { uid: scenario.env.users[name] } : null),
    loginUid: (pid) => {
      const entry = scenario.env.loginuids[String(pid)];
      if (entry === undefined) return undefined;
      return typeof entry === 'number' ? entry : null;
    },
    deviceOwner: (line) => scenario.env.ttyowners[line] ?? null,
    reverseName: () => null,
    utf8: () => false,
  };
}

describe('last 2.39.3 oracle', () => {
  it('replays every recorded invocation byte for byte', () => {
    const failures: string[] = [];
    let total = 0;
    fixture.scenarios.forEach((scenario, index) => {
      const host = hostFor(scenario);
      for (const run of scenario.runs) {
        total++;
        const result = runLast(host, run.argv, scenario.program);
        if (result.stdout !== run.stdout || result.stderr !== run.stderr || result.exitCode !== run.code) {
          failures.push(`#${index} ${scenario.program} ${JSON.stringify(run.argv)}\n got ${JSON.stringify([result.stdout, result.stderr, result.exitCode])}\nwant ${JSON.stringify([run.stdout, run.stderr, run.code])}`);
        }
      }
    });
    expect(failures.length, failures.slice(0, 3).join('\n')).toBe(0);
    expect(total).toBe(3640);
  });
});
