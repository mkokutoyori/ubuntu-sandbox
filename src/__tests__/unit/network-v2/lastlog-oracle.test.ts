/*
 * Oracle: lastlog from shadow 4.13 (package login of Ubuntu 24.04, binary /usr/bin/lastlog) run over generated lastlog
 * files (scripts/oracle/record_lastlog.py; time, the passwd database, the lastlog path and login.defs are pinned by
 * scripts/oracle/last_shim.c).  220 scenarios, 14 invocations each (3080), compared on stdout, stderr, exit status and
 * the sha256/size of the file after -C / -S, with runLastlog over the same bytes.  Measured before the port (module
 * absent, git stash push -u -- src/network): every invocation falls.  Invocations that only print usage or an error
 * pass whatever the file holds; they are kept because option handling is part of the tool.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { runLastlog, type LastlogHost } from '@/network/devices/linux/login/LastlogTool';
import { hostClock } from '@/network/devices/linux/audit/tools/AuditHostClock';

interface Run { argv: string[]; stdout: string; stderr: string; code: number; after: string; afterSize: number }
interface Scenario {
  zone: string;
  now: number;
  users: Array<[string, number]>;
  defs: string | null;
  size: number;
  records: Array<[number, string]>;
  readonly: boolean;
  runs: Run[];
}

const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/lastlog-4.13.json', 'utf8')) as { scenarios: Scenario[] };

function original(scenario: Scenario): Uint8Array {
  const bytes = new Uint8Array(scenario.size);
  for (const [uid, encoded] of scenario.records) bytes.set(Buffer.from(encoded, 'base64'), uid * 292);
  return bytes;
}

describe('lastlog 4.13 oracle', () => {
  it('replays every recorded invocation byte for byte', () => {
    const failures: string[] = [];
    let total = 0;
    fixture.scenarios.forEach((scenario, index) => {
      for (const run of scenario.runs) {
        total++;
        let current = original(scenario);
        const host: LastlogHost = {
          nowSec: () => scenario.now,
          clock: hostClock(scenario.zone),
          passwd: () => scenario.users.map(([name, uid]) => ({ name, uid })),
          loginDefs: () => scenario.defs,
          openLastlog: () => ({ kind: 'file', bytes: current }),
          writeLastlog: (bytes) => { current = bytes; return true; },
          changeRoot: () => 'unable to chroot',
          directoryExists: () => false,
        };
        const result = runLastlog(host, run.argv);
        const digest = createHash('sha256').update(current).digest('hex');
        if (result.stdout !== run.stdout || result.stderr !== run.stderr || result.exitCode !== run.code || digest !== run.after || current.length !== run.afterSize) {
          failures.push(`#${index} ${JSON.stringify(run.argv)}\n got ${JSON.stringify([result.stdout, result.stderr, result.exitCode, current.length])}\nwant ${JSON.stringify([run.stdout, run.stderr, run.code, run.afterSize])}`);
        }
      }
    });
    expect(failures.length, failures.slice(0, 3).join('\n')).toBe(0);
    expect(total).toBe(3080);
  });
});
