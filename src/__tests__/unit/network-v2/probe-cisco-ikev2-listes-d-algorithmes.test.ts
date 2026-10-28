/*
 * The algorithm lists of an IKEv2 proposal (`encryption`, `integrity`,
 * `group`, `prf`) and the proposal list of an IKEv2 policy judge EVERY
 * item, not only the first.
 *
 * Measured before the change: 3 of the 6 cases fall. The second place of
 * each list was an untyped REST tail, so `encryption aes-cbc-256 zorglub`,
 * `group 14 zorglub` and `prf sha256 zorglub` were accepted and the stray
 * word was stored (the group list silently dropped it, the others rendered
 * it in the running-config). The other three are witnesses: a list of
 * several valid items, and the first-item refusal that already held.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function proposal(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'crypto ikev2 proposal P1']) {
    await r.executeCommand(l);
  }
  return r;
}

const CARET = /\^\n% Invalid input detected at '\^' marker\./;

describe('IKEv2 proposal algorithm lists', () => {
  it('witness: several valid items are accepted and rendered', async () => {
    const r = await proposal();
    expect(await r.executeCommand('encryption aes-cbc-256 aes-cbc-128 3des')).toBe('');
    expect(await r.executeCommand('group 14 19 20')).toBe('');
    expect(await r.executeCommand('do show running-config'))
      .toContain('encryption aes-cbc-256 aes-cbc-128 3des');
  });

  it('witness: a stray FIRST item was already refused', async () => {
    expect(await (await proposal()).executeCommand('encryption zorglub')).toMatch(CARET);
  });

  it.each([
    'encryption aes-cbc-256 zorglub',
    'group 14 zorglub',
    'prf sha256 zorglub',
  ])('refuses a stray later item in `%s`', async (line) => {
    expect(await (await proposal()).executeCommand(line)).toMatch(CARET);
  });

  it('witness: a policy lists several proposals', async () => {
    const r = await proposal();
    await r.executeCommand('exit');
    await r.executeCommand('crypto ikev2 policy POL');
    expect(await r.executeCommand('proposal P1 P2')).toBe('');
  });
});
