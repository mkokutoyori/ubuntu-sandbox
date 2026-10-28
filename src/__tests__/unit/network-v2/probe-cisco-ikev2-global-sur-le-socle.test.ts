/*
 * The four global IKEv2 settings (`crypto ikev2 dpd`, `nat keepalive`,
 * `cookie-challenge`, `window`) declared natively on the socle.
 *
 * Measured before the change: 7 of the 8 cases fall. All four were REST
 * places read with parseInt and an `isFinite` guard, so `dpd zorglub`,
 * `nat keepalive zorglub`, `cookie-challenge zorglub` and `window zorglub`
 * were accepted and did nothing, `window 0` was applied, and `dpd 10 3
 * zorglub` stored a mode that does not exist. The one witness (valid dpd and window)
 * passes either way. The upper bounds of these settings are NOT
 * enforced: the Cisco command reference was unreachable when this was written
 * (see TODO.md), so only the shape is.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function router(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal']) await r.executeCommand(l);
  return r;
}

const CARET = /\^\n% Invalid input detected at '\^' marker\./;

describe('global IKEv2 settings on the socle', () => {
  it('witness: a valid dpd and a valid window are accepted', async () => {
    const r = await router();
    expect(await r.executeCommand('crypto ikev2 dpd 30 5 periodic')).toBe('');
    expect(await r.executeCommand('crypto ikev2 window 50')).toBe('');
  });

  it.each([
    'crypto ikev2 dpd zorglub',
    'crypto ikev2 dpd 10 3 zorglub',
    'crypto ikev2 dpd 0 3 periodic',
    'crypto ikev2 nat keepalive zorglub',
    'crypto ikev2 cookie-challenge zorglub',
    'crypto ikev2 window zorglub',
    'crypto ikev2 window 0',
  ])('refuses `%s` at the caret', async (line) => {
    expect(await (await router()).executeCommand(line)).toMatch(CARET);
  });
});
