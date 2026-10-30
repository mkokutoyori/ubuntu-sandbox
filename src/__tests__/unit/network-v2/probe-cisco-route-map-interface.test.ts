/*
 * `match interface`, `set interface` and `set default interface` in a
 * route-map clause took any word as an interface name.
 *
 * Measured before the change: 4 of the 8 cases fall (`match interface
 * zorglub`, `set interface zorglub`, `set default interface zorglub`, and
 * `match interface Gi0/0 zorglub`). The four witnesses (valid names, one or
 * several) pass either way. The interface-name shape is the one the socle's
 * INTERFACE type already uses; the router-process judge duplicated it and now
 * imports it.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function inRouteMap(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'route-map RM permit 10']) {
    await r.executeCommand(l);
  }
  return r;
}

describe('route-map interface clauses', () => {
  it.each([
    'match interface GigabitEthernet0/0', 'match interface Gi0/0 Gi0/1',
    'set interface Null0', 'set default interface Loopback0',
  ])('witness: `%s` is accepted', async (line) => {
    expect(await (await inRouteMap()).executeCommand(line)).toBe('');
  });

  it.each([
    'match interface zorglub', 'match interface Gi0/0 zorglub',
    'set interface zorglub', 'set default interface zorglub',
  ])('`%s` is refused', async (line) => {
    expect(await (await inRouteMap()).executeCommand(line)).toMatch(/Invalid input detected/);
  });
});
