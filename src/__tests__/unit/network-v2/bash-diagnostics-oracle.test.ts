/**
 * Diagnostics fidelity against a recorded GNU bash 5.2 (scripts/oracle/record_bash_diagnostics.py).
 *
 * Each of the 104 scripts is saved as s.sh and run as `bash s.sh 2>&1`, so the expected text carries the script name and the line number
 * real bash puts in front of every diagnostic, the wording of its syntax errors, and which commands keep running after an error.
 *
 * Measured before the change: 79 of 104 fail (command-not-found, redirection and expansion errors had no `s.sh: line N:` prefix;
 * arithmetic, bad-substitution and readonly errors ended the whole script instead of the current line; syntax errors were reported as
 * `Parse error at line L:C` and nothing before the faulty line ran; break/continue/return outside their context leaked a signal;
 * `exit 3 4` / `exit abc`, `wait PID`, `[ 1 -eq ]`, here-documents closed by end of file, caller/BASH_LINENO/BASH_SOURCE, cp/mv/sort
 * on a missing operand all differed). The 25 that already passed are the witnesses that the lab and its prelude are sound
 * (successful commands, `cat`/`ls` errors, ERR/EXIT traps, set -e).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';

interface Fixture {
  readonly cases: ReadonlyArray<{ readonly script: string; readonly output: string }>;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/bash-diagnostics-bash.json', import.meta.url), 'utf8')) as Fixture;

describe('bash diagnostics against the recorded bash', () => {
  for (const [index, recorded] of fixture.cases.entries()) {
    it(`#${index} ${recorded.script.slice(0, 80).replace(/\n/g, '\\n')}`, async () => {
      const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
      pc.powerOn();
      await pc.executeCommand('rm -rf /tmp/w; mkdir -p /tmp/w; cd /tmp/w; touch noexec');
      await pc.executeCommand(`cd /tmp/w; cat > s.sh <<'SCRIPT_EOF'\n${recorded.script}\nSCRIPT_EOF`);
      expect(await pc.executeCommand('cd /tmp/w; bash s.sh 2>&1')).toBe(recorded.output.replace(/\n$/, ''));
    });
  }
});
