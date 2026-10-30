/*
 * `login block-for` takes its three parts and `no login block-for` removes it.
 *
 * Measured before the change: 6 of the 9 cases fall. `attempts` and `within`
 * were optional (a bare `login block-for 100` configured a block of zero
 * attempts), a trailing word was accepted, a first word that was not a number, an `attempts` that was not a number and the
 * two parts in the wrong order were not judged, and
 * `no login block-for` re-applied the command instead of removing it, so the
 * block stayed in the running-config. The three witnesses (the full form, its
 * rendering and the unrelated `login delay`) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function router(...lines: string[]): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', ...lines]) await r.executeCommand(l);
  return r;
}

const REFUSED = /Invalid input detected|Incomplete command/;

describe('login block-for', () => {
  it('witness: the full form is applied and rendered', async () => {
    const r = await router('login block-for 100 attempts 3 within 60');
    expect(await r.executeCommand('do show running-config'))
      .toContain('login block-for 100 attempts 3 within 60');
  });

  it('witness: login delay is unaffected', async () => {
    expect(await (await router()).executeCommand('login delay 5')).toBe('');
  });

  it.each([
    'login block-for 100', 'login block-for 100 attempts 3',
    'login block-for 100 attempts 3 within 60 zorglub',
    'login block-for zorglub attempts 3 within 60',
    'login block-for 100 attempts zorglub within 60',
    'login block-for 100 within 60 attempts 3',
  ])('refuses `%s`', async (line) => {
    expect(await (await router()).executeCommand(line)).toMatch(REFUSED);
  });

  it('`no login block-for` removes it', async () => {
    const r = await router('login block-for 100 attempts 3 within 60', 'no login block-for');
    expect(await r.executeCommand('do show running-config')).not.toContain('login block-for');
  });
});
