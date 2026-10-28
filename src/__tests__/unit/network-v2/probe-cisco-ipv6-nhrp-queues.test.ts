/*
 * `ipv6 address <prefix>/<len>` and `ip nhrp network-id|holdtime` tails.
 *
 * Measured before the change: 9 of the 13 cases fall. `ipv6 address
 * 2001:db8::1/64 zorglub` and `eui-64 zorglub` were accepted and the tail
 * dropped, a prefix length above 128 or with trailing junk (`64abc`) was
 * accepted, and `ip nhrp network-id zorglub` / `0` / `holdtime zorglub` were
 * stored as NaN or out of range. The four witnesses (the valid forms) pass
 * either way. Bounds network-id 1-4294967295 and holdtime 1-65535 are the
 * IOS ones, written from memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function onInterface(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'interface GigabitEthernet0/0']) {
    await r.executeCommand(l);
  }
  return r;
}

const REFUSED = /Invalid input detected/;

describe('ipv6 address and ip nhrp tails', () => {
  it.each([
    'ipv6 address 2001:db8::/64 eui-64', 'ipv6 address 2001:db8::1/64',
    'ip nhrp network-id 10', 'ip nhrp holdtime 600',
  ])('witness: `%s` is accepted', async (line) => {
    expect(await (await onInterface()).executeCommand(line)).toBe('');
  });

  it.each([
    'ipv6 address 2001:db8::1/64 zorglub', 'ipv6 address 2001:db8::/64 eui-64 zorglub',
    'ipv6 address 2001:db8::1/129', 'ipv6 address 2001:db8::1/64abc',
    'ip nhrp network-id zorglub', 'ip nhrp network-id 0', 'ip nhrp network-id 10 zorglub',
    'ip nhrp holdtime zorglub', 'ip nhrp holdtime 70000',
  ])('`%s` is refused', async (line) => {
    expect(await (await onInterface()).executeCommand(line)).toMatch(REFUSED);
  });
});
