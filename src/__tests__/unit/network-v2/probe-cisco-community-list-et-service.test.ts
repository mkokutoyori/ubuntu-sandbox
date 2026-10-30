/*
 * `ip community-list standard|numbered` values and `service password-encryption`.
 *
 * Measured before the change: 4 of the 9 cases fall. A standard or numbered
 * community list took any word as a community value (`permit zorglub`,
 * `permit 70000:1`, a trailing word, `deny 0`). The five that pass either way:
 * four witnesses (aa:nn, well-known keywords, an expanded list holding a
 * regular expression, the bare service command) and `service password-encryption
 * zorglub`, which another layer already refused (non-regression). The accepted
 * values (aa:nn up to 65535, internet, local-AS, no-advertise, no-export,
 * gshut, a decimal 1-4294967295) are the IOS ones from memory, not from a
 * fetched page.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function inConfig(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal']) await r.executeCommand(l);
  return r;
}

const REFUSED = /Invalid input detected/;

describe('community list values and service password-encryption', () => {
  it.each([
    'ip community-list standard C permit 65000:100 no-export',
    'ip community-list 10 permit internet',
    'ip community-list expanded E permit _65000:.*_',
    'service password-encryption',
  ])('witness: `%s` is accepted', async (line) => {
    expect(await (await inConfig()).executeCommand(line)).toBe('');
  });

  it.each([
    'ip community-list standard C permit zorglub',
    'ip community-list standard C permit 70000:1',
    'ip community-list 10 permit 65000:100 zorglub',
    'ip community-list 10 deny 0',
    'service password-encryption zorglub',
  ])('`%s` is refused', async (line) => {
    expect(await (await inConfig()).executeCommand(line)).toMatch(REFUSED);
  });
});
