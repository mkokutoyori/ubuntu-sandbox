/*
 * Oracle: ausyscall 3.1.2 (Ubuntu 24.04 audit 1:3.1.2 binary).  scripts/oracle/record_ausyscall.py runs the real tool on every
 * architecture token (names, aliases, b32/b64, hexadecimal ELF machine numbers, deprecated and unknown ones), on names, numbers, --exact
 * and --dump, in both argument orders, plus argument-count and conflict errors: 1632 invocations compared on stdout, stderr and status.
 * Dumps are compared by digest and line count.  Measured before the port (module absent, git stash push -u -- src/network): every
 * invocation falls.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { runAusyscall } from '@/network/devices/linux/audit/tools/AusyscallTool';

interface Case { args: string[]; stdout?: string; stderr: string; code: number; stdout_sha256?: string; stdout_lines?: number; stdout_head?: string }
const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/ausyscall-3.1.2.json', 'utf8')) as { machine: string; cases: Case[] };

describe('ausyscall against the real 3.1.2 binary', () => {
  it('replays every recorded invocation', () => {
    const failures: string[] = [];
    for (const c of fixture.cases) {
      const result = runAusyscall({ machine: () => fixture.machine }, c.args);
      let same = result.stderr === c.stderr && result.exitCode === c.code;
      if (c.stdout_sha256 !== undefined) same = same && createHash('sha256').update(result.stdout).digest('hex') === c.stdout_sha256 && result.stdout.split('\n').length - 1 === c.stdout_lines;
      else same = same && result.stdout === c.stdout;
      if (!same) failures.push(`${JSON.stringify(c.args)}: got ${JSON.stringify([result.stdout.slice(0, 80), result.stderr, result.exitCode])} want ${JSON.stringify([c.stdout ?? c.stdout_head, c.stderr, c.code])}`);
    }
    expect(failures.length, failures.slice(0, 6).join('\n')).toBe(0);
    expect(fixture.cases.length).toBeGreaterThan(1500);
  });

  it('WITNESS -- the command is reachable from the host shell and answers like the tool', async () => {
    const server = new LinuxServer('linux-server', 'S1');
    expect((await server.executeCommand('ausyscall arm 5')).trim()).toBe('open');
    expect((await server.executeCommand('ausyscall --exact OPENAT')).trim()).toBe('257');
  });
});
