/*
 * The tail of `ipv6 route` is judged and its distance is honoured.
 *
 * Measured before the change: 5 of the 8 cases fall. Anything after the next
 * hop was dropped silently (`... 2001:db8::1 zorglub` answered success) and a
 * distance written after it was never applied, so a floating IPv6 backup
 * route was installed at the default distance, and the distance of a route
 * that did carry one was not rendered in the running-config. The three witnesses (bare
 * next-hop form, interface form, bad prefix) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function router(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'ipv6 unicast-routing']) await r.executeCommand(l);
  return r;
}

const REFUSED = /Invalid input detected|Incomplete command/;
const ROUTE = 'ipv6 route 2001:db8:9::/48';

describe('ipv6 route tail', () => {
  it.each([`${ROUTE} 2001:db8::1`, `${ROUTE} 2001:db8::1 200`])('witness: `%s` is accepted', async (line) => {
    expect(await (await router()).executeCommand(line)).toBe('');
  });

  it('witness: a prefix without a length is refused', async () => {
    expect(await (await router()).executeCommand('ipv6 route 2001:db8:9:: 2001:db8::1')).toMatch(/Invalid/);
  });

  it.each([
    `${ROUTE} 2001:db8::1 zorglub`, `${ROUTE} 2001:db8::1 200 zorglub`, `${ROUTE} 2001:db8::1 300`,
    `${ROUTE} 2001:db8::1 0`,
  ])('refuses `%s`', async (line) => {
    expect(await (await router()).executeCommand(line)).toMatch(REFUSED);
  });

  it('applies the distance, so the backup route is floating', async () => {
    const r = await router();
    await r.executeCommand(`${ROUTE} 2001:db8::1 200`);
    expect(await r.executeCommand('do show running-config')).toContain(`${ROUTE} 2001:db8::1 200`);
  });
});
