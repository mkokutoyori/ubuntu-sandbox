import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';

interface Fixture {
  readonly cases: ReadonlyArray<{ readonly group: string; readonly command: string; readonly stdout: string }>;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/bash-language-bash.json', import.meta.url), 'utf8')) as Fixture;

const PRELUDE = 'exec 2>/dev/null; rm -rf /tmp/w; mkdir -p /tmp/w; cd /tmp/w; ';

describe('bash language against the recorded bash', () => {
  for (const [index, recorded] of fixture.cases.entries()) {
    it(`#${index} ${recorded.group}: ${recorded.command}`, async () => {
      const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
      pc.powerOn();
      expect(await pc.executeCommand(PRELUDE + recorded.command)).toBe(recorded.stdout.replace(/\n$/, ''));
    });
  }
});
