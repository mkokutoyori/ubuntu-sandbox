/**
 * Replay of 392 `chronyc` invocations recorded against a real chronyd 4.5
 * (scripts/oracle/record_chronyc.py): four chrony.conf scenarios, 98 commands
 * each, run in the recorded order on one daemon.
 *
 * Measured before the fix: see the commit message. Volatile fields (Ref time,
 * command packet counters) are masked on both sides.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { installVirtualClock } from '../../support/ntpTime';

interface Recorded { scenario: string; conf: string; args: string[]; stdout: string; stderr: string; code: number }

const recorded: Recorded[] = JSON.parse(readFileSync(
  new URL('../../support/oracle/chronyc-4.5-static.json', import.meta.url), 'utf8')).cases;

const KEYS = '1 MD5 secretsecret\n2 SHA1 HEX:0123456789abcdef0123456789abcdef01234567\n';

function mask(text: string): string {
  return text.split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .map((line) => line
      .replace(/^(Ref time \(UTC\)\s*:).*$/, '$1 MASKED')
      .replace(/^(Command packets received\s*:).*$/, '$1 MASKED')
      .replace(/^(Total TX\s*:).*$/, '$1 MASKED'))
    .join('\n').replaceAll('/tmp/ntp-debs/root/usr/bin/chronyc', 'chronyc').trimEnd();
}

async function write(pc: LinuxPC, path: string, text: string): Promise<void> {
  await pc.executeCommand(`printf '${text.replace(/\n/g, '\\n')}' | sudo tee ${path}`);
}

const scenarios = [...new Set(recorded.map((r) => r.scenario))];

describe('chronyc matches the recorded chronyc 4.5', () => {
  for (const scenario of scenarios) {
    describe(scenario, () => {
      const cases = recorded.filter((r) => r.scenario === scenario);
      const outputs: string[] = [];
      beforeAll(async () => {
        const clock = installVirtualClock();
        const pc = new LinuxPC(`chronyc-${scenario}`);
        await write(pc, '/etc/chrony/chrony.keys', KEYS);
        await write(pc, '/etc/chrony/chrony.conf',
          cases[0].conf.replace(/%RUN%/g, '/etc/chrony').replace('/etc/chrony/keys', '/etc/chrony/chrony.keys'));
        await pc.executeCommand('sudo systemctl restart chrony');
        for (const c of cases) {
          if (c.args[0] === 'waitsync' && c.stderr === 'TIMEOUT') { clock.advance(15000); outputs.push(''); continue; }
          outputs.push(await pc.executeCommand(`sudo chronyc ${c.args.join(' ')}`));
        }
      });
      cases.forEach((c, index) => {
        if (c.args[0] === 'waitsync' && c.stderr === 'TIMEOUT') return;
        it(`chronyc ${c.args.join(' ')} #${index}`, () => {
          expect(mask(outputs[index])).toBe(mask(`${c.stdout}${c.stderr}`));
        });
      });
    });
  }
});
