/**
 * Measured against ausearch 3.1.2 with --checkpoint over a growing log (scripts/oracle/record_ausearch_checkpoint.py):
 * four scenarios, each step compares stdout, stderr, exit status and the checkpoint file (dev/inode normalised).  All four
 * fall before the port (the option did not exist).  The corrupted-checkpoint exit status 12 of the "grow" scenario is the
 * real behaviour when the last event seen is not an event that matched; it is pinned because the real tool does it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { runAusearch } from '@/network/devices/linux/audit/tools/AusearchTool';
import { hostClock } from '@/network/devices/linux/audit/tools/AuditHostClock';
import type { AuditSearchHost } from '@/network/devices/linux/audit/tools/AuditToolHost';

interface Step { log: string; args: string[]; stdout: string; stderr: string; code: number; checkpoint: string | null }
const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/ausearch-checkpoint-3.1.2.json', 'utf8')) as {
  logs: Record<string, string>; scenarios: Array<{ scenario: string; steps: Step[] }>;
};

function normalise(text: string): string {
  return text.replace(/^dev=0x[0-9A-F]+$/gm, 'dev=DEV').replace(/^inode=\d+$/gm, 'inode=INODE');
}

describe('ausearch --checkpoint against the real 3.1.2 binary', () => {
  for (const scenario of fixture.scenarios) {
    it(`replays ${scenario.scenario}`, () => {
      const files = new Map<string, string>();
      const clock = hostClock('UTC');
      const host: AuditSearchHost = {
        readFile: (path) => files.get(path) ?? null,
        isDirectory: () => false,
        userName: () => null,
        groupName: () => null,
        userUid: () => null,
        groupGid: () => null,
        deviceAndInode: (path) => (files.has(path) ? { dev: 0xfd00, ino: 4242 } : null),
        writeFile: (path, content) => { files.set(path, content); return true; },
        localTime: clock.localTime,
        mktime: clock.mktime,
        nowSec: () => 1760000000,
        uptimeSec: () => 3600,
        auditConfig: () => null,
        dateStyle: () => 'mdy2',
      };
      for (const step of scenario.steps) {
        files.set('live.log', fixture.logs[step.log]);
        const result = runAusearch(host, step.args);
        expect({ out: result.stdout, err: result.stderr, code: result.exitCode }).toEqual({ out: step.stdout, err: step.stderr, code: step.code });
        const ckName = step.args[step.args.indexOf('--checkpoint') + 1];
        const written = files.get(ckName);
        expect(written === undefined ? null : normalise(written)).toBe(step.checkpoint);
      }
    });
  }
});
